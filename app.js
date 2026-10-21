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

// Each screen change is a step in the phone's history, so Back (ours or the phone's) goes one screen back.
let current = null;
let searchScroll = 0;
let depth = 0;            // screens above the search screen in the history
function show(view, remember = true) {
  if (current === 'search-view') searchScroll = window.scrollY;
  if (remember && current && view !== current && view !== 'login-view') history.pushState({ view, depth: ++depth }, '');
  current = view;
  views.forEach((v) => ($(v).hidden = v !== view));
  $('nav').hidden = view === 'login-view';
  $('nav-back').disabled = view === 'search-view';
  window.scrollTo(0, view === 'search-view' ? searchScroll : 0);
}

window.addEventListener('popstate', (e) => {
  if (current === 'login-view') return;
  depth = e.state?.depth || 0;
  show(e.state?.view || 'search-view', false);
});

function goBack() {
  if (current !== 'search-view') history.back();
}

function goHome() {
  $('q').value = '';
  $('f-brand').value = '';
  $('f-size').value = '';
  ['f-brand', 'f-size'].forEach((id) => $(id).classList.remove('on'));
  searchScroll = 0;
  runSearch();
  if (current === 'search-view') return window.scrollTo(0, 0);
  history.go(-depth);       // the popstate that follows shows the search screen
}

$('nav-back').addEventListener('click', goBack);
$('nav-home').addEventListener('click', goHome);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function rupees(n, decimals = 2) {
  return n == null ? 'Price not in list' : '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: decimals });
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
  history.replaceState({ view: 'search-view', depth: 0 }, '');
  depth = 0;
  current = null;
  show('search-view');      // never wait on the network before showing the app
  loadFilters();
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

// Size values like "60x120" (cm, as stored) are shown in mm the way staff say them: 600x1200 mm
function sizeLabel(s) {
  return s.split('x').map((v) => Math.round(Number(v) * 10)).join('x') + ' mm';
}

function filters() {
  return { p_brand: $('f-brand').value || null, p_size: $('f-size').value || null };
}

async function loadFilters() {
  if ($('f-brand').options.length > 1) return;
  const { data } = await db.rpc('tile_filters');
  if (!data) return;
  $('f-brand').insertAdjacentHTML('beforeend', (data.brands || []).map((b) => `<option>${esc(b)}</option>`).join(''));
  $('f-size').insertAdjacentHTML('beforeend', (data.sizes || []).map((s) => `<option value="${esc(s)}">${sizeLabel(s)}</option>`).join(''));
}

const PAGE = 40;
let shownQuery = '';

async function runSearch(more = false) {
  hideSuggest();
  const q = $('q').value.trim();
  const f = filters();
  if (!more && !q && !f.p_brand && !f.p_size) {
    $('status').textContent = '';
    $('results').innerHTML = '';
    $('more').hidden = true;
    lastResults = [];
    return;
  }
  if (!more) { shownQuery = q; lastResults = []; $('results').innerHTML = ''; }
  $('status').textContent = 'Searching…';
  $('more').hidden = true;
  const { data, error } = await db.rpc('browse_tiles', { q: shownQuery, ...f, p_offset: lastResults.length, p_limit: PAGE });
  if (error) return ($('status').textContent = 'Could not search. Check your internet and try again.');
  lastResults = lastResults.concat(data);
  const n = lastResults.length;
  $('status').textContent = n ? `${n}${data.length === PAGE ? '+' : ''} tile${n > 1 ? 's' : ''}` : 'No tiles found. Try fewer words or change the filters.';
  $('more').hidden = data.length < PAGE;
  const urls = await signedUrls(data.map((t) => t.thumb_path));
  $('results').insertAdjacentHTML('beforeend', data.map((t) => `
    <li class="card"><button data-id="${t.id}">
      ${urls[t.thumb_path] ? `<img src="${urls[t.thumb_path]}" alt="" loading="lazy">` : '<div class="thumb-empty"></div>'}
      <div class="info"><div class="name">${esc(t.name)}</div><div class="muted">${esc(t.brand)}</div></div>
    </button></li>`).join(''));
}

$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  $('q').blur();
  runSearch();
});
$('more').addEventListener('click', () => runSearch(true));
['f-brand', 'f-size'].forEach((id) => $(id).addEventListener('change', () => {
  $(id).classList.toggle('on', !!$(id).value);
  runSearch();
}));

// Suggestions while typing; only the newest answer is shown when typing fast.
let suggestTimer = null;
let suggestTurn = 0;
function hideSuggest() { $('suggest').hidden = true; suggestTurn++; }

$('q').addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = $('q').value.trim();
  if (!q) { hideSuggest(); if (!filters().p_brand && !filters().p_size) runSearch(); return; }
  suggestTimer = setTimeout(async () => {
    const turn = ++suggestTurn;
    const { data } = await db.rpc('suggest_tiles', { q, ...filters() });
    if (turn !== suggestTurn) return;
    if (!data?.length) return ($('suggest').hidden = true);
    const urls = await signedUrls(data.map((t) => t.thumb_path));
    if (turn !== suggestTurn) return;
    $('suggest').innerHTML = data.map((t) => `<li><button type="button" data-id="${t.id}">
      ${urls[t.thumb_path] ? `<img src="${urls[t.thumb_path]}" alt="">` : '<span class="dot"></span>'}
      <span><b>${esc(t.name)}</b> <span class="muted">${esc(t.brand)}</span></span></button></li>`).join('');
    $('suggest').hidden = false;
  }, 200);
});

$('suggest').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-id]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const name = btn.querySelector('b').textContent;
  hideSuggest();
  $('q').value = name;
  pickOrOpen(id);
});

document.addEventListener('click', (e) => { if (!e.target.closest('.suggest-wrap')) hideSuggest(); });

$('results').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-id]');
  if (btn) pickOrOpen(Number(btn.dataset.id));
});

$('back').addEventListener('click', goBack);

// While a client selection is choosing a tile, a tap adds the tile there instead of opening it
async function pickOrOpen(id) {
  if (window.pickTile && (await window.pickTile(id))) return;
  openTile(id);
}

async function openTile(id) {
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
}

// Clients are charged by the rounded size in inches (600x1200 = 24"x48" = 8 sq ft a piece, so a
// 2-piece box is 16 sq ft, not the actual 15.5); Kirti, 2026-10-21
function chargedBoxSqft(o) {
  const m = /([\d.]+)x([\d.]+)/.exec(o.size || '');
  if (!m) return null;
  const inch = (cm) => Math.round(Number(cm) / 2.5 * 2) / 2;
  const piece = (inch(m[1]) * inch(m[2])) / 144;
  let pcs = Number((/(\d+)\s*pcs?\b/i.exec(o.packing || '') || [])[1]);
  if (!pcs && o.box_sqft) pcs = Math.round(Number(o.box_sqft) / (Number(m[1]) * Number(m[2]) / 929.03));
  return pcs ? Math.round(pcs * piece * 100) / 100 : null;
}

function offerHtml(o, cost) {
  const per = o.unit === 'box' ? 'per box' : 'per sq ft';
  return `<div class="offer">
    <h3>${esc(o.size)}${o.finish ? ' · ' + esc(o.finish) : ''}</h3>
    <div class="muted">Selling price</div>
    <div class="price">${rupees(o.selling_price == null ? null : Math.round(o.selling_price), 0)} <span class="muted">${per}</span></div>
    ${cost !== undefined ? `<div class="cost">Cost: ${rupees(cost)} ${per}</div>` : ''}
    <dl>
      ${o.packing ? `<dt>Packing</dt><dd>${esc(o.packing)}</dd>` : ''}
      ${chargedBoxSqft(o) ? `<dt>Charged</dt><dd>${chargedBoxSqft(o)} sq ft per box</dd>` : ''}
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

$('admin-back').addEventListener('click', goBack);

// Calling Supabase inside this callback can hang the login on some phones, so run it just after.
db.auth.onAuthStateChange((event, session) => {
  if (['INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT'].includes(event)) setTimeout(() => startSession(session), 0);
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
