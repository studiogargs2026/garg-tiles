const { supabaseUrl, supabaseKey } = window.GARG_CONFIG;
if (!window.supabase) {
  document.querySelector('main').innerHTML =
    '<p class="error">The app could not load. Check the internet connection, then close and reopen the app.</p>';
  throw new Error('supabase-js did not load');
}
const db = supabase.createClient(supabaseUrl, supabaseKey);
const $ = (id) => document.getElementById(id);
const views = ['login-view', 'search-view', 'tile-view', 'admin-view'];
let isAdmin = false;
let lastResults = [];
let costPin = null;          // remembered until the app is closed, so the PIN is typed once
let shownTile = null;

function show(view) {
  views.forEach((v) => ($(v).hidden = v !== view));
  window.scrollTo(0, 0);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function rupees(n) {
  return n == null ? 'Price not in list' : '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

// Pictures are in a private bucket, so each needs a short-lived signed link.
async function signedUrls(paths) {
  const wanted = paths.filter(Boolean);
  if (!wanted.length) return {};
  const { data } = await db.storage.from('tiles').createSignedUrls(wanted, 3600);
  return Object.fromEntries((data || []).filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
}

async function startSession(session) {
  $('logout').hidden = !session;
  $('admin').hidden = true;
  if (!session) return show('login-view');
  show('search-view');      // never wait on the network before showing the app
  const { data } = await db.rpc('is_admin');
  isAdmin = data === true;
  $('admin').hidden = !isAdmin;
}

let signingUp = false;

$('toggle-signup').addEventListener('click', () => {
  signingUp = !signingUp;
  $('login-view').querySelector('h1').textContent = signingUp ? 'Create your password' : 'Sign in';
  $('login-btn').textContent = signingUp ? 'Create account' : 'Sign in';
  $('toggle-signup').textContent = signingUp ? 'Already have a password? Sign in' : 'First time here? Create your password';
  $('login-form').password.autocomplete = signingUp ? 'new-password' : 'current-password';
});

function loginError(text) {
  $('login-error').textContent = text;
  $('login-error').hidden = !text;
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = e.target.email.value.trim().toLowerCase();
  const password = e.target.password.value;
  loginError('');
  if (signingUp) {
    const res = await fetch(`${supabaseUrl}/functions/v1/signup`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
    }).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : { error: 'No internet connection.' };
    if (!res?.ok) return loginError(body.error || 'Could not create the account.');
  }
  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) loginError('Wrong email or password.');
});

$('logout').addEventListener('click', () => db.auth.signOut());

$('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const words = $('q').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return;
  $('status').textContent = 'Searching…';
  let query = db.from('tiles').select('id, brand, name, catalog, thumb_path').order('name').limit(60);
  words.forEach((w) => (query = query.ilike('search_text', `%${w}%`)));
  const { data, error } = await query;
  if (error) return ($('status').textContent = 'Could not search. Check your internet and try again.');
  lastResults = data;
  $('status').textContent = data.length ? `${data.length} tile${data.length > 1 ? 's' : ''} found` : 'No tiles found. Try fewer words.';
  const urls = await signedUrls(data.map((t) => t.thumb_path));
  $('results').innerHTML = data.map((t) => `
    <li class="card"><button data-id="${t.id}">
      ${urls[t.thumb_path] ? `<img src="${urls[t.thumb_path]}" alt="" loading="lazy">` : '<div class="thumb-empty"></div>'}
      <div class="info"><div class="name">${esc(t.name)}</div><div class="muted">${esc(t.brand)}</div></div>
    </button></li>`).join('');
});

$('results').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-id]');
  if (btn) openTile(Number(btn.dataset.id));
});

$('back').addEventListener('click', () => show('search-view'));

async function openTile(id) {
  const tile = lastResults.find((t) => t.id === id);
  $('tile').innerHTML = '<p class="muted">Loading…</p>';
  show('tile-view');
  const [{ data: full }, { data: offers }] = await Promise.all([
    db.from('tiles').select('*').eq('id', id).single(),
    db.from('offers').select('*').eq('tile_id', id).order('size'),
  ]);
  shownTile = { full, offers: offers || [] };
  const costs = isAdmin || costPin ? await lookupCosts(offers || []) : null;
  const urls = await signedUrls([full.image_path]);
  $('tile').innerHTML = `
    ${urls[full.image_path] ? `<img class="hero" src="${urls[full.image_path]}" alt="${esc(full.name)}">` : ''}
    <h1>${esc(full.name)}</h1>
    <p class="muted">${esc(full.brand)}${full.catalog ? ' · ' + esc(full.catalog) : ''}</p>
    ${(offers || []).map((o) => offerHtml(o, costs?.[o.id])).join('') || '<p>No sizes listed yet.</p>'}
    ${!costs && offers?.length ? '<button id="show-cost" class="link">Show cost price</button><p id="cost-error" class="error" hidden></p>' : ''}
    ${full.notes ? `<p class="muted">${esc(full.notes)}</p>` : ''}`;
  if (!tile) lastResults.push(full);
}

function offerHtml(o, cost) {
  const per = o.unit === 'box' ? 'per box' : 'per sq ft';
  return `<div class="offer">
    <h3>${esc(o.size)}${o.finish ? ' · ' + esc(o.finish) : ''}</h3>
    <div class="muted">Selling price</div>
    <div class="price">${rupees(o.selling_price)} <span class="muted">${per}</span></div>
    ${cost !== undefined ? `<div class="cost">Cost: ${rupees(cost)} ${per}</div>` : ''}
    <dl>
      ${o.packing ? `<dt>Packing</dt><dd>${esc(o.packing)}</dd>` : ''}
      ${o.thickness_mm ? `<dt>Thickness</dt><dd>${esc(o.thickness_mm)} mm</dd>` : ''}
      ${o.weight_kg ? `<dt>Weight</dt><dd>${esc(o.weight_kg)} kg per box</dd>` : ''}
      ${o.series ? `<dt>Series</dt><dd>${esc(o.series)}</dd>` : ''}
      ${o.note ? `<dt>Note</dt><dd>${esc(o.note)}</dd>` : ''}
    </dl>
  </div>`;
}

// Returns {offerId: cost} or null; non-admins need the PIN.
async function lookupCosts(offers) {
  if (!offers.length) return {};
  const { data, error } = await db.rpc('cost_lookup', { offer_ids: offers.map((o) => o.id), pin: costPin });
  if (error || data.error) {
    costPin = null;
    lastCostError = error ? 'Could not load cost price.' : data.error;
    return null;
  }
  return data.costs;
}
let lastCostError = '';

$('tile').addEventListener('click', async (e) => {
  if (e.target.id !== 'show-cost') return;
  const pin = prompt('Enter the cost price PIN');
  if (!pin) return;
  costPin = pin.trim();
  const costs = await lookupCosts(shownTile.offers);
  if (!costs) {
    $('cost-error').textContent = lastCostError;
    $('cost-error').hidden = false;
    return;
  }
  openTile(shownTile.full.id);
});

$('admin').addEventListener('click', async () => {
  show('admin-view');
  loadStaff();
  const { data: locked } = await db.from('pin_attempts').select('user_id, failed').eq('locked', true);
  const ids = (locked || []).map((l) => l.user_id);
  const { data: people } = ids.length ? await db.from('profiles').select('id, full_name').in('id', ids) : { data: [] };
  const names = Object.fromEntries((people || []).map((p) => [p.id, p.full_name || 'Unnamed']));
  $('locked-list').innerHTML = ids.length
    ? ids.map((id) => `<li>${esc(names[id] || id)} <button class="link" data-unlock="${id}">Unlock</button></li>`).join('')
    : '<li class="muted">Nobody is locked out.</li>';
});

async function loadStaff() {
  const { data } = await db.from('allowed_emails').select('*').order('full_name');
  $('staff-list').innerHTML = (data || []).map((p) => `<li>${esc(p.full_name || '')} · ${esc(p.email)} · ${p.role === 'admin' ? 'Admin' : 'Sales'}
    <button class="link" data-remove="${esc(p.email)}">Remove</button></li>`).join('');
}

$('staff-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const row = { full_name: $('staff-name').value.trim(), email: $('staff-email').value.trim().toLowerCase(), role: $('staff-role').value };
  const { error } = await db.from('allowed_emails').upsert(row);
  $('staff-msg').textContent = error ? 'Could not add: ' + error.message : `${row.full_name} added. They can now create their password in the app.`;
  if (!error) { e.target.reset(); loadStaff(); }
});

$('staff-list').addEventListener('click', async (e) => {
  const email = e.target.dataset.remove;
  if (!email || !confirm(`Remove ${email}? They will lose access to the app straight away.`)) return;
  await db.from('allowed_emails').delete().eq('email', email);
  loadStaff();
});

$('locked-list').addEventListener('click', async (e) => {
  const id = e.target.dataset.unlock;
  if (!id) return;
  await db.rpc('unlock_pin', { target: id });
  e.target.closest('li').remove();
});

$('pin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { error } = await db.rpc('set_cost_pin', { new_pin: $('new-pin').value.trim() });
  $('pin-msg').textContent = error ? error.message : 'PIN saved.';
  if (!error) $('new-pin').value = '';
});

$('admin-back').addEventListener('click', () => show('search-view'));

// Calling Supabase inside this callback can hang the login on some phones, so run it just after.
db.auth.onAuthStateChange((event, session) => {
  if (['INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT'].includes(event)) setTimeout(() => startSession(session), 0);
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
