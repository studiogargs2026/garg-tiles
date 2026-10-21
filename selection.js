// Client selections: client details, areas, and the tiles chosen for each area (wall, floor,
// highlighter...). From one selection the app makes the selection PDF (one slide per area with
// the tile pictures) and the quotation PDF. Tile names can be shown as they are, shortened, or
// replaced by a code, so the client does not get the exact name.
views.push('selections-view', 'selection-view');

const ROLES = ['Wall', 'Floor', 'Highlighter', 'Slab', 'Other'];
const ROLE_TAG = { Wall: 'WALL', Floor: 'FLOOR', Highlighter: 'HL', Slab: 'SLAB', Other: '' };
const AREA_NAMES = ['Master Washroom', 'Powder Washroom', 'Common Washroom', 'Other Washroom', 'Kitchen Wall & Slab',
  'Living Room', 'Bedroom', 'Guest Room', 'Balcony', 'Staircase', 'All Floor'];
const UNITS = ['Bag', 'Pcs', 'Box', 'Sqft', 'Set', 'Rft'];

let sel = null;              // the selection being edited
let business = null;         // letterhead details for the quotation

function blankSelection() {
  return { id: null, quote_no: '', client: '', data: { address: '', phone: '', nameStyle: 'real', pictures: true, labour: '', notes: '', gst: 'in', gstRate: 18, areas: [] } };
}

// ---------- names and sizes as printed ----------

// 120x240 cm -> 8X4 (feet); 80x240 cm -> 96"X32" (inches), the way the showroom writes sizes
function printedSize(size) {
  const m = /([\d.]+)x([\d.]+)/.exec(size || '');
  if (!m) return '';
  const [a, b] = [Number(m[1]), Number(m[2])].sort((x, y) => y - x);
  const feet = (v) => Math.abs(v / 30 - Math.round(v / 30)) < 0.03 && v >= 30;
  if (feet(a) && feet(b)) return `${Math.round(a / 30)}X${Math.round(b / 30)}`;
  const inch = (v) => Math.round(v / 2.5 * 2) / 2;
  return `${inch(a)}"X${inch(b)}"`;
}

function shortName(name) {
  // "Aldoran Taupe Endless" -> "A.T.E."
  return name.split(/\s+/).filter(Boolean).map((w) => (/^\d/.test(w) ? w : w[0].toUpperCase() + '.')).join('');
}

function newCode() {
  return 'GS-' + String(Math.floor(1000 + Math.random() * 9000));
}

function applyNameStyle(style) {
  sel.data.nameStyle = style;
  for (const area of sel.data.areas) for (const it of area.items) {
    if (it.kind !== 'tile') continue;
    it.pdfName = style === 'short' ? shortName(it.name) : style === 'code' ? (it.code ||= newCode()) : it.name;
  }
}

function offerOf(it) {
  return it.offers[it.pick] || {};
}

function finishTag(finish) {
  return finish && finish.length <= 16 && !/:/.test(finish) ? finish.toUpperCase() : '';
}

function lineText(it) {
  const o = offerOf(it);
  const tags = [finishTag(o.finish), ROLE_TAG[it.role]].filter(Boolean).map((t) => `(${t})`).join(' ');
  return [printedSize(o.size), (it.pdfName || it.name).toUpperCase(), tags].filter(Boolean).join(' ');
}

// ---------- quantities ----------

function setSqft(it, sqft) {
  const box = chargedBoxSqft(offerOf(it)) || 0;
  if (box && sqft > 0) {
    it.boxes = Math.ceil(sqft / box - 1e-9);
    it.sqft = Math.round(it.boxes * box * 100) / 100;
  } else {
    it.boxes = '';
    it.sqft = sqft || '';
  }
}

function setBoxes(it, boxes) {
  const box = chargedBoxSqft(offerOf(it)) || 0;
  it.boxes = boxes || '';
  if (box && boxes > 0) it.sqft = Math.round(boxes * box * 100) / 100;
}

function amountOf(it) {
  const qty = it.kind === 'tile' ? Number(it.sqft) : Number(it.qty);
  return Math.round((qty || 0) * (Number(it.rate) || 0));
}

function money(n) {
  return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

// ---------- list of selections ----------

async function openSelections() {
  if (current === 'selection-view') leftSelection();
  show('selections-view');
  const draft = readDraft();
  const unsaved = draft?.sel && !draft.sel.id && (draft.sel.client || draft.sel.data?.areas?.length);
  $('sel-unsaved').hidden = !unsaved;
  $('sel-list').innerHTML = '<li class="muted">Loading…</li>';
  const { data, error } = await db.from('selections').select('id, client, quote_no, updated_at').order('updated_at', { ascending: false }).limit(100);
  if (error) return ($('sel-list').innerHTML = '<li class="error">Could not load. Check your internet.</li>');
  $('sel-list').innerHTML = data.length ? data.map((s) => `<li class="card sel-row"><button data-sel="${s.id}">
      <b>${esc(s.client)}</b><span class="muted">${s.quote_no ? 'Quote ' + esc(s.quote_no) + ' · ' : ''}${new Date(s.updated_at).toLocaleDateString('en-IN')}</span>
    </button></li>`).join('') : '<li class="muted">No selections yet. Tap "New selection" to start one.</li>';
}

$('nav-sel').addEventListener('click', openSelections);
$('sel-new').addEventListener('click', () => {
  if (!$('sel-unsaved').hidden && !confirm('You have an unfinished selection that is not saved online. Start a new one anyway?')) return;
  sel = blankSelection();
  renderSelection();
  draftNote('');
  show('selection-view');
});
$('sel-unsaved').addEventListener('click', () => {
  const d = readDraft();
  sel = { ...blankSelection(), ...d.sel, data: { ...blankSelection().data, ...d.sel.data } };
  renderSelection();
  draftNote('');
  show('selection-view');
});
$('sel-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-sel]');
  if (!b) return;
  const { data, error } = await db.from('selections').select('*').eq('id', b.dataset.sel).single();
  if (error) return alert('Could not open this selection.');
  sel = { ...data, data: { ...blankSelection().data, ...data.data } };
  renderSelection();
  draftNote('');
  show('selection-view');
});

// ---------- editing ----------

function renderSelection() {
  const d = sel.data;
  $('sel-client').value = sel.client;
  $('sel-address').value = d.address || '';
  $('sel-phone').value = d.phone || '';
  $('sel-quote-no').value = sel.quote_no || '';
  $('sel-labour').value = d.labour || '';
  $('sel-pictures').checked = d.pictures !== false;
  $('sel-notes').value = d.notes || '';
  $('sel-gst').value = d.gst || 'in';
  $('sel-gst-rate').value = d.gstRate || 18;
  $('sel-gst-rate-wrap').hidden = (d.gst || 'in') === 'in';
  document.querySelectorAll('[name=sel-names]').forEach((r) => (r.checked = r.value === (d.nameStyle || 'real')));
  $('sel-delete').hidden = !sel.id;
  $('sel-areas').innerHTML = d.areas.map((a, ai) => `
    <div class="area card" data-area="${ai}">
      <div class="area-head">
        <input class="area-name" list="area-names" value="${esc(a.name)}" placeholder="Area, e.g. Master Washroom" data-f="area-name">
        <button type="button" class="link danger" data-act="del-area">Remove</button>
      </div>
      ${a.items.map((it, ii) => itemHtml(it, ii)).join('') || '<p class="muted">No tiles yet.</p>'}
      <div class="area-actions">
        <button type="button" class="primary small" data-act="add-tile">+ Add tile</button>
        <button type="button" class="ghost small" data-act="add-other">+ Other item</button>
      </div>
    </div>`).join('') || '<p class="muted">Add the first area, like "Master Washroom".</p>';
  refreshThumbs();
  updateTotal();
  keepLocal(true);
}

function itemHtml(it, ii) {
  if (it.kind === 'other') {
    return `<div class="item other" data-item="${ii}">
      <div class="item-top"><b>Other item</b><button type="button" class="link danger" data-act="del-item">Remove</button></div>
      <input data-f="desc" value="${esc(it.desc)}" placeholder="Description, e.g. Dimond Star (50kg)">
      <div class="qty-row">
        <label>Qty<input data-f="qty" type="number" inputmode="decimal" value="${esc(it.qty)}"></label>
        <label>Unit<select data-f="unit">${UNITS.map((u) => `<option${u === it.unit ? ' selected' : ''}>${u}</option>`).join('')}</select></label>
        <label>Rate ₹<input data-f="rate" type="number" inputmode="decimal" value="${esc(it.rate)}"></label>
      </div>
      <div class="muted amount">Amount: ₹${money(amountOf(it))}</div>
    </div>`;
  }
  const o = offerOf(it);
  return `<div class="item" data-item="${ii}">
    <div class="item-top">
      <img class="sel-thumb" data-thumb="${esc(it.thumb_path || '')}" alt="">
      <div class="grow"><b>${esc(it.name)}</b><div class="muted">${esc(it.brand)}</div></div>
      <button type="button" class="link danger" data-act="del-item">Remove</button>
    </div>
    <div class="qty-row">
      <label>Used as<select data-f="role">${ROLES.map((r) => `<option${r === it.role ? ' selected' : ''}>${r}</option>`).join('')}</select></label>
      <label class="wide">Size<select data-f="pick">${it.offers.map((x, k) => `<option value="${k}"${k === it.pick ? ' selected' : ''}>${esc(x.size || '')}${x.finish ? ' · ' + esc(x.finish) : ''}</option>`).join('')}</select></label>
    </div>
    <label>Name in PDF<input data-f="pdfName" value="${esc(it.pdfName)}"></label>
    <div class="qty-row">
      <label>Sq ft<input data-f="sqft" type="number" inputmode="decimal" value="${esc(it.sqft)}"></label>
      <label>Boxes<input data-f="boxes" type="number" inputmode="numeric" value="${esc(it.boxes)}"></label>
      <label>Rate ₹/sq ft<input data-f="rate" type="number" inputmode="decimal" value="${esc(it.rate)}"></label>
    </div>
    <div class="muted amount">${chargedBoxSqft(o) ? `${chargedBoxSqft(o)} sq ft per box (charged) · ` : ''}Amount: ₹${money(amountOf(it))}</div>
  </div>`;
}

async function refreshThumbs() {
  const imgs = [...document.querySelectorAll('img[data-thumb]')].filter((i) => i.dataset.thumb);
  const urls = await signedUrls(imgs.map((i) => i.dataset.thumb));
  imgs.forEach((i) => { if (urls[i.dataset.thumb]) i.src = urls[i.dataset.thumb]; });
}

function updateTotal() {
  const sub = sel.data.areas.flatMap((a) => a.items).reduce((s, it) => s + amountOf(it), 0);
  $('sel-total').textContent = `Total: ₹${money(sub + (Number(sel.data.labour) || 0))}`;
}

function where(e) {
  const area = e.target.closest('[data-area]');
  const item = e.target.closest('[data-item]');
  const a = area ? sel.data.areas[area.dataset.area] : null;
  return { a, ai: area && Number(area.dataset.area), it: a && item ? a.items[item.dataset.item] : null, itemEl: item };
}

$('sel-areas').addEventListener('input', (e) => {
  const f = e.target.dataset.f;
  const { a, it, itemEl } = where(e);
  if (!f || !a) return;
  const v = e.target.value;
  if (f === 'area-name') a.name = v;
  else if (it && f === 'pdfName') it.pdfName = v;
  else if (it && f === 'desc') it.desc = v;
  else if (it && (f === 'rate' || f === 'qty')) it[f] = v;
  else return;
  if (itemEl) itemEl.querySelector('.amount').innerHTML = itemEl.querySelector('.amount').innerHTML.replace(/Amount: ₹[\d,]*/, `Amount: ₹${money(amountOf(it))}`);
  updateTotal();
});

$('sel-areas').addEventListener('change', (e) => {
  const f = e.target.dataset.f;
  const { it } = where(e);
  if (!it || !f) return;
  const v = e.target.value;
  if (f === 'role' || f === 'unit') it[f] = v;
  else if (f === 'pick') {
    it.pick = Number(v);
    it.rate = Math.round(Number(offerOf(it).selling_price) || 0) || it.rate;
    if (it.sqft) setSqft(it, Number(it.sqft));
  } else if (f === 'sqft') setSqft(it, Number(v));
  else if (f === 'boxes') setBoxes(it, Number(v));
  else return;
  renderSelection();
});

$('sel-areas').addEventListener('click', (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  const { a, ai, itemEl } = where(e);
  if (act === 'del-area' && confirm(`Remove "${a.name || 'this area'}" and its tiles?`)) sel.data.areas.splice(ai, 1);
  else if (act === 'del-item') a.items.splice(Number(itemEl.dataset.item), 1);
  else if (act === 'add-other') a.items.push({ kind: 'other', desc: '', qty: '', unit: 'Bag', rate: '' });
  else if (act === 'add-tile') return startPicking(ai);
  else return;
  renderSelection();
});

$('sel-add-area').addEventListener('click', () => {
  sel.data.areas.push({ name: '', items: [] });
  renderSelection();
  const names = document.querySelectorAll('.area-name');
  names[names.length - 1]?.focus();
});

[['sel-client', (v) => (sel.client = v)], ['sel-address', (v) => (sel.data.address = v)], ['sel-phone', (v) => (sel.data.phone = v)],
 ['sel-quote-no', (v) => (sel.quote_no = v)], ['sel-labour', (v) => { sel.data.labour = v; updateTotal(); }]]
  .forEach(([id, set]) => $(id).addEventListener('input', (e) => set(e.target.value)));
$('sel-pictures').addEventListener('change', (e) => (sel.data.pictures = e.target.checked));
$('sel-notes').addEventListener('input', (e) => (sel.data.notes = e.target.value));
$('sel-gst').addEventListener('change', (e) => { sel.data.gst = e.target.value; $('sel-gst-rate-wrap').hidden = e.target.value === 'in'; });
$('sel-gst-rate').addEventListener('input', (e) => (sel.data.gstRate = Number(e.target.value) || 18));
document.querySelectorAll('[name=sel-names]').forEach((r) => r.addEventListener('change', () => { applyNameStyle(r.value); renderSelection(); }));

// ---------- choosing a tile from the search screen ----------

let pickArea = null;
function startPicking(ai) {
  pickArea = ai;
  const name = sel.data.areas[ai].name || 'this area';
  $('pick-banner').hidden = false;
  $('pick-text').textContent = `Tap a tile to add it to ${name}`;
  show('search-view');
  $('q').focus();
}

function stopPicking() {
  pickArea = null;
  $('pick-banner').hidden = true;
}

$('pick-cancel').addEventListener('click', () => { stopPicking(); history.back(); });

// app.js calls this when a tile is tapped; returns true when the tap was for a selection
window.pickTile = async function (id) {
  if (pickArea === null || current !== 'search-view') return false;
  const area = sel.data.areas[pickArea];
  stopPicking();
  const [{ data: t }, { data: offers }] = await Promise.all([
    db.from('tiles').select('id, brand, name, image_path, thumb_path').eq('id', id).single(),
    db.from('offers').select('size, finish, packing, box_sqft, selling_price, unit').eq('tile_id', id).order('size'),
  ]);
  area.items.push(tileItem(t, offers, 'Wall'));
  history.back();            // back to the selection (goBack stays put on the search screen)
  renderSelection();
  changed(true);
  return true;
};

function tileItem(t, offers, role) {
  const it = { kind: 'tile', ...t, offers: offers || [], pick: 0, role, sqft: '', boxes: '', code: null };
  it.rate = Math.round(Number(offerOf(it).selling_price) || 0) || '';
  it.pdfName = sel.data.nameStyle === 'short' ? shortName(it.name) : sel.data.nameStyle === 'code' ? (it.code = newCode()) : it.name;
  return it;
}

// photo.js calls this: a new selection with one area holding the given tiles [{id, role}]
window.startSelectionWith = async function (picks, areaName) {
  const draft = readDraft();
  if (draft?.sel && !draft.sel.id && (draft.sel.client || draft.sel.data?.areas?.length)
    && !confirm('You have an unfinished selection that is not saved online. Start a new one anyway?')) return;
  const ids = picks.map((p) => p.id);
  const [{ data: tiles }, { data: offers }] = await Promise.all([
    db.from('tiles').select('id, brand, name, image_path, thumb_path').in('id', ids),
    db.from('offers').select('tile_id, size, finish, packing, box_sqft, selling_price, unit').in('tile_id', ids).order('size'),
  ]);
  sel = blankSelection();
  const area = { name: areaName, items: [] };
  for (const p of picks) {
    const t = (tiles || []).find((x) => x.id === p.id);
    if (t) area.items.push(tileItem(t, (offers || []).filter((o) => o.tile_id === p.id).map(({ tile_id, ...o }) => o), p.role));
  }
  sel.data.areas.push(area);
  renderSelection();
  show('selection-view');
  changed(true);
  draftNote('Made from the photo. Change or remove any tile, then type the client\'s name.');
};

// ---------- saving and drafts ----------

// Every change is kept on the phone at once (so closing the browser loses nothing) and, once the
// client has a name, saved online a moment later. The draft reopens when the app is opened again.
const DRAFT_KEY = 'garg-selection-draft';
let saving = Promise.resolve(false);
let autoTimer = null;

function readDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch { return null; }
}

function keepLocal(open = true) {
  if (!sel) return;
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ sel, open, at: Date.now() })); } catch { /* private mode */ }
}

function draftNote(text) {
  $('sel-draft').textContent = text;
}

function changed(force) {
  if (!sel || (force !== true && current !== 'selection-view')) return;
  keepLocal(true);
  clearTimeout(autoTimer);
  if (!sel.client.trim()) return draftNote("Kept on this phone. Type the client's name to also save it online.");
  draftNote('Saving…');
  autoTimer = setTimeout(async () => {
    const ok = await saveSelection(true, true);
    draftNote(ok ? `Draft saved at ${new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`
      : 'Kept on this phone. It will save online when the internet is back.');
  }, 1500);
}

// one save at a time, so a new selection is never inserted twice
function saveSelection(quiet, auto) {
  const run = saving.then(() => saveNow(quiet, auto));
  saving = run.catch(() => false);
  return run;
}

async function saveNow(quiet, auto) {
  if (!sel.client.trim()) { if (!auto) alert("Please type the client's name first."); return false; }
  const row = { client: sel.client.trim(), quote_no: sel.quote_no || null, data: sel.data, updated_at: new Date().toISOString() };
  const res = sel.id ? await db.from('selections').update(row).eq('id', sel.id).select('id').single()
    : await db.from('selections').insert(row).select('id').single();
  if (res.error) { if (!auto) alert('Could not save. Check your internet and try again.'); return false; }
  sel.id = res.data.id;
  keepLocal(current === 'selection-view' || pickArea !== null);
  $('sel-delete').hidden = false;
  if (!quiet) flash('Saved');
  return true;
}

function flash(text) {
  $('sel-msg').textContent = text;
  setTimeout(() => ($('sel-msg').textContent = ''), 2500);
}

// leaving the selection (not to pick a tile) closes the draft, so the app no longer reopens it
function leftSelection() {
  setTimeout(() => { if (sel && current !== 'selection-view' && pickArea === null) keepLocal(false); }, 0);
}
window.addEventListener('popstate', leftSelection);
$('nav-home').addEventListener('click', leftSelection);

// app.js calls this when the app opens
window.resumeDraft = async function () {
  const d = readDraft();
  if (!d?.sel || !d.open) return;
  sel = { ...blankSelection(), ...d.sel, data: { ...blankSelection().data, ...d.sel.data } };
  await openSelections();
  renderSelection();
  show('selection-view');
  draftNote('Your unfinished selection was opened again.');
};

$('selection-view').addEventListener('input', changed);
$('selection-view').addEventListener('change', changed);
$('selection-view').addEventListener('click', (e) => { if (e.target.closest('[data-act], #sel-add-area')) changed(); });

$('sel-save').addEventListener('click', () => saveSelection());
$('sel-delete').addEventListener('click', async () => {
  if (!confirm(`Delete the selection for ${sel.client}?`)) return;
  const { error } = await db.from('selections').delete().eq('id', sel.id);
  if (error) return alert('Only the person who made it, or an admin, can delete it.');
  if (readDraft()?.sel?.id === sel.id) try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
  sel = null;
  goBack();
  openSelections();
});

// ---------- pictures, fonts and colours for the PDFs ----------

// Garg's Studio colours, from the logo
const C = {
  maroon: [82, 1, 28], gold: [255, 183, 115], goldDark: [176, 108, 46], cream: [252, 245, 236],
  sand: [244, 232, 218], ink: [40, 24, 28], grey: [118, 102, 106], line: [230, 214, 200], white: [255, 255, 255],
};
const LOGO_RATIO = 716 / 600;      // icons/gs-logo.jpg, gold logo on maroon

// A picture cut to the same shape every time (aspect = width / height), so all boxes match.
async function pictureData(path, { maxSide = 1400, portrait = false, aspect = null } = {}) {
  if (!path) return null;
  const urls = await signedUrls([path]);
  if (!urls[path]) return null;
  try {
    const blob = await (await fetch(urls[path])).blob();
    const bmp = await createImageBitmap(blob);
    const turn = portrait && bmp.width > bmp.height * 1.3;     // long tiles stand upright, like on a wall
    const w = turn ? bmp.height : bmp.width, h = turn ? bmp.width : bmp.height;
    let cw = w, ch = h;
    if (aspect) { if (w / h > aspect) cw = h * aspect; else ch = w / aspect; }
    const k = Math.min(1, maxSide / Math.max(cw, ch));
    const c = document.createElement('canvas');
    c.width = Math.round(cw * k); c.height = Math.round(ch * k);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.scale(k, k);
    g.translate(-(w - cw) / 2, -(h - ch) / 2);
    if (turn) { g.translate(w, 0); g.rotate(Math.PI / 2); }
    g.drawImage(bmp, 0, 0);
    return { src: c.toDataURL('image/jpeg', 0.88), w: c.width, h: c.height };
  } catch {
    return null;
  }
}

async function staticData(url) {
  const blob = await (await fetch(url)).blob();
  return new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(blob); });
}

let logoData = null;
let fontFiles = null;
const FONTS = [['Poppins-400.ttf', 'Poppins', 'normal'], ['Poppins-600.ttf', 'Poppins', 'bold'], ['Playfair-700.ttf', 'Playfair', 'bold']];

// Poppins prints the ₹ sign; Playfair (close to the logo's lettering) is for headings only
async function startPdf(options) {
  const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4', ...options });
  fontFiles ||= await Promise.all(FONTS.map(async ([f]) => (await staticData('vendor/fonts/' + f)).split(',')[1]));
  FONTS.forEach(([f, name, style], i) => { doc.addFileToVFS(f, fontFiles[i]); doc.addFont(f, name, style); });
  logoData ||= await staticData('icons/gs-logo.jpg');
  return doc;
}

function pen(doc, family, style, size, color) {
  doc.setFont(family, style);
  doc.setFontSize(size);
  doc.setTextColor(...color);
}

function rs(n, decimals = 0) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function sizeText(o) {
  const m = /([\d.]+)x([\d.]+)/.exec(o.size || '');
  if (!m) return '';
  const mm = `${Math.round(m[1] * 10)}x${Math.round(m[2] * 10)} mm`;
  const p = printedSize(o.size);
  return /"/.test(p) ? mm : `${mm} (${p.replace('X', ' x ')} ft)`;
}

function tileDetails(it) {
  const o = offerOf(it);
  return [sizeText(o), finishTag(o.finish) && o.finish].filter(Boolean).join('  ·  ');
}

// page numbers from page `from`, leaving out the last page when it is a closing page
function pageNumbers(doc, label, from, skipLast) {
  const n = doc.getNumberOfPages();
  const { width: PW, height: PH } = doc.internal.pageSize;
  for (let i = from; i <= n - (skipLast ? 1 : 0); i++) {
    doc.setPage(i);
    doc.setDrawColor(...C.gold); doc.setLineWidth(0.6);
    doc.line(36, PH - 30, PW - 36, PH - 30);
    pen(doc, 'Poppins', 'normal', 7.5, C.grey);
    doc.text(label, 36, PH - 18);
    doc.text(`Page ${i} of ${n}`, PW - 36, PH - 18, { align: 'right' });
  }
}

function deliverName(text) {
  return text.replace(/[\\/:*?"<>|]+/g, '-');
}

async function deliver(doc, filename) {
  const blob = doc.output('blob');
  const file = new File([blob], deliverName(filename), { type: 'application/pdf' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

function busy(on, text = 'Making the PDF…') {
  $('sel-msg').textContent = on ? text : '';
  ['sel-pdf', 'sel-quote'].forEach((id) => ($(id).disabled = on));
}

function tileItems(area) {
  return area.items.filter((it) => it.kind === 'tile');
}

// ---------- selection PDF ----------

async function selectionPdf() {
  if (!sel.data.areas.some((a) => tileItems(a).length)) return alert('Add at least one tile first.');
  if (!(await saveSelection(true))) return;
  busy(true);
  try {
    const biz = await loadBusiness();
    const doc = await startPdf({ orientation: 'landscape' });
    const PW = 842, PH = 595;
    const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const paint = (c) => { doc.setFillColor(...c); doc.rect(0, 0, PW, PH, 'F'); };
    const page = (title, sub) => {
      doc.addPage();
      paint(C.cream);
      doc.setFillColor(...C.maroon); doc.rect(0, 0, PW, 66, 'F');
      doc.addImage(logoData, 'JPEG', 30, 7, 52 * LOGO_RATIO, 52);
      pen(doc, 'Playfair', 'bold', 21, C.gold);
      doc.text(title, 112, 42, { maxWidth: 520 });
      if (sub) { pen(doc, 'Poppins', 'normal', 9, C.cream); doc.text(sub, PW - 36, 40, { align: 'right' }); }
    };
    const areas = sel.data.areas.filter((a) => tileItems(a).length);

    // cover
    paint(C.maroon);
    doc.addImage(logoData, 'JPEG', (PW - 240 * LOGO_RATIO) / 2, 54, 240 * LOGO_RATIO, 240);
    doc.setDrawColor(...C.gold); doc.setLineWidth(0.8); doc.line(PW / 2 - 50, 322, PW / 2 + 50, 322);
    pen(doc, 'Playfair', 'bold', 30, C.gold);
    doc.text('Tile Selection', PW / 2, 365, { align: 'center' });
    pen(doc, 'Poppins', 'normal', 13, C.cream);
    doc.text(`Prepared for ${sel.client}`, PW / 2, 395, { align: 'center' });
    pen(doc, 'Poppins', 'normal', 9.5, C.sand);
    doc.text([sel.data.address, today].filter(Boolean).join('   ·   '), PW / 2, 416, { align: 'center', maxWidth: 600 });
    pen(doc, 'Poppins', 'normal', 8.5, C.gold);
    doc.text('LUXURY TILES   ·   BATHWARE   ·   ITALIAN MARBLE   ·   WINDOWS', PW / 2, PH - 42, { align: 'center', charSpace: 1 });

    // summary: every area and its tiles on one page (more pages if needed)
    page('Your Selection', sel.client);
    const colW = 360, colX = [44, 44 + colW + 34], top = 100, bottom = PH - 50;
    let col = 0, y = top;
    const need = (h) => {
      if (y + h <= bottom) return;
      if (col === 0) { col = 1; y = top; return; }
      page('Your Selection', `${sel.client} (continued)`);
      col = 0; y = top;
    };
    areas.forEach((area) => {
      need(48);
      const x = colX[col];
      pen(doc, 'Playfair', 'bold', 13, C.maroon);
      doc.text(area.name || 'Selection', x, y);
      doc.setDrawColor(...C.gold); doc.setLineWidth(0.8); doc.line(x, y + 6, x + 40, y + 6);
      y += 24;
      tileItems(area).forEach((it) => {
        need(30);
        const x2 = colX[col];
        pen(doc, 'Poppins', 'bold', 6.8, C.goldDark);
        doc.text(it.role.toUpperCase(), x2, y, { charSpace: 0.6 });
        pen(doc, 'Poppins', 'bold', 9.5, C.ink);
        doc.text(it.pdfName || it.name, x2 + 66, y, { maxWidth: colW - 66 });
        pen(doc, 'Poppins', 'normal', 7.8, C.grey);
        doc.text(tileDetails(it), x2 + 66, y + 11, { maxWidth: colW - 66 });
        y += 28;
      });
      y += 10;
    });
    const notes = (sel.data.notes || '').trim();
    if (notes) {
      pen(doc, 'Poppins', 'normal', 9, C.ink);
      const lines = doc.splitTextToSize(notes, colW - 24);
      need(lines.length * 12 + 40);
      const x = colX[col];
      doc.setFillColor(...C.sand); doc.roundedRect(x, y - 4, colW, lines.length * 12 + 34, 6, 6, 'F');
      pen(doc, 'Poppins', 'bold', 7.5, C.goldDark);
      doc.text('NOTES', x + 12, y + 12, { charSpace: 0.8 });
      pen(doc, 'Poppins', 'normal', 9, C.ink);
      doc.text(lines, x + 12, y + 27);
    }

    // one or more pages per area, three tiles per page in boxes of the same size
    const cardW = 236, gap = 26, picTop = 92, picH = 352;
    let done = 0;
    const total = areas.reduce((s, a) => s + tileItems(a).length, 0);
    for (const [ai, area] of areas.entries()) {
      const tiles = tileItems(area);
      const pages = Math.ceil(tiles.length / 3);
      for (let start = 0; start < tiles.length; start += 3) {
        const sub = `Area ${ai + 1} of ${areas.length}` + (pages > 1 ? `  ·  ${start / 3 + 1}/${pages}` : '');
        page(area.name || 'Selection', sub);
        const group = tiles.slice(start, start + 3);
        const x0 = (PW - (group.length * cardW + (group.length - 1) * gap)) / 2;
        for (const [k, it] of group.entries()) {
          const x = x0 + k * (cardW + gap);
          busy(true, `Making the PDF… picture ${++done} of ${total}`);
          const pic = await pictureData(it.image_path, { portrait: true, aspect: cardW / picH });
          doc.setFillColor(...C.white); doc.rect(x - 6, picTop - 6, cardW + 12, picH + 12, 'F');
          if (pic) doc.addImage(pic.src, 'JPEG', x, picTop, cardW, picH);
          else {
            doc.setFillColor(...C.sand); doc.rect(x, picTop, cardW, picH, 'F');
            pen(doc, 'Poppins', 'normal', 9, C.grey); doc.text('Picture not available', x + cardW / 2, picTop + picH / 2, { align: 'center' });
          }
          doc.setDrawColor(...C.line); doc.setLineWidth(0.6); doc.rect(x - 6, picTop - 6, cardW + 12, picH + 12);
          const ty = picTop + picH + 26;
          pen(doc, 'Poppins', 'bold', 7.5, C.goldDark);
          doc.text(it.role.toUpperCase(), x, ty, { charSpace: 1 });
          pen(doc, 'Playfair', 'bold', 13.5, C.maroon);
          doc.text(doc.splitTextToSize(it.pdfName || it.name, cardW).slice(0, 2), x, ty + 18, { lineHeightFactor: 1.15 });
          pen(doc, 'Poppins', 'normal', 8, C.grey);
          doc.text(tileDetails(it), x, ty + ((it.pdfName || it.name).length > 30 ? 50 : 34), { maxWidth: cardW });
        }
      }
    }

    // closing page
    doc.addPage();
    paint(C.maroon);
    doc.addImage(logoData, 'JPEG', (PW - 170 * LOGO_RATIO) / 2, 80, 170 * LOGO_RATIO, 170);
    pen(doc, 'Playfair', 'bold', 30, C.gold);
    doc.text('Thank You', PW / 2, 312, { align: 'center' });
    pen(doc, 'Poppins', 'normal', 10, C.cream);
    [...(biz.address || []), [biz.phone, biz.email].filter(Boolean).join('   ·   ')].filter(Boolean)
      .forEach((t, i) => doc.text(t, PW / 2, 350 + i * 17, { align: 'center' }));
    pen(doc, 'Poppins', 'normal', 8, C.sand);
    doc.text('Pictures show the tile design; the actual tile can vary slightly in shade from batch to batch.', PW / 2, PH - 42, { align: 'center' });

    pageNumbers(doc, `Garg's Studio  ·  Selection for ${sel.client}`, 2, true);
    await deliver(doc, `${sel.client} - Garg's Studio selection.pdf`);
  } finally {
    busy(false);
  }
}

// ---------- quotation PDF ----------

async function loadBusiness() {
  if (business) return business;
  const { data } = await db.from('app_settings').select('value').eq('key', 'business').maybeSingle();
  business = data?.value || { name: "GARG'S STUDIO", address: [], terms: [], bank: {} };
  return business;
}

async function nextQuoteNo() {
  const now = new Date();
  const fy = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;   // April to March
  const tag = `${String(fy).slice(2)}-${String(fy + 1).slice(2)}`;
  const { data } = await db.from('selections').select('quote_no').like('quote_no', `%/${tag}`);
  const top = Math.max(0, ...(data || []).map((r) => parseInt(r.quote_no, 10) || 0));
  return `${String(top + 1).padStart(2, '0')}/${tag}`;
}

// 1,25,430 -> "Rupees One Lakh Twenty Five Thousand Four Hundred Thirty Only"
function inWords(n) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
    'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (x) => (x < 20 ? ones[x] : tens[Math.floor(x / 10)] + (x % 10 ? ' ' + ones[x % 10] : ''));
  const three = (x) => [x >= 100 ? ones[Math.floor(x / 100)] + ' Hundred' : '', x % 100 ? two(x % 100) : ''].filter(Boolean).join(' ');
  const words = (x) => {
    const parts = [];
    const crore = Math.floor(x / 1e7), lakh = Math.floor(x / 1e5) % 100, thousand = Math.floor(x / 1000) % 100;
    if (crore) parts.push(words(crore) + ' Crore');
    if (lakh) parts.push(two(lakh) + ' Lakh');
    if (thousand) parts.push(two(thousand) + ' Thousand');
    if (x % 1000) parts.push(three(x % 1000));
    return parts.join(' ');
  };
  n = Math.round(Number(n) || 0);
  return `Rupees ${n ? words(n) : 'Zero'} Only`;
}

async function quotationPdf() {
  const rows = sel.data.areas.filter((a) => a.items.length);
  if (!rows.length) return alert('Add at least one tile or item first.');
  if (!sel.quote_no) { sel.quote_no = await nextQuoteNo(); $('sel-quote-no').value = sel.quote_no; }
  if (!(await saveSelection(true))) return;
  busy(true);
  try {
    const biz = await loadBusiness();
    const d = sel.data;
    const doc = await startPdf({});
    const PW = 595, PH = 842, M = 32, R = PW - M, W = R - M, BOTTOM = PH - 48;
    const pics = d.pictures !== false;
    // GST: 'in' = rates already include it, 'split' = show rates before GST and GST on its own line,
    // 'add' = add GST on top of the rates
    const gstMode = d.gst || 'in', gstRate = Number(d.gstRate) || 18;
    const shownRate = (r) => (gstMode === 'split' ? r / (1 + gstRate / 100) : r);
    const fmtDate = (t) => new Date(t).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

    // columns: # | picture | description | boxes | quantity | rate | amount
    const widths = [22, pics ? 50 : 0, 0, 46, 66, 66, 76];
    widths[2] = W - widths.reduce((s, w) => s + w, 0);
    const xs = widths.reduce((acc, w) => [...acc, acc[acc.length - 1] + w], [M]);
    let y = 0;

    // letterhead
    doc.setFillColor(...C.maroon); doc.rect(0, 0, PW, 122, 'F');
    doc.addImage(logoData, 'JPEG', M - 8, 10, 102 * LOGO_RATIO, 102);
    pen(doc, 'Playfair', 'bold', 26, C.gold);
    doc.text('QUOTATION', R, 46, { align: 'right', charSpace: 1 });
    pen(doc, 'Poppins', 'normal', 8, C.cream);
    [...(biz.address || []), biz.phone && `Phone: ${biz.phone}`, biz.email, biz.gstin && `GSTIN: ${biz.gstin}`]
      .filter(Boolean).forEach((t, i) => doc.text(t, R, 64 + i * 11, { align: 'right' }));

    // client and quote details
    y = 146;
    pen(doc, 'Poppins', 'bold', 7.5, C.goldDark);
    doc.text('QUOTATION FOR', M, y, { charSpace: 1 });
    pen(doc, 'Poppins', 'bold', 13, C.ink);
    doc.text(sel.client, M, y + 18, { maxWidth: 300 });
    pen(doc, 'Poppins', 'normal', 8.8, C.grey);
    let cy = y + 32;
    if (d.address) { const a = doc.splitTextToSize(d.address, 300).slice(0, 3); doc.text(a, M, cy); cy += a.length * 11; }
    if (d.phone) { doc.text(`Phone: ${d.phone}`, M, cy); cy += 11; }
    const bx = R - 196;
    doc.setFillColor(...C.cream); doc.roundedRect(bx, y - 14, 196, 64, 6, 6, 'F');
    [['Quote No.', sel.quote_no], ['Date', fmtDate(Date.now())], ['Valid until', fmtDate(Date.now() + 15 * 864e5)]].forEach(([k, v], i) => {
      pen(doc, 'Poppins', 'normal', 8.5, C.grey); doc.text(k, bx + 12, y + 3 + i * 16);
      pen(doc, 'Poppins', 'bold', 8.5, C.ink); doc.text(v, R - 12, y + 3 + i * 16, { align: 'right' });
    });
    y = Math.max(cy, y + 56) + 16;

    const tableHead = () => {
      doc.setFillColor(...C.maroon); doc.rect(M, y, W, 22, 'F');
      pen(doc, 'Poppins', 'bold', 7.5, C.cream);
      const heads = ['#', pics ? 'TILE' : '', 'DESCRIPTION', 'BOXES', 'QUANTITY', gstMode === 'split' ? 'RATE (EX. GST)' : 'RATE', 'AMOUNT'];
      heads.forEach((h, i) => {
        if (!h) return;
        if (i >= 3) doc.text(h, xs[i + 1] - 6, y + 14.5, { align: 'right' });
        else doc.text(h, xs[i] + (i === 0 ? 6 : 6), y + 14.5);
      });
      y += 22;
    };
    const room = (h) => {
      if (y + h <= BOTTOM) return false;
      doc.addPage();
      y = 40;
      return true;
    };
    tableHead();

    let serial = 0, subtotal = 0, withGst = 0, n = 0;
    const count = rows.reduce((s, a) => s + a.items.length, 0);
    for (const area of rows) {
      if (room(24 + 34)) tableHead();
      doc.setFillColor(...C.sand); doc.rect(M, y, W, 24, 'F');
      pen(doc, 'Playfair', 'bold', 11, C.maroon);
      doc.text(area.name || 'Selection', M + 8, y + 16);
      y += 24;
      for (const it of area.items) {
        busy(true, `Making the quotation… ${++n} of ${count}`);
        const tile = it.kind === 'tile';
        const rate = Number(it.rate) || 0;
        const qty = tile ? Number(it.sqft) || 0 : Number(it.qty) || 0;
        const shown = Math.round(shownRate(rate) * 100) / 100;
        const amt = Math.round(qty * shown);
        subtotal += amt;
        withGst += amountOf(it);
        pen(doc, 'Poppins', 'bold', 9, C.ink);
        const name = doc.splitTextToSize(tile ? it.pdfName || it.name : it.desc || '', widths[2] - 12).slice(0, 2);
        const detail = tile ? [tileDetails(it), it.role].filter(Boolean).join('  ·  ') : '';
        pen(doc, 'Poppins', 'normal', 7.5, C.grey);
        const det = detail ? doc.splitTextToSize(detail, widths[2] - 12).slice(0, 2) : [];
        const textH = name.length * 11 + det.length * 9.5;
        const h = Math.max(pics && tile ? 52 : 28, textH + 16);
        if (room(h)) tableHead();
        const mid = y + h / 2;
        pen(doc, 'Poppins', 'normal', 8.5, C.grey);
        doc.text(String(++serial), xs[0] + 6, mid + 3);
        if (pics && tile) {
          const pic = await pictureData(it.thumb_path || it.image_path, { maxSide: 240, aspect: 1 });
          if (pic) doc.addImage(pic.src, 'JPEG', xs[1] + 4, y + (h - 42) / 2, 42, 42);
        }
        let ty = mid - textH / 2 + 8;
        pen(doc, 'Poppins', 'bold', 9, C.ink);
        doc.text(name, xs[2] + 6, ty);
        ty += name.length * 11;
        pen(doc, 'Poppins', 'normal', 7.5, C.grey);
        if (det.length) doc.text(det, xs[2] + 6, ty - 1);
        pen(doc, 'Poppins', 'normal', 8.8, C.ink);
        if (tile && it.boxes) doc.text(String(it.boxes), xs[4] - 6, mid + 3, { align: 'right' });
        if (qty) doc.text(tile ? `${money(qty)} sq ft` : `${qty} ${it.unit || ''}`.trim(), xs[5] - 6, mid + 3, { align: 'right' });
        if (rate) {
          doc.text(rs(shown, shown % 1 ? 2 : 0), xs[6] - 6, mid + (tile ? 0 : 3), { align: 'right' });
          if (tile) { pen(doc, 'Poppins', 'normal', 6.8, C.grey); doc.text('per sq ft', xs[6] - 6, mid + 9, { align: 'right' }); }
        }
        pen(doc, 'Poppins', 'bold', 8.8, C.ink);
        if (amt) doc.text(rs(amt), R - 6, mid + 3, { align: 'right' });
        doc.setDrawColor(...C.line); doc.setLineWidth(0.6); doc.line(M, y + h, R, y + h);
        y += h;
      }
    }
    if (biz.footer_note) {
      room(22);
      pen(doc, 'Poppins', 'normal', 8, C.goldDark);
      doc.text(biz.footer_note, PW / 2, y + 15, { align: 'center', charSpace: 0.5 });
      y += 22;
    }

    // totals
    const labour = Number(d.labour) || 0;
    const gst = gstMode === 'split' ? withGst - subtotal : gstMode === 'add' ? Math.round(subtotal * gstRate / 100) : 0;
    const grand = subtotal + gst + labour;
    const lines = [['Subtotal', subtotal], ...(gstMode !== 'in' ? [[`GST @ ${gstRate}%`, gst]] : []), ...(labour ? [['Labour charges', labour]] : [])];
    room(lines.length * 20 + 70);
    y += 16;
    const tx = R - 220;
    lines.forEach(([k, v]) => {
      pen(doc, 'Poppins', 'normal', 9, C.grey); doc.text(k, tx + 10, y + 13);
      pen(doc, 'Poppins', 'normal', 9, C.ink); doc.text(rs(v), R - 10, y + 13, { align: 'right' });
      doc.setDrawColor(...C.line); doc.line(tx, y + 20, R, y + 20);
      y += 20;
    });
    y += 4;
    doc.setFillColor(...C.maroon); doc.roundedRect(tx, y, 220, 30, 4, 4, 'F');
    pen(doc, 'Poppins', 'bold', 10.5, C.gold); doc.text('Grand Total', tx + 10, y + 19.5);
    doc.text(rs(grand), R - 10, y + 19.5, { align: 'right' });
    const wordsTop = y - lines.length * 20 - 4;
    pen(doc, 'Poppins', 'bold', 7.5, C.goldDark);
    doc.text('AMOUNT IN WORDS', M, wordsTop + 13, { charSpace: 1 });
    pen(doc, 'Poppins', 'normal', 9, C.ink);
    doc.text(doc.splitTextToSize(inWords(grand), tx - M - 24), M, wordsTop + 28);
    if (gstMode === 'in') { pen(doc, 'Poppins', 'normal', 8, C.grey); doc.text('All rates include GST.', M, wordsTop + 56); }
    y += 50;

    // notes, terms and bank details
    const box = (x, w, title, body) => {
      pen(doc, 'Poppins', 'normal', 8.5, C.ink);
      const text = body.flatMap((t) => doc.splitTextToSize(t, w - 24));
      const h = text.length * 11.5 + 36;
      return { h, draw: (top) => {
        doc.setFillColor(...C.cream); doc.roundedRect(x, top, w, h, 6, 6, 'F');
        pen(doc, 'Poppins', 'bold', 7.5, C.goldDark); doc.text(title, x + 12, top + 18, { charSpace: 1 });
        pen(doc, 'Poppins', 'normal', 8.5, C.ink); doc.text(text, x + 12, top + 33);
      } };
    };
    const notes = (d.notes || '').trim();
    if (notes) {
      const b = box(M, W, 'NOTES', notes.split('\n'));
      room(b.h);
      b.draw(y);
      y += b.h + 12;
    }
    const bk = biz.bank || {};
    const terms = box(M, 300, 'TERMS & CONDITIONS', (biz.terms || []).map((t, i) => `${i + 1}. ${t}`));
    const bank = box(M + 312, W - 312, 'BANK DETAILS', [bk.title, bk.name && `Bank: ${bk.name}`, bk.account && `A/c No: ${bk.account}`,
      bk.branch && `Branch: ${bk.branch}`, bk.ifsc && `IFSC: ${bk.ifsc}`].filter(Boolean));
    const h = Math.max(terms.h, bank.h);
    room(h + 100);
    terms.draw(y); bank.draw(y);
    y += h + 26;
    pen(doc, 'Playfair', 'bold', 13, C.maroon);
    doc.text('Thank you for your business!', PW / 2, y, { align: 'center' });
    pen(doc, 'Poppins', 'normal', 8, C.grey);
    doc.text(`For any questions about this quotation, call ${biz.phone || ''}${biz.email ? ' or write to ' + biz.email : ''}.`, PW / 2, y + 15, { align: 'center' });
    y += 30;
    const stripH = W * 59 / 560;
    room(stripH);
    doc.addImage(await staticData('icons/brand-strip.jpg'), 'JPEG', M, Math.max(y, BOTTOM - stripH), W, stripH);

    pageNumbers(doc, `Garg's Studio  ·  Quotation ${sel.quote_no}  ·  ${sel.client}`, 1, false);
    await deliver(doc, `${sel.client} - Quote ${sel.quote_no}.pdf`);
  } finally {
    busy(false);
  }
}

$('sel-pdf').addEventListener('click', () => selectionPdf().catch(() => { busy(false); alert('Could not make the PDF. Check your internet and try again.'); }));
$('sel-quote').addEventListener('click', () => quotationPdf().catch(() => { busy(false); alert('Could not make the quotation. Check your internet and try again.'); }));

$('area-names').innerHTML = AREA_NAMES.map((n) => `<option value="${n}">`).join('');
$('nav-home').addEventListener('click', stopPicking);
