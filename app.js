const { supabaseUrl, supabaseKey } = window.GARG_CONFIG;
const db = supabase.createClient(supabaseUrl, supabaseKey);
const $ = (id) => document.getElementById(id);
const views = ['login-view', 'search-view', 'tile-view'];
let isAdmin = false;
let lastResults = [];

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
  if (!session) return show('login-view');
  const { data } = await db.from('profiles').select('role').eq('id', session.user.id).single();
  isAdmin = data?.role === 'admin';
  show('search-view');
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  $('login-error').hidden = true;
  const { error } = await db.auth.signInWithPassword({ email: form.get('email'), password: form.get('password') });
  if (error) {
    $('login-error').textContent = 'Wrong email or password.';
    $('login-error').hidden = false;
  }
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
  let costs = {};
  if (isAdmin && offers?.length) {
    const { data } = await db.from('offer_costs').select('*').in('offer_id', offers.map((o) => o.id));
    costs = Object.fromEntries((data || []).map((c) => [c.offer_id, c]));
  }
  const urls = await signedUrls([full.image_path]);
  $('tile').innerHTML = `
    ${urls[full.image_path] ? `<img class="hero" src="${urls[full.image_path]}" alt="${esc(full.name)}">` : ''}
    <h1>${esc(full.name)}</h1>
    <p class="muted">${esc(full.brand)}${full.catalog ? ' · ' + esc(full.catalog) : ''}</p>
    ${(offers || []).map((o) => offerHtml(o, costs[o.id])).join('') || '<p>No sizes listed yet.</p>'}
    ${full.notes ? `<p class="muted">${esc(full.notes)}</p>` : ''}`;
  if (!tile) lastResults.push(full);
}

function offerHtml(o, cost) {
  const per = o.unit === 'box' ? 'per box' : 'per sq ft';
  return `<div class="offer">
    <h3>${esc(o.size)}${o.finish ? ' · ' + esc(o.finish) : ''}</h3>
    <div class="price">${rupees(o.selling_price)} <span class="muted">${per}</span></div>
    ${isAdmin && cost ? `<div class="cost">Cost: ${rupees(cost.net_cost)} ${per}</div>` : ''}
    <dl>
      ${o.packing ? `<dt>Packing</dt><dd>${esc(o.packing)}</dd>` : ''}
      ${o.weight_kg ? `<dt>Weight</dt><dd>${esc(o.weight_kg)} kg per box</dd>` : ''}
      ${o.series ? `<dt>Series</dt><dd>${esc(o.series)}</dd>` : ''}
      ${o.note ? `<dt>Note</dt><dd>${esc(o.note)}</dd>` : ''}
    </dl>
  </div>`;
}

db.auth.onAuthStateChange((_event, session) => startSession(session));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
