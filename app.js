const { supabaseUrl, supabaseKey } = window.GARG_CONFIG;
if (!window.supabase) {
  document.querySelector('main').innerHTML =
    '<p class="error">The app could not load. Check the internet connection, then close and reopen the app.</p>';
  throw new Error('supabase-js did not load');
}
const db = supabase.createClient(supabaseUrl, supabaseKey);
const $ = (id) => document.getElementById(id);
const views = ['login-view', 'showroom-view', 'search-view', 'tile-view', 'admin-view'];
let isAdmin = false;
let userId = null;
let lastResults = [];
let costPin = null;          // remembered until the app is closed, so the PIN is typed once
let shownTile = null;

// Each screen change is a step in the phone's history, so Back (ours or the phone's) goes one screen back.
let current = null;
let searchScroll = 0;
let depth = 0;            // screens above the search screen in the history
function show(view, remember = true) {
  if (current === 'search-view') searchScroll = window.scrollY;
  const outside = view === 'login-view' || view === 'showroom-view';
  if (remember && current && view !== current && !outside) history.pushState({ view, depth: ++depth }, '');
  current = view;
  views.forEach((v) => ($(v).hidden = v !== view));
  $('nav').hidden = outside;
  $('nav-back').disabled = view === 'search-view';
  window.scrollTo(0, view === 'search-view' ? searchScroll : 0);
}

window.addEventListener('popstate', (e) => {
  if (current === 'login-view' || current === 'showroom-view') return;
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
  ['f-brand', 'f-size'].forEach((id) => { $(id).classList.remove('on'); syncPick(id); });
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

// Two showrooms, each with its own logo, colours, letterhead and quote numbers. Everyone picks
// their showroom after signing in; the phone remembers it until they log out.
const SHOWROOMS = {
  gs: { name: "Garg's Studio", logo: 'icons/gs-logo.jpg', logoRatio: 716 / 600, settings: 'business', code: 'GS', color: '#f05a28' },
  kp: { name: 'KP Enterprises', logo: 'icons/kp-logo.jpg', printName: true, logoRatio: 790 / 757, settings: 'business_kp', code: 'KP', color: '#21688a' },
};
const SHOWROOM_KEY = 'garg-showroom';
let showroom = null;

function savedShowroom() {
  try { return localStorage.getItem(SHOWROOM_KEY); } catch { return null; }
}

function useShowroom(id) {
  showroom = id;
  try { localStorage.setItem(SHOWROOM_KEY, id); } catch { /* private mode */ }
  const room = SHOWROOMS[id];
  document.body.dataset.showroom = id;
  $('brand-name').textContent = room.name;
  $('brand-by').textContent = 'SalesDesk by Garg';
  $('brand-logo').src = room.logo;
  $('brand-logo').hidden = false;
  document.querySelector('meta[name=theme-color]').content = room.color;
}

function forgetShowroom() {
  showroom = null;
  try { localStorage.removeItem(SHOWROOM_KEY); } catch { /* private mode */ }
  delete document.body.dataset.showroom;
  $('brand-name').textContent = 'SalesDesk';
  $('brand-by').textContent = 'by Garg';
  $('brand-logo').hidden = true;
}

$('showroom-picks').addEventListener('click', (e) => {
  const id = e.target.closest('[data-room]')?.dataset.room;
  if (!SHOWROOMS[id]) return;
  useShowroom(id);
  db.rpc('set_my_showroom', { p_showroom: id });
  enterApp();
});

$('brand').addEventListener('click', () => {
  if (!showroom || !confirm('Change your showroom?')) return;
  forgetShowroom();
  show('showroom-view');
});

async function startSession(session) {
  $('logout').hidden = !session;
  $('admin').hidden = true;
  userId = session?.user?.id || null;
  if (!session) { forgetShowroom(); return show('login-view'); }
  const saved = savedShowroom();
  if (!SHOWROOMS[saved]) return show('showroom-view');
  useShowroom(saved);
  enterApp();
}

async function enterApp() {
  history.replaceState({ view: 'search-view', depth: 0 }, '');
  depth = 0;
  current = null;
  show('search-view');      // never wait on the network before showing the app
  loadFilters();
  window.resumeDraft?.();   // an unfinished client selection opens again
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

// Biggest size first everywhere sizes are listed: by area, then the longer side. Works on "60x120" and "120x180 cm".
function sizeDims(s) {
  const m = /([\d.]+)\s*x\s*([\d.]+)/i.exec(s || '');
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}
function bySizeDesc(a, b) {
  const [a1, a2] = sizeDims(a), [b1, b2] = sizeDims(b);
  return b1 * b2 - a1 * a2 || Math.max(b1, b2) - Math.max(a1, a2);
}
function sortOffers(offers) {
  return (offers || []).slice().sort((x, y) => bySizeDesc(x.size, y.size));
}

function filters() {
  return { p_brand: $('f-brand').value || null, p_size: $('f-size').value || null };
}

async function loadFilters() {
  if ($('f-brand').options.length > 1) return;
  const { data } = await db.rpc('tile_filters');
  if (!data) return;
  $('f-brand').insertAdjacentHTML('beforeend', (data.brands || []).map((b) => `<option>${esc(b)}</option>`).join(''));
  const sizes = (data.sizes || []).slice().sort(bySizeDesc);
  $('f-size').insertAdjacentHTML('beforeend', sizes.map((s) => `<option value="${esc(s)}">${sizeLabel(s)}</option>`).join(''));
}

// Brand and size pickers: tap to open a list with a box to type in. The hidden selects keep the chosen value.
let pickFor = null;
const PICK_HINT = { 'f-brand': 'Type brand name', 'f-size': 'Type size, e.g. 600' };

function syncPick(id) {
  const sel = $(id);
  $(id + '-btn').textContent = sel.options[sel.selectedIndex]?.text || '';
  $(id + '-btn').classList.toggle('on', !!sel.value);
}

function closePick() {
  $('pick-panel').hidden = true;
  pickFor = null;
}

function showPickList() {
  const sel = $(pickFor);
  const words = $('pick-q').value.toLowerCase().split(/\s+/).filter(Boolean);
  const opts = [...sel.options].filter((o, i) => {
    if (!i) return !words.length;
    const text = (o.text + ' ' + o.value).toLowerCase();
    return words.every((w) => text.includes(w));
  });
  $('pick-list').innerHTML = opts.length
    ? opts.map((o) => `<li><button type="button" data-v="${esc(o.value)}"${o.value === sel.value ? ' class="on"' : ''}>${esc(o.text)}</button></li>`).join('')
    : '<li class="muted" style="padding: 10px">Nothing found</li>';
}

function openPick(id) {
  if (pickFor === id) return closePick();
  pickFor = id;
  $('pick-q').value = '';
  $('pick-q').placeholder = PICK_HINT[id];
  showPickList();
  $('pick-panel').hidden = false;
  $('pick-q').focus();
}

['f-brand', 'f-size'].forEach((id) => $(id + '-btn').addEventListener('click', () => openPick(id)));
$('pick-q').addEventListener('input', showPickList);
$('pick-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('pick-list').querySelector('button')?.click(); }
  if (e.key === 'Escape') closePick();
});
$('pick-list').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const sel = $(pickFor);
  closePick();
  if (sel.value === b.dataset.v) return;
  sel.value = b.dataset.v;
  sel.dispatchEvent(new Event('change'));
});
document.addEventListener('click', (e) => {
  if (pickFor && !e.target.closest('#pick-panel, .pick-btn')) closePick();
});

const PAGE = 40;
let shownQuery = '';
let searchTurn = 0;   // only the newest search may fill the list (two quick searches showed every tile twice)

async function runSearch(more = false) {
  hideSuggest();
  const turn = ++searchTurn;
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
  if (turn !== searchTurn) return;
  if (error) return ($('status').textContent = 'Could not search. Check your internet and try again.');
  const have = new Set(lastResults.map((t) => t.id));
  const fresh = data.filter((t) => !have.has(t.id));
  lastResults = lastResults.concat(fresh);
  const n = lastResults.length;
  $('status').textContent = n ? `${n}${data.length === PAGE ? '+' : ''} tile${n > 1 ? 's' : ''}` : 'No tiles found. Try fewer words or change the filters.';
  $('more').hidden = data.length < PAGE;
  const urls = await signedUrls(fresh.map((t) => t.thumb_path));
  if (turn !== searchTurn) return;
  $('results').insertAdjacentHTML('beforeend', fresh.map((t) => `
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
  syncPick(id);
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
  const [{ data: full }, { data: rows }] = await Promise.all([
    db.from('tiles').select('*').eq('id', id).single(),
    db.from('offers').select('*').eq('tile_id', id).order('size'),
  ]);
  const offers = sortOffers(rows);
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
  loadBizForm();
  const { data: locked } = await db.from('pin_attempts').select('user_id, failed').eq('locked', true);
  const ids = (locked || []).map((l) => l.user_id);
  const { data: people } = ids.length ? await db.from('profiles').select('id, full_name').in('id', ids) : { data: [] };
  const names = Object.fromEntries((people || []).map((p) => [p.id, p.full_name || 'Unnamed']));
  $('locked-list').innerHTML = ids.length
    ? ids.map((id) => `<li>${esc(names[id] || id)} <button class="link" data-unlock="${id}">Unlock</button></li>`).join('')
    : '<li class="muted">Nobody is locked out.</li>';
});

// Each showroom's bank and contact details for its quotations (app_settings 'business' / 'business_kp')
async function readBiz(room) {
  const { data, error } = await db.from('app_settings').select('value').eq('key', SHOWROOMS[room].settings).maybeSingle();
  if (error) throw error;
  return data?.value || {};
}

async function loadBizForm() {
  $('biz-msg').textContent = '';
  try {
    const biz = await readBiz($('biz-room').value);
    $('biz-form').querySelectorAll('[data-bank]').forEach((i) => (i.value = biz.bank?.[i.dataset.bank] || ''));
    $('biz-form').querySelectorAll('[data-biz]').forEach((i) => (i.value = biz[i.dataset.biz] || ''));
  } catch {
    $('biz-msg').textContent = 'Could not load. Check your internet.';
  }
}

$('biz-room').addEventListener('change', loadBizForm);

$('biz-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const room = $('biz-room').value;
  const key = SHOWROOMS[room].settings;
  try {
    const biz = await readBiz(room);     // keep the address, terms and everything else as they are
    biz.bank = { ...(biz.bank || {}) };
    $('biz-form').querySelectorAll('[data-bank]').forEach((i) => (biz.bank[i.dataset.bank] = i.value.trim()));
    $('biz-form').querySelectorAll('[data-biz]').forEach((i) => (biz[i.dataset.biz] = i.value.trim()));
    const { error } = await db.from('app_settings').upsert({ key, value: biz });
    if (error) throw error;
    if (typeof businesses !== 'undefined') delete businesses[key];   // the next quotation uses the new details
    $('biz-msg').textContent = `Saved. New ${SHOWROOMS[room].name} quotations will show these details.`;
  } catch {
    $('biz-msg').textContent = 'Could not save. Check your internet and try again.';
  }
});

async function loadStaff() {
  const { data } = await db.from('allowed_emails').select('*').order('full_name');
  $('staff-list').innerHTML = (data || []).map((p) => `<li>${esc(p.full_name || '')} · ${esc(p.email)} · ${p.role === 'admin' ? 'Admin' : 'Sales Executive'}
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

if ('serviceWorker' in navigator) {
  // when a new version of the app takes over, reload once so every screen uses it
  const hadOne = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadOne) location.reload(); });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
}
