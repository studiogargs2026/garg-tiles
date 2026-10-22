// Client selections and quotations: client details, areas, and the tiles chosen for each area
// (wall, floor, highlighter...). A selection makes the selection PDF (one slide per area with the
// tile pictures); a quotation makes the quotation PDF. Either can be copied into the other. Tile names can be shown as they are, shortened, or
// replaced by a code, so the client does not get the exact name.
views.push('selections-view', 'selection-view');

const ROLES = ['Wall', 'Floor', 'Highlighter', 'Slab', 'Other'];
const ROLE_TAG = { Wall: 'WALL', Floor: 'FLOOR', Highlighter: 'HL', Slab: 'SLAB', Other: '' };
const AREA_NAMES = ['Master Washroom', 'Powder Washroom', 'Common Washroom', 'Other Washroom', 'Kitchen Wall & Slab',
  'Living Room', 'Bedroom', 'Guest Room', 'Balcony', 'Staircase', 'All Floor'];
const UNITS = ['Bag', 'Pcs', 'Box', 'Sqft', 'Set', 'Rft'];

let sel = null;              // the selection or quotation being edited
let listKind = 'selection';  // which list is open

function blankSelection(kind) {
  const s = { id: null, quote_no: '', client: '', showroom, data: { address: '', phone: '', nameStyle: 'real', pictures: true, labour: '', notes: '', gst: 'in', gstRate: 18, areas: [] } };
  if (kind) s.data.kind = kind;
  return s;
}

// 'selection' or 'quotation'; ones made before the two were apart count as quotations once numbered
function kindOf(s) {
  return (s?.data?.kind || s?.kind) || (s?.quote_no ? 'quotation' : 'selection');
}
const WORD = { selection: 'selection', quotation: 'quotation' };

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

// the showroom a selection belongs to; selections made before there were two are Garg's Studio
function roomOf(s) {
  return SHOWROOMS[s?.showroom] ? s.showroom : 'gs';
}

function newCode() {
  return SHOWROOMS[roomOf(sel)].code + '-' + String(Math.floor(1000 + Math.random() * 9000));
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

// discount in %, 0 to 100
function discOf(it) {
  return Math.min(100, Math.max(0, Number(it.disc) || 0));
}

function amountOf(it) {
  const qty = it.kind === 'tile' ? Number(it.sqft) : Number(it.qty);
  return Math.round((qty || 0) * (Number(it.rate) || 0) * (1 - discOf(it) / 100));
}

function money(n) {
  return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

// ---------- list of selections ----------

async function openSelections(kind = listKind) {
  listKind = kind;
  if (current === 'selection-view') leftSelection();
  show('selections-view');
  const draft = readDraft();
  const unsaved = draft?.sel && !draft.sel.id && (draft.sel.client || draft.sel.data?.areas?.length);
  $('sel-unsaved').hidden = !unsaved;
  if (unsaved) $('sel-unsaved').textContent = `Continue unfinished ${WORD[kindOf(draft.sel)]}`;
  $('sel-list').innerHTML = '<li class="muted">Loading…</li>';
  $('sel-title').textContent = `${isAdmin ? 'All' : 'My'} ${kind}s`;
  $('sel-new').textContent = `+ New ${kind}`;
  $('sel-admin').hidden = !isAdmin;
  // the database only gives each person their own; admins get everyone's
  const [{ data, error }, people] = await Promise.all([
    db.from('selections').select('id, client, quote_no, updated_at, showroom, created_by, total, kind:data->>kind').order('updated_at', { ascending: false }).limit(1000),
    isAdmin ? staffNames() : {},
  ]);
  if (error) return ($('sel-list').innerHTML = '<li class="error">Could not load. Check your internet.</li>');
  allSelections = data;
  staff = people;
  if (isAdmin) fillPersonFilter();
  showSelectionList();
}

let allSelections = [];
let staff = {};

async function staffNames() {
  const { data } = await db.from('profiles').select('id, full_name, email');
  return Object.fromEntries((data || []).map((p) => [p.id, p.full_name || p.email || 'Unnamed']));
}

function fillPersonFilter() {
  const keep = $('sel-f-person').value;
  const ids = [...new Set(allSelections.map((s) => s.created_by))].sort((a, b) => (staff[a] || '').localeCompare(staff[b] || ''));
  $('sel-f-person').innerHTML = '<option value="">Everyone</option>' + ids.map((id) => `<option value="${esc(id)}">${esc(staff[id] || 'Unknown')}</option>`).join('');
  $('sel-f-person').value = ids.includes(keep) ? keep : '';
}

function showSelectionList() {
  const room = isAdmin ? $('sel-f-room').value : '';
  const person = isAdmin ? $('sel-f-person').value : '';
  const mine = allSelections.filter((s) => (!room || roomOf(s) === room) && (!person || s.created_by === person));
  const rows = mine.filter((s) => kindOf(s) === listKind);
  if (isAdmin) summary(mine);
  const tag = (s) => `<span class="room-tag ${roomOf(s)}">${SHOWROOMS[roomOf(s)].code}</span>`;
  $('sel-list').innerHTML = rows.length ? rows.map((s) => `<li class="card sel-row"><button data-sel="${s.id}">
      <span><b>${esc(s.client)}</b>${isAdmin ? tag(s) : ''}${isAdmin ? `<span class="who">by ${esc(staff[s.created_by] || 'Unknown')}</span>` : ''}</span>
      <span class="muted">${s.quote_no ? 'Quote ' + esc(s.quote_no) + ' · ' : ''}${s.total && listKind === 'quotation' ? '₹' + money(s.total) + ' · ' : ''}${new Date(s.updated_at).toLocaleDateString('en-IN')}</span>
    </button></li>`).join('') : `<li class="muted">${allSelections.some((s) => kindOf(s) === listKind) ? 'Nothing matches these filters.' : `No ${listKind}s yet. Tap "New ${listKind}" to start one.`}</li>`;
}

// admin: how many selections and quotations each person made, and the value quoted
function summary(rows) {
  const by = {};
  for (const s of rows) {
    const k = s.created_by;
    by[k] ||= { sel: 0, quotes: 0, value: 0 };
    if (kindOf(s) === 'quotation') { by[k].quotes++; by[k].value += Number(s.total) || 0; } else by[k].sel++;
  }
  const all = Object.values(by).reduce((t, r) => ({ sel: t.sel + r.sel, quotes: t.quotes + r.quotes, value: t.value + r.value }), { sel: 0, quotes: 0, value: 0 });
  const line = (name, r, cls = '') => `<tr class="${cls}"><td>${esc(name)}</td><td>${r.sel}</td><td>${r.quotes}</td><td>₹${money(r.value)}</td></tr>`;
  $('sel-by-person').innerHTML = '<tr><th>Employee</th><th>Selections</th><th>Quotations</th><th>Quoted value</th></tr>'
    + Object.entries(by).sort((a, b) => b[1].value - a[1].value).map(([id, r]) => line(staff[id] || 'Unknown', r)).join('')
    + (Object.keys(by).length > 1 ? line('Total', all, 'all') : '');
}

['sel-f-room', 'sel-f-person'].forEach((id) => $(id).addEventListener('change', showSelectionList));

$('nav-sel').addEventListener('click', () => openSelections('selection'));
$('nav-quote').addEventListener('click', () => openSelections('quotation'));
$('sel-new').addEventListener('click', () => {
  if (!$('sel-unsaved').hidden && !confirm(`You have an unfinished ${WORD[kindOf(readDraft()?.sel)]} that is not saved online. Start a new one anyway?`)) return;
  sel = blankSelection(listKind);
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
  const quote = kindOf(sel) === 'quotation';
  $('selection-view').querySelector('h1').textContent = `${quote ? 'Quotation' : 'Client selection'} · ${SHOWROOMS[roomOf(sel)].name}`;
  // a selection is about the tiles; rates, labour, GST and terms belong to the quotation
  $('selection-view').classList.toggle('is-selection', !quote);
  ['sel-q-row', 'sel-total', 'q-card', 'sel-quote'].forEach((id) => ($(id).hidden = !quote));
  $('sel-pdf').hidden = quote;
  $('sel-convert').textContent = quote ? 'Make a selection' : 'Make a quotation';
  $('sel-delete').textContent = `Delete this whole ${WORD[kindOf(sel)]}`;
  $('sel-code-eg').textContent = `${SHOWROOMS[roomOf(sel)].code}-4821`;
  $('sel-client').value = sel.client;
  $('sel-address').value = d.address || '';
  $('sel-phone').value = d.phone || '';
  $('sel-quote-no').value = sel.quote_no || '';
  $('sel-labour').value = d.labour || '';
  $('sel-disc-all').value = d.discAll || '';
  $('sel-notes').value = d.notes || '';
  $('sel-gst').value = d.gst || 'in';
  $('sel-gst-rate').value = d.gstRate || 18;
  $('sel-gst-rate-wrap').hidden = (d.gst || 'in') === 'in';
  readyQuote().then(renderQuoteSettings).catch(() => {});
  document.querySelectorAll('[name=sel-names]').forEach((r) => (r.checked = r.value === (d.nameStyle || 'real')));
  showTarget();
  $('sel-areas').innerHTML = d.areas.map((a, ai) => `
    <div class="area card${ai === target ? ' target' : ''}" data-area="${ai}">
      <div class="area-head">
        <input class="area-name" list="area-names" value="${esc(a.name)}" placeholder="Area, e.g. Master Washroom" data-f="area-name">
        <button type="button" class="link danger" data-act="del-area">Remove</button>
      </div>
      <label class="choice add-here"><input type="radio" name="add-here" data-act="target"${ai === target ? ' checked' : ''}> Add products here</label>
      ${a.items.map((it, ii) => itemHtml(it, ii)).join('') || '<p class="muted">No products yet.</p>'}
      <div class="area-actions">
        <button type="button" class="primary small" data-act="add-tile">+ Add product</button>
        <button type="button" class="ghost small" data-act="add-other">+ Product not in the app</button>
      </div>
    </div>`).join('') || '<p class="muted">Add the first area, like "Master Washroom".</p>';
  refreshThumbs();
  updateTotal();
  keepLocal(true);
}

function itemHtml(it, ii) {
  if (it.kind === 'other') {
    return `<div class="item other" data-item="${ii}">
      <div class="item-top">
        <label class="sel-thumb own-photo">${it.photo ? `<img src="${it.photo}" alt="">` : '<span>+ Photo</span>'}<input type="file" accept="image/*" data-f="photo" hidden></label>
        <div class="grow"><b>Product not in the app</b><div class="muted">${it.photo ? 'Tap the picture to change it' : 'Tap "+ Photo" to add a picture'}</div></div>
        <button type="button" class="link danger" data-act="del-item">Remove</button>
      </div>
      <label>Name<input data-f="desc" value="${esc(it.desc)}" placeholder="e.g. Dimond Star (50kg) or Wash basin"></label>
      <div class="qty-row">
        <label>Used as<select data-f="role">${ROLES.map((r) => `<option${r === (it.role || 'Other') ? ' selected' : ''}>${r}</option>`).join('')}</select></label>
        <label class="wide">Size (optional)<input data-f="size" value="${esc(it.size || '')}" placeholder="e.g. 600x600 mm"></label>
      </div>
      <div class="qty-row">
        <label>Qty<input data-f="qty" type="number" inputmode="decimal" value="${esc(it.qty)}"></label>
        <label>Unit<select data-f="unit">${UNITS.map((u) => `<option${u === it.unit ? ' selected' : ''}>${u}</option>`).join('')}</select></label>
        <label class="q-only">Rate ₹<input data-f="rate" type="number" inputmode="decimal" value="${esc(it.rate)}"></label>
      </div>
      <div class="qty-row q-only"><label class="disc">Discount %<input data-f="disc" type="number" inputmode="decimal" value="${esc(it.disc ?? '')}" placeholder="0"></label><span></span></div>
      <div class="muted amount"><span class="q-only">Amount: ₹${money(amountOf(it))}</span></div>
      <button type="button" class="ghost small del-end" data-act="del-item">Delete this product</button>
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
      <label class="wide">Size<select data-f="pick">${it.offers.map((x, k) => [x, k]).sort(([x], [y]) => bySizeDesc(x.size, y.size)).map(([x, k]) => `<option value="${k}"${k === it.pick ? ' selected' : ''}>${esc(x.size || '')}${x.finish ? ' · ' + esc(x.finish) : ''}</option>`).join('')}</select></label>
    </div>
    <label>Name in PDF<input data-f="pdfName" value="${esc(it.pdfName)}"></label>
    <div class="qty-row">
      <label>Sq ft<input data-f="sqft" type="number" inputmode="decimal" value="${esc(it.sqft)}"></label>
      <label>Boxes<input data-f="boxes" type="number" inputmode="numeric" value="${esc(it.boxes)}"></label>
      <label class="q-only">Rate ₹/sq ft<input data-f="rate" type="number" inputmode="decimal" value="${esc(it.rate)}"></label>
    </div>
    <div class="qty-row q-only"><label class="disc">Discount %<input data-f="disc" type="number" inputmode="decimal" value="${esc(it.disc ?? '')}" placeholder="0"></label><span></span></div>
    <div class="muted amount">${chargedBoxSqft(o) ? `${chargedBoxSqft(o)} sq ft per box (charged)` : ''}<span class="q-only">${chargedBoxSqft(o) ? ' · ' : ''}Amount: ₹${money(amountOf(it))}</span></div>
    <button type="button" class="ghost small del-end" data-act="del-item">Delete this product</button>
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

// the quotation's grand total (GST added on top when the quotation adds it), kept for the admin summary
function grandTotal() {
  const d = sel.data;
  const sub = d.areas.flatMap((a) => a.items).reduce((s, it) => s + amountOf(it), 0);
  const gst = d.gst === 'add' ? Math.round(sub * (Number(d.gstRate) || 18) / 100) : 0;
  return sub + gst + (Number(d.labour) || 0);
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
  else if (it && (f === 'desc' || f === 'size')) it[f] = v;
  else if (it && (f === 'rate' || f === 'qty' || f === 'disc')) it[f] = v;
  else return;
  if (itemEl) itemEl.querySelector('.amount').innerHTML = itemEl.querySelector('.amount').innerHTML.replace(/Amount: ₹[\d,]*/, `Amount: ₹${money(amountOf(it))}`);
  updateTotal();
});

$('sel-areas').addEventListener('change', (e) => {
  const f = e.target.dataset.f;
  const { it } = where(e);
  if (!it || !f) return;
  const v = e.target.value;
  if (f === 'photo') return addPhoto(it, e.target.files[0]);
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
  if (act === 'target') { target = ai; return renderSelection(); }
  if (act === 'del-area' && confirm(`Remove "${a.name || 'this area'}" and its products?`)) {
    sel.data.areas.splice(ai, 1);
    if (target >= ai) target = Math.max(0, target - 1);
  } else if (act === 'del-item') a.items.splice(Number(itemEl.dataset.item), 1);
  else if (act === 'add-other') { target = ai; a.items.push({ kind: 'other', desc: '', role: 'Other', size: '', qty: '', unit: 'Pcs', rate: '', photo: null, disc: sel.data.discAll || '' }); }
  else if (act === 'add-tile') { target = ai; return startPicking(ai); }
  else return;
  renderSelection();
});

$('sel-add-area').addEventListener('click', () => {
  sel.data.areas.push({ name: '', items: [] });
  target = sel.data.areas.length - 1;
  renderSelection();
  const names = document.querySelectorAll('.area-name');
  names[names.length - 1]?.focus();
});

[['sel-client', (v) => (sel.client = v)], ['sel-address', (v) => (sel.data.address = v)], ['sel-phone', (v) => (sel.data.phone = v)],
 ['sel-quote-no', (v) => (sel.quote_no = v)], ['sel-labour', (v) => { sel.data.labour = v; updateTotal(); }]]
  .forEach(([id, set]) => $(id).addEventListener('input', (e) => set(e.target.value)));
$('sel-notes').addEventListener('input', (e) => (sel.data.notes = e.target.value));
$('sel-disc-apply').addEventListener('click', () => {
  const v = $('sel-disc-all').value.trim();
  const d = Math.min(100, Math.max(0, Number(v) || 0));
  const items = sel.data.areas.flatMap((a) => a.items);
  if (!items.length) return alert('Add products first.');
  sel.data.discAll = v;
  items.forEach((it) => (it.disc = d || ''));
  renderSelection();
  changed(true);
  flash(d ? `${d}% discount put on all ${items.length} items` : 'Discount taken off all items');
});
$('sel-gst').addEventListener('change', (e) => { sel.data.gst = e.target.value; $('sel-gst-rate-wrap').hidden = e.target.value === 'in'; });
$('sel-gst-rate').addEventListener('input', (e) => (sel.data.gstRate = Number(e.target.value) || 18));
document.querySelectorAll('[name=sel-names]').forEach((r) => r.addEventListener('change', () => { applyNameStyle(r.value); renderSelection(); }));

// ---------- what the quotation shows ----------

// Each quotation keeps its own choices in data.q: heading, columns, parts of the page, the lines
// printed under the list (only ticked ones) and the terms. New quotations start from the
// showroom's usual ones, which admins can change from any quotation.
const Q_COLS = [['serial', 'Sr. no.'], ['pic', 'Tile picture'], ['size', 'Size'], ['finish', 'Finish'], ['role', 'Used as (wall, floor…)'],
  ['boxes', 'Boxes'], ['qty', 'Quantity (sq ft)'], ['rate', 'Rate per sq ft'], ['disc', 'Discount'], ['amount', 'Amount']];
const Q_PARTS = [['dates', 'Date and valid until'], ['areas', 'Area-wise summary'], ['totals', 'Totals and grand total'], ['words', 'Amount in words'],
  ['terms', 'Terms & conditions'], ['bank', 'Bank details'], ['thanks', 'Thank-you line'], ['brands', 'Brand logos strip']];
const allOn = (list) => Object.fromEntries(list.map(([k]) => [k, true]));

function usualQuote(biz) {
  return {
    title: biz.quote_title || 'QUOTATION',
    validDays: biz.valid_days || 15,
    cols: { ...allOn(Q_COLS), ...biz.quote_cols },
    parts: { ...allOn(Q_PARTS), ...biz.quote_parts },
    lines: (biz.lines || [{ text: biz.footer_note || 'Cartage charges will be extra', on: true }, { text: 'All rates include GST', on: false }])
      .map((l) => ({ ...l })),
    terms: [...(biz.terms || [])],
  };
}

// fills data.q from the showroom's usual choices the first time a selection is opened
async function readyQuote() {
  const forSel = sel;
  if (forSel.data.q?.terms) return;
  const biz = await loadBusiness();
  if (sel !== forSel) return;
  const usual = usualQuote(biz);
  const had = sel.data.q || {};
  if (sel.data.pictures === false) usual.cols.pic = false;     // made before pictures became a column
  sel.data.q = { ...usual, ...had, cols: { ...usual.cols, ...had.cols }, parts: { ...usual.parts, ...had.parts } };
  keepLocal(current === 'selection-view' || pickArea !== null);
}

function renderQuoteSettings() {
  const q = sel?.data.q;
  if (!q) return;
  const box = (group, [k, label]) => `<label class="choice"><input type="checkbox" data-${group}="${k}"${q[group === 'col' ? 'cols' : 'parts'][k] ? ' checked' : ''}> ${label}</label>`;
  $('q-title').value = q.title;
  $('q-valid').value = q.validDays;
  $('q-valid-wrap').hidden = !q.parts.dates;
  $('q-cols').innerHTML = Q_COLS.map((c) => box('col', c)).join('');
  $('q-parts').innerHTML = Q_PARTS.filter(([k]) => k !== 'brands' || roomOf(sel) === 'gs').map((c) => box('part', c)).join('');
  $('q-lines').innerHTML = q.lines.map((l, i) => `<div class="q-line${l.on ? '' : ' off'}" data-line="${i}">
      <input type="checkbox" data-f="on"${l.on ? ' checked' : ''} aria-label="Print this line">
      <input type="text" data-f="text" value="${esc(l.text)}" placeholder="e.g. Loading and unloading extra">
      <button type="button" class="link danger" data-act="q-del-line">Remove</button>
    </div>`).join('') || '<p class="muted">No lines.</p>';
  $('q-terms').value = q.terms.join('\n');
  $('q-default').hidden = !isAdmin;
  $('q-default').textContent = `Make these the usual for every new ${SHOWROOMS[roomOf(sel)].name} quotation`;
}

$('q-card').addEventListener('input', (e) => {
  const q = sel?.data.q;
  if (!q) return;
  const t = e.target, line = t.closest('[data-line]');
  if (t.id === 'q-title') q.title = t.value;
  else if (t.id === 'q-valid') q.validDays = Number(t.value) || '';
  else if (t.id === 'q-terms') q.terms = t.value.split('\n');
  else if (line && t.dataset.f === 'text') q.lines[line.dataset.line].text = t.value;
});

$('q-card').addEventListener('change', (e) => {
  const q = sel?.data.q;
  if (!q) return;
  const t = e.target, line = t.closest('[data-line]');
  if (t.dataset.col) {
    q.cols[t.dataset.col] = t.checked;
    if (t.dataset.col === 'pic') sel.data.pictures = t.checked;
  } else if (t.dataset.part) {
    q.parts[t.dataset.part] = t.checked;
    $('q-valid-wrap').hidden = !q.parts.dates;
  } else if (line && t.dataset.f === 'on') {
    q.lines[line.dataset.line].on = t.checked;
    line.classList.toggle('off', !t.checked);
  }
});

$('q-card').addEventListener('click', async (e) => {
  const act = e.target.dataset.act;
  const q = sel?.data.q;
  if (!act || !q) return;
  if (act === 'q-add-line') {
    q.lines.push({ text: '', on: true });
    renderQuoteSettings();
    const boxes = document.querySelectorAll('.q-line input[type=text]');
    boxes[boxes.length - 1]?.focus();
  } else if (act === 'q-del-line') {
    q.lines.splice(Number(e.target.closest('[data-line]').dataset.line), 1);
    renderQuoteSettings();
  } else if (act === 'q-reset') {
    if (!confirm("Put back the showroom's usual terms and lines? Your changes to them in this quotation will go.")) return;
    const usual = usualQuote(await loadBusiness());
    q.terms = usual.terms;
    q.lines = usual.lines;
    renderQuoteSettings();
    changed();
  } else if (act === 'q-default') saveUsualQuote();
});

// admins: this quotation's choices become the showroom's usual ones for new quotations
async function saveUsualQuote() {
  const room = SHOWROOMS[roomOf(sel)];
  if (!confirm(`Every new ${room.name} quotation will start with these columns, terms and lines. Quotations already made stay as they are. Go ahead?`)) return;
  const q = sel.data.q;
  const { data, error: readError } = await db.from('app_settings').select('value').eq('key', room.settings).maybeSingle();
  if (readError) return alert('Could not save. Check your internet and try again.');
  const value = { ...(data?.value || businesses[room.settings] || {}), quote_title: q.title, valid_days: Number(q.validDays) || 15,
    quote_cols: q.cols, quote_parts: q.parts, lines: q.lines.filter((l) => l.text.trim()), terms: q.terms.map((t) => t.trim()).filter(Boolean) };
  const { error } = await db.from('app_settings').upsert({ key: room.settings, value });
  if (error) return alert('Could not save. Only an admin can change the usual terms.');
  businesses[room.settings] = value;
  flash(`Saved as the usual for ${room.name}`);
}

// ---------- adding products from the box at the top ----------

// The ticked area takes every product picked in the box at the top, one after another.
let target = 0;
let targetOf = null;         // the selection `target` belongs to; another one starts at its last area

function showTarget() {
  const areas = sel.data.areas;
  if (targetOf !== sel) { targetOf = sel; target = Math.max(0, areas.length - 1); }
  if (target >= areas.length) target = Math.max(0, areas.length - 1);
  $('qa-where').textContent = areas.length ? `Adding to: ${areas[target].name || `Area ${target + 1}`}` : 'Adding to: a new area';
}

let qaTimer = null;
let qaTurn = 0;
function hideQuick() { $('qa-list').hidden = true; qaTurn++; }

$('qa-q').addEventListener('input', () => {
  clearTimeout(qaTimer);
  const q = $('qa-q').value.trim();
  if (!q) return hideQuick();
  qaTimer = setTimeout(async () => {
    const turn = ++qaTurn;
    const { data } = await db.rpc('suggest_tiles', { q, p_brand: null, p_size: null });
    if (turn !== qaTurn) return;
    if (!data?.length) { $('qa-list').innerHTML = '<li class="muted qa-none">Not found. Use "+ Product not in the app" in the area.</li>'; $('qa-list').hidden = false; return; }
    const urls = await signedUrls(data.map((t) => t.thumb_path));
    if (turn !== qaTurn) return;
    $('qa-list').innerHTML = data.map((t) => `<li><button type="button" data-id="${t.id}">
      ${urls[t.thumb_path] ? `<img src="${urls[t.thumb_path]}" alt="">` : '<span class="dot"></span>'}
      <span><b>${esc(t.name)}</b> <span class="muted">${esc(t.brand)}</span></span></button></li>`).join('');
    $('qa-list').hidden = false;
  }, 200);
});

$('qa-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-id]');
  if (!btn) return;
  hideQuick();
  $('qa-q').value = '';
  $('qa-q').focus();
  if (!sel.data.areas.length) { sel.data.areas.push({ name: '', items: [] }); target = 0; }
  const area = sel.data.areas[target];
  const id = Number(btn.dataset.id);
  const [{ data: t }, { data: offers }] = await Promise.all([
    db.from('tiles').select('id, brand, name, image_path, thumb_path').eq('id', id).single(),
    db.from('offers').select('size, finish, packing, box_sqft, selling_price, unit').eq('tile_id', id).order('size'),
  ]);
  if (!t) return alert('Could not add it. Check your internet.');
  area.items.push(tileItem(t, offers, 'Wall'));
  renderSelection();
  changed(true);
  $('qa-msg').textContent = `Added ${t.name} to ${area.name || `Area ${target + 1}`}`;
});

document.addEventListener('click', (e) => { if (!e.target.closest('.qa-wrap')) hideQuick(); });

// a picture of a product that is not in the app, kept small inside the selection itself
async function addPhoto(it, file) {
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 900 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0, c.width, c.height);
    it.photo = c.toDataURL('image/jpeg', 0.8);
  } catch {
    return alert('Could not read this picture. Try another one.');
  }
  renderSelection();
  changed(true);
}

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
  const it = { kind: 'tile', ...t, offers: sortOffers(offers), pick: 0, role, sqft: '', boxes: '', code: null, disc: sel.data.discAll || '' };
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
  sel = blankSelection('selection');
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

// each person on a shared phone has their own draft
function draftKey() {
  return `${DRAFT_KEY}:${userId}`;
}

function readDraft() {
  try {
    const old = localStorage.getItem(DRAFT_KEY);      // drafts kept before there was one per person
    if (old) { localStorage.setItem(draftKey(), old); localStorage.removeItem(DRAFT_KEY); }
    return JSON.parse(localStorage.getItem(draftKey()));
  } catch { return null; }
}

function keepLocal(open = true) {
  if (!sel) return;
  try { localStorage.setItem(draftKey(), JSON.stringify({ sel, open, at: Date.now() })); } catch { /* private mode */ }
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
  const row = { client: sel.client.trim(), quote_no: sel.quote_no || null, data: sel.data, total: grandTotal(), updated_at: new Date().toISOString() };
  const res = sel.id ? await db.from('selections').update(row).eq('id', sel.id).select('id').single()
    : await db.from('selections').insert({ ...row, showroom: roomOf(sel) }).select('id').single();
  if (res.error) { if (!auto) alert('Could not save. Check your internet and try again.'); return false; }
  sel.id = res.data.id;
  keepLocal(current === 'selection-view' || pickArea !== null);
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
  await openSelections(kindOf(sel));
  renderSelection();
  show('selection-view');
  draftNote('Your unfinished selection was opened again.');
};

$('selection-view').addEventListener('input', changed);
$('selection-view').addEventListener('change', changed);
$('selection-view').addEventListener('click', (e) => { if (e.target.closest('[data-act], #sel-add-area')) changed(); });

$('sel-save').addEventListener('click', () => saveSelection());

// a copy of this selection as a quotation, or of this quotation as a selection; the original stays
$('sel-convert').addEventListener('click', async () => {
  const to = kindOf(sel) === 'quotation' ? 'selection' : 'quotation';
  if (!sel.client.trim()) return alert("Please type the client's name first.");
  if (!(await saveSelection(true))) return;
  const from = kindOf(sel);
  const copy = JSON.parse(JSON.stringify(sel));
  sel = { ...copy, id: null, quote_no: '', data: { ...copy.data, kind: to } };
  if (!(await saveSelection(true))) return;
  listKind = to;
  renderSelection();
  window.scrollTo(0, 0);
  draftNote(`Made from the ${from}. The ${from} is still saved as it was.`);
});
// deletes the whole selection or quotation; one never saved online is only dropped from the phone
$('sel-delete').addEventListener('click', async () => {
  const what = WORD[kindOf(sel)];
  if (!confirm(`Delete this whole ${what}${sel.client.trim() ? ` for ${sel.client.trim()}` : ''}? This cannot be undone.`)) return;
  clearTimeout(autoTimer);
  await saving;              // a save still running would bring it back
  if (sel.id) {
    const { error } = await db.from('selections').delete().eq('id', sel.id);
    if (error) return alert('Only the person who made it, or an admin, can delete it.');
  }
  const d = readDraft();
  if (d?.sel && (!d.sel.id || d.sel.id === sel.id)) try { localStorage.removeItem(draftKey()); } catch { /* ignore */ }
  sel = null;
  goBack();
  openSelections();
});

// ---------- pictures, fonts and colours for the PDFs ----------

// Each showroom's colours, from its logo: main = the logo's background, accent = its lettering
const PALETTES = {
  gs: { main: [82, 1, 28], accent: [255, 183, 115], accentDark: [176, 108, 46], cream: [252, 245, 236],
    sand: [244, 232, 218], ink: [40, 24, 28], grey: [118, 102, 106], line: [230, 214, 200], white: [255, 255, 255] },
  kp: { main: [12, 45, 72], accent: [64, 185, 236], accentDark: [33, 104, 138], cream: [243, 248, 252],
    sand: [224, 238, 247], ink: [18, 32, 44], grey: [96, 110, 122], line: [208, 224, 236], white: [255, 255, 255] },
};
let C = PALETTES.gs;

// A picture cut to the same shape every time (aspect = width / height), so all boxes match.
async function pictureData(path, { maxSide = 1400, portrait = false, aspect = null } = {}) {
  if (!path) return null;
  const urls = path.startsWith('data:') ? { [path]: path } : await signedUrls([path]);
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

let logos = {};
let logoData = null;
let LOGO_RATIO = 1;
let fontFiles = null;
const FONTS = [['Poppins-400.ttf', 'Poppins', 'normal'], ['Poppins-600.ttf', 'Poppins', 'bold'], ['Playfair-700.ttf', 'Playfair', 'bold']];

// Poppins prints the ₹ sign; Playfair (close to the logo's lettering) is for headings only
async function startPdf(options) {
  const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4', ...options });
  fontFiles ||= await Promise.all(FONTS.map(async ([f]) => (await staticData('vendor/fonts/' + f)).split(',')[1]));
  FONTS.forEach(([f, name, style], i) => { doc.addFileToVFS(f, fontFiles[i]); doc.addFont(f, name, style); });
  const room = SHOWROOMS[roomOf(sel)];
  C = PALETTES[roomOf(sel)];
  logoData = logos[room.logo] ||= await staticData(room.logo);
  LOGO_RATIO = room.logoRatio;
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
  if (it.kind === 'other') return it.size || '';
  const o = offerOf(it);
  return [sizeText(o), finishTag(o.finish) && o.finish].filter(Boolean).join('  ·  ');
}

// page numbers from page `from`, leaving out the last page when it is a closing page
function pageNumbers(doc, label, from, skipLast) {
  const n = doc.getNumberOfPages();
  const { width: PW, height: PH } = doc.internal.pageSize;
  for (let i = from; i <= n - (skipLast ? 1 : 0); i++) {
    doc.setPage(i);
    doc.setDrawColor(...C.accent); doc.setLineWidth(0.6);
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

// what the selection PDF shows: tiles, and products not in the app once they have a name
function tileItems(area) {
  return area.items.filter((it) => it.kind === 'tile' || (it.desc || '').trim());
}

function itemName(it) {
  return it.kind === 'tile' ? it.pdfName || it.name : it.desc.trim();
}

function itemPicture(it) {
  return it.kind === 'tile' ? it.image_path : it.photo;
}

// ---------- selection PDF ----------

async function selectionPdf() {
  if (!sel.data.areas.some((a) => tileItems(a).length)) return alert('Add at least one product first.');
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
      doc.setFillColor(...C.main); doc.rect(0, 0, PW, 66, 'F');
      doc.addImage(logoData, 'JPEG', 30, 7, 52 * LOGO_RATIO, 52);
      pen(doc, 'Playfair', 'bold', 21, C.accent);
      doc.text(title, 112, 42, { maxWidth: 520 });
      if (sub) { pen(doc, 'Poppins', 'normal', 9, C.cream); doc.text(sub, PW - 36, 40, { align: 'right' }); }
    };
    const areas = sel.data.areas.filter((a) => tileItems(a).length);

    // cover
    paint(C.main);
    doc.addImage(logoData, 'JPEG', (PW - 240 * LOGO_RATIO) / 2, 54, 240 * LOGO_RATIO, 240);
    doc.setDrawColor(...C.accent); doc.setLineWidth(0.8); doc.line(PW / 2 - 50, 322, PW / 2 + 50, 322);
    pen(doc, 'Playfair', 'bold', 30, C.accent);
    doc.text('Tile Selection', PW / 2, 365, { align: 'center' });
    pen(doc, 'Poppins', 'normal', 13, C.cream);
    doc.text(`Prepared for ${sel.client}`, PW / 2, 395, { align: 'center' });
    pen(doc, 'Poppins', 'normal', 9.5, C.sand);
    doc.text([sel.data.address, today].filter(Boolean).join('   ·   '), PW / 2, 416, { align: 'center', maxWidth: 600 });
    pen(doc, 'Poppins', 'normal', 8.5, C.accent);
    const tagline = biz.tagline ?? (roomOf(sel) === 'gs' ? 'LUXURY TILES   ·   BATHWARE   ·   ITALIAN MARBLE   ·   WINDOWS' : '');
    if (tagline) doc.text(tagline, PW / 2, PH - 42, { align: 'center', charSpace: 1 });

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
      pen(doc, 'Playfair', 'bold', 13, C.main);
      doc.text(area.name || 'Selection', x, y);
      doc.setDrawColor(...C.accent); doc.setLineWidth(0.8); doc.line(x, y + 6, x + 40, y + 6);
      y += 24;
      tileItems(area).forEach((it) => {
        need(30);
        const x2 = colX[col];
        pen(doc, 'Poppins', 'bold', 6.8, C.accentDark);
        doc.text((it.role || 'Other').toUpperCase(), x2, y, { charSpace: 0.6 });
        pen(doc, 'Poppins', 'bold', 9.5, C.ink);
        doc.text(itemName(it), x2 + 66, y, { maxWidth: colW - 66 });
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
      pen(doc, 'Poppins', 'bold', 7.5, C.accentDark);
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
          const pic = await pictureData(itemPicture(it), { portrait: it.kind === 'tile', aspect: cardW / picH });
          doc.setFillColor(...C.white); doc.rect(x - 6, picTop - 6, cardW + 12, picH + 12, 'F');
          if (pic) doc.addImage(pic.src, 'JPEG', x, picTop, cardW, picH);
          else {
            doc.setFillColor(...C.sand); doc.rect(x, picTop, cardW, picH, 'F');
            pen(doc, 'Poppins', 'normal', 9, C.grey); doc.text('Picture not available', x + cardW / 2, picTop + picH / 2, { align: 'center' });
          }
          doc.setDrawColor(...C.line); doc.setLineWidth(0.6); doc.rect(x - 6, picTop - 6, cardW + 12, picH + 12);
          const ty = picTop + picH + 26;
          pen(doc, 'Poppins', 'bold', 7.5, C.accentDark);
          doc.text((it.role || 'Other').toUpperCase(), x, ty, { charSpace: 1 });
          pen(doc, 'Playfair', 'bold', 13.5, C.main);
          doc.text(doc.splitTextToSize(itemName(it), cardW).slice(0, 2), x, ty + 18, { lineHeightFactor: 1.15 });
          pen(doc, 'Poppins', 'normal', 8, C.grey);
          doc.text(tileDetails(it), x, ty + (itemName(it).length > 30 ? 50 : 34), { maxWidth: cardW });
        }
      }
    }

    // closing page
    doc.addPage();
    paint(C.main);
    doc.addImage(logoData, 'JPEG', (PW - 170 * LOGO_RATIO) / 2, 80, 170 * LOGO_RATIO, 170);
    pen(doc, 'Playfair', 'bold', 30, C.accent);
    doc.text('Thank You', PW / 2, 312, { align: 'center' });
    pen(doc, 'Poppins', 'normal', 10, C.cream);
    [...(biz.address || []), [biz.phone, biz.email].filter(Boolean).join('   ·   ')].filter(Boolean)
      .forEach((t, i) => doc.text(t, PW / 2, 350 + i * 17, { align: 'center' }));
    pen(doc, 'Poppins', 'normal', 8, C.sand);
    doc.text('Pictures show the tile design; the actual tile can vary slightly in shade from batch to batch.', PW / 2, PH - 42, { align: 'center' });

    const roomName = SHOWROOMS[roomOf(sel)].name;
    pageNumbers(doc, `${roomName}  ·  Selection for ${sel.client}`, 2, true);
    await deliver(doc, `${sel.client} - ${roomName} selection.pdf`);
  } finally {
    busy(false);
  }
}

// ---------- quotation PDF ----------

// letterhead, bank details and terms of the selection's showroom
const businesses = {};
async function loadBusiness() {
  const room = SHOWROOMS[roomOf(sel)];
  if (businesses[room.settings]) return businesses[room.settings];
  const { data } = await db.from('app_settings').select('value').eq('key', room.settings).maybeSingle();
  return (businesses[room.settings] = data?.value || { name: room.name.toUpperCase(), address: [], terms: [], bank: {} });
}

// 01/26-27, 02/26-27... per showroom and financial year; the database counts everyone's quotes
async function nextQuoteNo() {
  const { data, error } = await db.rpc('next_quote_no', { p_showroom: roomOf(sel) });
  if (error) throw error;
  return data;
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
  await readyQuote();
  if (!sel.quote_no) { sel.quote_no = await nextQuoteNo(); $('sel-quote-no').value = sel.quote_no; }
  if (!(await saveSelection(true))) return;
  busy(true);
  try {
    const biz = await loadBusiness();
    const d = sel.data, q = d.q, show = q.cols, part = q.parts;
    const doc = await startPdf({});
    const PW = 595, PH = 842, M = 32, R = PW - M, W = R - M, BOTTOM = PH - 48;
    // GST: 'in' = rates already include it, 'split' = show rates before GST and GST on its own line,
    // 'add' = add GST on top of the rates
    const gstMode = d.gst || 'in', gstRate = Number(d.gstRate) || 18;
    const shownRate = (r) => (gstMode === 'split' ? r / (1 + gstRate / 100) : r);
    const fmtDate = (t) => new Date(t).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

    // the columns ticked for this quotation; the description takes the room the others leave
    const cols = [['serial', 22, '#'], ['pic', 50, 'TILE'], ['desc', 0, 'DESCRIPTION'], ['size', 74, 'SIZE'], ['boxes', 42, 'BOXES'],
      ['qty', 64, 'QUANTITY'], ['rate', 64, gstMode === 'split' ? 'RATE (EX. GST)' : 'RATE'], ['disc', 40, 'DISC.'], ['amount', 74, 'AMOUNT']]
      .filter(([k]) => k === 'desc' || (show[k] ?? true))
      .filter(([k]) => k !== 'disc' || rows.some((a) => a.items.some((it) => discOf(it)))).map(([k, w, head]) => ({ k, w, head }));
    cols.find((c) => c.k === 'desc').w = W - cols.reduce((s, c) => s + c.w, 0);
    let cx = M;
    for (const c of cols) { c.x = cx; cx += c.w; c.right = cx; }
    const col = Object.fromEntries(cols.map((c) => [c.k, c]));
    const pics = !!col.pic;
    let y = 0;

    // letterhead
    doc.setFillColor(...C.main); doc.rect(0, 0, PW, 122, 'F');
    doc.addImage(logoData, 'JPEG', M - 8, 10, 102 * LOGO_RATIO, 102);
    pen(doc, 'Playfair', 'bold', 26, C.accent);
    doc.text((q.title || '').trim() || 'QUOTATION', R, 46, { align: 'right', charSpace: 1, maxWidth: W - 110 * LOGO_RATIO });
    pen(doc, 'Poppins', 'normal', 8, C.cream);
    [...(biz.address || []), biz.phone && `Phone: ${biz.phone}`, biz.email, biz.gstin && `GSTIN: ${biz.gstin}`]
      .filter(Boolean).forEach((t, i) => doc.text(t, R, 64 + i * 11, { align: 'right' }));

    // client and quote details
    y = 146;
    pen(doc, 'Poppins', 'bold', 7.5, C.accentDark);
    doc.text('QUOTATION FOR', M, y, { charSpace: 1 });
    pen(doc, 'Poppins', 'bold', 13, C.ink);
    doc.text(sel.client, M, y + 18, { maxWidth: 300 });
    pen(doc, 'Poppins', 'normal', 8.8, C.grey);
    let cy = y + 32;
    if (d.address) { const a = doc.splitTextToSize(d.address, 300).slice(0, 3); doc.text(a, M, cy); cy += a.length * 11; }
    if (d.phone) { doc.text(`Phone: ${d.phone}`, M, cy); cy += 11; }
    const bx = R - 196;
    const facts = [['Quote No.', sel.quote_no], ...(part.dates ? [['Date', fmtDate(Date.now())],
      ...(Number(q.validDays) > 0 ? [['Valid until', fmtDate(Date.now() + Number(q.validDays) * 864e5)]] : [])] : [])];
    doc.setFillColor(...C.cream); doc.roundedRect(bx, y - 14, 196, facts.length * 16 + 16, 6, 6, 'F');
    facts.forEach(([k, v], i) => {
      pen(doc, 'Poppins', 'normal', 8.5, C.grey); doc.text(k, bx + 12, y + 3 + i * 16);
      pen(doc, 'Poppins', 'bold', 8.5, C.ink); doc.text(v, R - 12, y + 3 + i * 16, { align: 'right' });
    });
    y = Math.max(cy, y + facts.length * 16 + 8) + 16;

    const tableHead = () => {
      doc.setFillColor(...C.main); doc.rect(M, y, W, 22, 'F');
      pen(doc, 'Poppins', 'bold', 7.5, C.cream);
      for (const c of cols) {
        const h = c.k === 'pic' && !pics ? '' : c.head;
        if (['boxes', 'qty', 'rate', 'amount'].includes(c.k)) doc.text(h, c.right - 6, y + 14.5, { align: 'right' });
        else doc.text(h, c.x + 6, y + 14.5);
      }
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
    const descW = col.desc.w - 12;
    const areaSums = [];
    for (const area of rows) {
      const before = subtotal;
      if (room(24 + 34)) tableHead();
      doc.setFillColor(...C.sand); doc.rect(M, y, W, 24, 'F');
      pen(doc, 'Playfair', 'bold', 11, C.main);
      doc.text(area.name || 'Selection', M + 8, y + 16);
      y += 24;
      for (const it of area.items) {
        busy(true, `Making the quotation… ${++n} of ${count}`);
        const tile = it.kind === 'tile';
        const o = tile ? offerOf(it) : {};
        const rate = Number(it.rate) || 0;
        const qty = tile ? Number(it.sqft) || 0 : Number(it.qty) || 0;
        // with the discount column the rate is before discount; without it, the rate already has it taken off
        const d = discOf(it);
        const net = Math.round(shownRate(rate) * (1 - d / 100) * 100) / 100;
        const shown = col.disc ? Math.round(shownRate(rate) * 100) / 100 : net;
        const amt = Math.round(qty * net);
        subtotal += amt;
        withGst += amountOf(it);
        pen(doc, 'Poppins', 'bold', 9, C.ink);
        const name = doc.splitTextToSize(tile ? it.pdfName || it.name : it.desc || '', descW).slice(0, 2);
        const detail = [tile && show.finish && finishTag(o.finish) && o.finish, show.role && !(it.kind === 'other' && it.role === 'Other') && it.role].filter(Boolean).join('  ·  ');
        pen(doc, 'Poppins', 'normal', 7.5, C.grey);
        const det = detail ? doc.splitTextToSize(detail, descW).slice(0, 2) : [];
        const sizeLine = tile ? sizeText(o) : (it.size || '').trim();
        const size = col.size && sizeLine ? doc.splitTextToSize(sizeLine, col.size.w - 10).slice(0, 3) : [];
        const picPath = tile ? it.thumb_path || it.image_path : it.photo;
        const textH = name.length * 11 + det.length * 9.5;
        const h = Math.max(pics && picPath ? 52 : 28, textH + 16, size.length * 9.5 + 16);
        if (room(h)) tableHead();
        const mid = y + h / 2;
        if (col.serial) { pen(doc, 'Poppins', 'normal', 8.5, C.grey); doc.text(String(++serial), col.serial.x + 6, mid + 3); }
        if (pics && picPath) {
          const pic = await pictureData(picPath, { maxSide: 240, aspect: 1 });
          if (pic) doc.addImage(pic.src, 'JPEG', col.pic.x + 4, y + (h - 42) / 2, 42, 42);
        }
        let ty = mid - textH / 2 + 8;
        pen(doc, 'Poppins', 'bold', 9, C.ink);
        doc.text(name, col.desc.x + 6, ty);
        ty += name.length * 11;
        pen(doc, 'Poppins', 'normal', 7.5, C.grey);
        if (det.length) doc.text(det, col.desc.x + 6, ty - 1);
        if (size.length) { pen(doc, 'Poppins', 'normal', 7.8, C.ink); doc.text(size, col.size.x + 6, mid - (size.length * 9.5) / 2 + 7); }
        pen(doc, 'Poppins', 'normal', 8.8, C.ink);
        if (col.boxes && tile && it.boxes) doc.text(String(it.boxes), col.boxes.right - 6, mid + 3, { align: 'right' });
        if (col.qty && qty) doc.text(tile ? `${money(qty)} sq ft` : `${qty} ${it.unit || ''}`.trim(), col.qty.right - 6, mid + 3, { align: 'right' });
        if (col.rate && rate) {
          doc.text(rs(shown, shown % 1 ? 2 : 0), col.rate.right - 6, mid + (tile ? 0 : 3), { align: 'right' });
          if (tile) { pen(doc, 'Poppins', 'normal', 6.8, C.grey); doc.text('per sq ft', col.rate.right - 6, mid + 9, { align: 'right' }); }
        }
        pen(doc, 'Poppins', 'normal', 8.8, C.ink);
        if (col.disc && d) doc.text(`${d}%`, col.disc.right - 6, mid + 3, { align: 'right' });
        pen(doc, 'Poppins', 'bold', 8.8, C.ink);
        if (col.amount && amt) doc.text(rs(amt), R - 6, mid + 3, { align: 'right' });
        doc.setDrawColor(...C.line); doc.setLineWidth(0.6); doc.line(M, y + h, R, y + h);
        y += h;
      }
      areaSums.push([area.name || 'Selection', subtotal - before]);
    }

    // the ticked lines, e.g. "Cartage charges will be extra"
    for (const l of q.lines.filter((x) => x.on && x.text.trim())) {
      pen(doc, 'Poppins', 'normal', 8.5, C.accentDark);
      const t = doc.splitTextToSize(l.text.trim(), W - 40);
      room(t.length * 11 + 8);
      doc.text(t, PW / 2, y + 15, { align: 'center', charSpace: 0.3 });
      y += t.length * 11 + 8;
    }
    y += 4;

    // each area's total, when the quotation has more than one area
    if (part.areas && areaSums.length > 1) {
      const sw = 300, sx = R - sw;
      room(areaSums.length * 20 + 50);
      y += 10;
      doc.setFillColor(...C.sand); doc.rect(sx, y, sw, 22, 'F');
      pen(doc, 'Poppins', 'bold', 7.5, C.accentDark);
      doc.text('AREA-WISE SUMMARY', sx + 10, y + 14.5, { charSpace: 1 });
      doc.text('AMOUNT', R - 10, y + 14.5, { align: 'right', charSpace: 1 });
      y += 22;
      areaSums.forEach(([name, sum]) => {
        pen(doc, 'Poppins', 'normal', 9, C.ink); doc.text(name, sx + 10, y + 13.5, { maxWidth: sw - 110 });
        doc.text(rs(sum), R - 10, y + 13.5, { align: 'right' });
        doc.setDrawColor(...C.line); doc.line(sx, y + 20, R, y + 20);
        y += 20;
      });
      y += 6;
    }

    // totals
    const labour = Number(d.labour) || 0;
    const gst = gstMode === 'split' ? withGst - subtotal : gstMode === 'add' ? Math.round(subtotal * gstRate / 100) : 0;
    const grand = subtotal + gst + labour;
    const words = (top, width) => {
      pen(doc, 'Poppins', 'bold', 7.5, C.accentDark);
      doc.text('AMOUNT IN WORDS', M, top + 13, { charSpace: 1 });
      pen(doc, 'Poppins', 'normal', 9, C.ink);
      doc.text(doc.splitTextToSize(inWords(grand), width), M, top + 28);
    };
    if (part.totals) {
      const lines = [['Subtotal', subtotal], ...(gstMode !== 'in' ? [[`GST @ ${gstRate}%`, gst]] : []), ...(labour ? [['Labour charges', labour]] : [])];
      room(lines.length * 20 + 50);
      y += 12;
      const tx = R - 220;
      const top = y;
      lines.forEach(([k, v]) => {
        pen(doc, 'Poppins', 'normal', 9, C.grey); doc.text(k, tx + 10, y + 13);
        pen(doc, 'Poppins', 'normal', 9, C.ink); doc.text(rs(v), R - 10, y + 13, { align: 'right' });
        doc.setDrawColor(...C.line); doc.line(tx, y + 20, R, y + 20);
        y += 20;
      });
      y += 4;
      doc.setFillColor(...C.main); doc.roundedRect(tx, y, 220, 30, 4, 4, 'F');
      pen(doc, 'Poppins', 'bold', 10.5, C.accent); doc.text('Grand Total', tx + 10, y + 19.5);
      doc.text(rs(grand), R - 10, y + 19.5, { align: 'right' });
      if (part.words) words(top, tx - M - 24);
      y += 50;
    } else if (part.words) {
      room(50);
      words(y + 6, W);
      y += 54;
    } else y += 12;

    // notes, terms and bank details
    const box = (x, w, title, body) => {
      pen(doc, 'Poppins', 'normal', 8.5, C.ink);
      const text = body.flatMap((t) => doc.splitTextToSize(t, w - 24));
      const h = text.length * 11.5 + 36;
      return { h, draw: (top) => {
        doc.setFillColor(...C.cream); doc.roundedRect(x, top, w, h, 6, 6, 'F');
        pen(doc, 'Poppins', 'bold', 7.5, C.accentDark); doc.text(title, x + 12, top + 18, { charSpace: 1 });
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
    const termList = part.terms ? q.terms.map((t) => t.trim()).filter(Boolean) : [];
    const bankList = part.bank ? [bk.title, bk.name && `Bank: ${bk.name}`, bk.account && `A/c No: ${bk.account}`,
      bk.branch && `Branch: ${bk.branch}`, bk.ifsc && `IFSC: ${bk.ifsc}`, bk.upi && `UPI: ${bk.upi}`].filter(Boolean) : [];
    const both = termList.length && bankList.length;
    const blocks = [
      termList.length && box(M, both ? 300 : W, 'TERMS & CONDITIONS', termList.map((t, i) => `${i + 1}. ${t}`)),
      bankList.length && box(both ? M + 312 : M, both ? W - 312 : W, 'BANK DETAILS', bankList),
    ].filter(Boolean);
    if (blocks.length) {
      const h = Math.max(...blocks.map((b) => b.h));
      room(h + (part.thanks ? 60 : 10));
      blocks.forEach((b) => b.draw(y));
      y += h + 26;
    }
    if (part.thanks) {
      room(40);
      pen(doc, 'Playfair', 'bold', 13, C.main);
      doc.text('Thank you for your business!', PW / 2, y, { align: 'center' });
      pen(doc, 'Poppins', 'normal', 8, C.grey);
      doc.text(`For any questions about this quotation, call ${biz.phone || ''}${biz.email ? ' or write to ' + biz.email : ''}.`, PW / 2, y + 15, { align: 'center' });
      y += 30;
    }
    // strip of the brands Garg's Studio sells; KP Enterprises gets its own when Kirti sends it
    if (part.brands && roomOf(sel) === 'gs') {
      const stripH = W * 59 / 560;
      room(stripH);
      doc.addImage(await staticData('icons/brand-strip.jpg'), 'JPEG', M, Math.max(y, BOTTOM - stripH), W, stripH);
    }

    pageNumbers(doc, `${SHOWROOMS[roomOf(sel)].name}  ·  Quotation ${sel.quote_no}  ·  ${sel.client}`, 1, false);
    await deliver(doc, `${sel.client} - Quote ${sel.quote_no}.pdf`);
  } finally {
    busy(false);
  }
}

$('sel-pdf').addEventListener('click', () => selectionPdf().catch(() => { busy(false); alert('Could not make the PDF. Check your internet and try again.'); }));
$('sel-quote').addEventListener('click', () => quotationPdf().catch(() => { busy(false); alert('Could not make the quotation. Check your internet and try again.'); }));

$('area-names').innerHTML = AREA_NAMES.map((n) => `<option value="${n}">`).join('');
$('nav-home').addEventListener('click', stopPicking);
