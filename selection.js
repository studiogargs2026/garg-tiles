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
  return { id: null, quote_no: '', client: '', data: { address: '', phone: '', nameStyle: 'real', pictures: true, labour: '', areas: [] } };
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
  show('selections-view');
  $('sel-list').innerHTML = '<li class="muted">Loading…</li>';
  const { data, error } = await db.from('selections').select('id, client, quote_no, updated_at').order('updated_at', { ascending: false }).limit(100);
  if (error) return ($('sel-list').innerHTML = '<li class="error">Could not load. Check your internet.</li>');
  $('sel-list').innerHTML = data.length ? data.map((s) => `<li class="card sel-row"><button data-sel="${s.id}">
      <b>${esc(s.client)}</b><span class="muted">${s.quote_no ? 'Quote ' + esc(s.quote_no) + ' · ' : ''}${new Date(s.updated_at).toLocaleDateString('en-IN')}</span>
    </button></li>`).join('') : '<li class="muted">No selections yet. Tap "New selection" to start one.</li>';
}

$('nav-sel').addEventListener('click', openSelections);
$('sel-new').addEventListener('click', () => { sel = blankSelection(); renderSelection(); show('selection-view'); });
$('sel-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-sel]');
  if (!b) return;
  const { data, error } = await db.from('selections').select('*').eq('id', b.dataset.sel).single();
  if (error) return alert('Could not open this selection.');
  sel = { ...data, data: { ...blankSelection().data, ...data.data } };
  renderSelection();
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
  const it = { kind: 'tile', ...t, offers: offers || [], pick: 0, role: 'Wall', sqft: '', boxes: '', code: null };
  it.rate = Math.round(Number(offerOf(it).selling_price) || 0) || '';
  it.pdfName = sel.data.nameStyle === 'short' ? shortName(it.name) : sel.data.nameStyle === 'code' ? (it.code = newCode()) : it.name;
  area.items.push(it);
  history.back();            // back to the selection (goBack stays put on the search screen)
  renderSelection();
  return true;
};

// ---------- saving ----------

async function saveSelection(quiet) {
  if (!sel.client.trim()) { alert("Please type the client's name first."); return false; }
  const row = { client: sel.client.trim(), quote_no: sel.quote_no || null, data: sel.data, updated_at: new Date().toISOString() };
  const res = sel.id ? await db.from('selections').update(row).eq('id', sel.id).select('id').single()
    : await db.from('selections').insert(row).select('id').single();
  if (res.error) { alert('Could not save. Check your internet and try again.'); return false; }
  sel.id = res.data.id;
  $('sel-delete').hidden = false;
  if (!quiet) flash('Saved');
  return true;
}

function flash(text) {
  $('sel-msg').textContent = text;
  setTimeout(() => ($('sel-msg').textContent = ''), 2500);
}

$('sel-save').addEventListener('click', () => saveSelection());
$('sel-delete').addEventListener('click', async () => {
  if (!confirm(`Delete the selection for ${sel.client}?`)) return;
  const { error } = await db.from('selections').delete().eq('id', sel.id);
  if (error) return alert('Only the person who made it, or an admin, can delete it.');
  goBack();
  openSelections();
});

// ---------- pictures for the PDFs ----------

async function pictureData(path, maxSide = 1400, portrait = false) {
  if (!path) return null;
  const urls = await signedUrls([path]);
  if (!urls[path]) return null;
  try {
    const blob = await (await fetch(urls[path])).blob();
    const bmp = await createImageBitmap(blob);
    let w = bmp.width, h = bmp.height;
    const turn = portrait && w > h * 1.3;          // long tiles stand upright, like on a wall
    const k = Math.min(1, maxSide / Math.max(w, h));
    w = Math.round(w * k); h = Math.round(h * k);
    const c = document.createElement('canvas');
    c.width = turn ? h : w; c.height = turn ? w : h;
    const g = c.getContext('2d');
    if (turn) { g.translate(h, 0); g.rotate(Math.PI / 2); }
    g.drawImage(bmp, 0, 0, w, h);
    return { src: c.toDataURL('image/jpeg', 0.88), w: c.width, h: c.height };
  } catch {
    return null;
  }
}

let logoData = null;
async function staticImage(url) {
  const blob = await (await fetch(url)).blob();
  return new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(blob); });
}

async function deliver(doc, filename) {
  const blob = doc.output('blob');
  const file = new File([blob], filename, { type: 'application/pdf' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
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

// ---------- selection PDF (slides, like the showroom's presentation) ----------

async function selectionPdf() {
  if (!sel.data.areas.some((a) => tileItems(a).length)) return alert('Add at least one tile first.');
  if (!(await saveSelection(true))) return;
  busy(true);
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });   // 792 x 612
    logoData ||= await staticImage('icons/gs-logo.jpg');
    const logo = () => doc.addImage(logoData, 'JPEG', 657, 84, 85, 84);
    const frame = () => {
      doc.setFillColor(0, 0, 0);
      doc.rect(49, 132, 212, 25, 'F'); doc.rect(49, 132, 26, 286, 'F');
      doc.rect(716, 193, 26, 286, 'F'); doc.rect(530, 454, 212, 25, 'F');
      logo();
    };
    const titleSlide = (title, lines, first) => {
      if (!first) doc.addPage();
      frame();
      doc.setTextColor(0, 0, 0);
      doc.setFont('helvetica', 'normal');
      let size = 44;
      doc.setFontSize(size);
      while (doc.getTextWidth(title) > 560 && size > 20) doc.setFontSize(--size);
      doc.text(title, 396, 318, { align: 'center' });
      doc.setFontSize(14);
      lines.forEach((l, i) => doc.text(l, 396, 352 + i * 19, { align: 'center', maxWidth: 560 }));
    };

    titleSlide("GARG'S STUDIO", ['LUXURY', 'Tiles – Bathware – Italian Marble - Windows', '', `Selection for ${sel.client}`], true);
    const areas = sel.data.areas.filter((a) => tileItems(a).length);
    let done = 0;
    const total = areas.reduce((s, a) => s + tileItems(a).length, 0);
    for (const area of areas) {
      const tiles = tileItems(area);
      titleSlide((area.name || 'Selection').toUpperCase(), tiles.map(lineText));
      for (let start = 0; start < tiles.length; start += 3) {
        doc.addPage();
        doc.setFillColor(0, 0, 0);
        doc.rect(31, 84, 15, 444, 'F');
        logo();
        const group = tiles.slice(start, start + 3);
        const colW = 175, gap = 18, x0 = 72;
        for (let k = 0; k < group.length; k++) {
          const it = group[k];
          const x = x0 + k * (colW + gap);
          doc.setFont('helvetica', 'normal'); doc.setFontSize(12); doc.setTextColor(0, 0, 0);
          const label = doc.splitTextToSize(lineText(it), colW);
          doc.text(label.slice(0, 3), x, 165);
          busy(true, `Making the PDF… picture ${++done} of ${total}`);
          const pic = await pictureData(it.image_path, 1400, true);
          if (pic) {
            const maxH = 320, top = 160 + Math.min(label.length, 3) * 15 + 8;
            const k2 = Math.min(colW / pic.w, maxH / pic.h);
            doc.addImage(pic.src, 'JPEG', x, top, pic.w * k2, pic.h * k2);
          }
        }
      }
    }
    titleSlide('THANK-YOU', []);
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

async function quotationPdf() {
  const rows = sel.data.areas.filter((a) => a.items.length);
  if (!rows.length) return alert('Add at least one tile or item first.');
  if (!sel.quote_no) { sel.quote_no = await nextQuoteNo(); $('sel-quote-no').value = sel.quote_no; }
  if (!(await saveSelection(true))) return;
  busy(true);
  try {
    const biz = await loadBusiness();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });   // 612 x 792
    const pics = sel.data.pictures !== false;
    const L = 20, R = 592, W = R - L;
    const cols = pics ? [L, 70, 330, 385, 445, 520, R] : [L, 330, 385, 445, 520, R];   // picture?, description, box, sqft, rate, amount
    const blue = [74, 134, 232], light = [218, 227, 243], grey = [242, 242, 242];
    let y = 0;

    const header = () => {
      doc.setFont('times', 'normal'); doc.setTextColor(46, 117, 182); doc.setFontSize(22);
      doc.text(biz.name || "GARG'S STUDIO", L, 42);
      doc.setTextColor(155, 194, 230); doc.setFont('times', 'bold'); doc.text('QUOTE', 535, 42, { align: 'right' });
      doc.setFont('times', 'normal'); doc.setTextColor(0, 0, 0); doc.setFontSize(10);
      [...(biz.address || []), biz.phone ? `Phone: ${biz.phone}` : '', biz.gstin ? `GSTIN/UIN: ${biz.gstin}` : '']
        .filter(Boolean).forEach((t, i) => doc.text(t, L, 60 + i * 13));
      doc.text(`Number: ${sel.quote_no}`, 440, 60);
      doc.text(`Date: ${new Date().toLocaleDateString('en-IN')}`, 440, 73);
      doc.text(`Valid Until : ${new Date(Date.now() + 15 * 864e5).toLocaleDateString('en-IN')}`, 440, 86);
      doc.setFillColor(...blue); doc.rect(L, 118, 310, 14, 'F');
      doc.setFont('times', 'bold'); doc.text('CUSTOMER', L + 155, 128, { align: 'center' });
      doc.setFont('times', 'normal');
      doc.text(`Name: ${sel.client}`, L, 146);
      if (sel.data.address) doc.text(`Address : ${sel.data.address}`, L, 162);
      if (sel.data.phone) doc.text(`Phone : ${sel.data.phone}`, L, sel.data.address ? 178 : 162);
      y = 190;
      tableHead();
    };
    const tableHead = () => {
      doc.setFillColor(...blue); doc.setDrawColor(0); doc.rect(L, y, W, 15, 'FD');
      doc.setFont('times', 'bold'); doc.setFontSize(10); doc.setTextColor(0, 0, 0);
      const heads = pics ? ['Picture', 'Description', 'No of Box', 'Qty in Sqft', 'Rate/Sqft', 'Amount'] : ['Description', 'No of Box', 'Qty in Sqft', 'Rate/Sqft', 'Amount'];
      heads.forEach((h, i) => doc.text(h, (cols[i] + cols[i + 1]) / 2, y + 11, { align: 'center' }));
      cols.slice(1, -1).forEach((x) => doc.line(x, y, x, y + 15));
      y += 15;
    };
    const room = (h) => {
      if (y + h <= 750) return;
      doc.addPage();
      y = 40;
      tableHead();
    };
    let shade = 0;
    const row = async (cells, it) => {
      const h = pics && it?.kind === 'tile' ? 54 : 26;
      room(h);
      doc.setFillColor(...(shade++ % 2 ? light : grey)); doc.setDrawColor(0);
      doc.rect(L, y, W, h, 'FD');
      cols.slice(1, -1).forEach((x) => doc.line(x, y, x, y + h));
      doc.setFont('times', 'normal'); doc.setFontSize(10); doc.setTextColor(0, 0, 0);
      const off = pics ? 1 : 0;
      const descW = cols[off + 1] - cols[off] - 8;
      const desc = doc.splitTextToSize(cells[0], descW).slice(0, 3);
      doc.text(desc, (cols[off] + cols[off + 1]) / 2, y + h / 2 + 3 - (desc.length - 1) * 5.5, { align: 'center' });
      doc.text(cells[1], cols[off + 2] - 5, y + h / 2 + 3, { align: 'right' });
      doc.text(cells[2], cols[off + 3] - 4, y + h / 2 + 3, { align: 'right' });
      if (cells[3]) { doc.text('Rs.', cols[off + 3] + 4, y + h / 2 + 3); doc.text(cells[3], cols[off + 4] - 5, y + h / 2 + 3, { align: 'right' }); }
      if (cells[4]) { doc.text('Rs.', cols[off + 4] + 4, y + h / 2 + 3); doc.text(cells[4], R - 5, y + h / 2 + 3, { align: 'right' }); }
      if (pics && it?.kind === 'tile') {
        const pic = await pictureData(it.thumb_path || it.image_path, 300);
        if (pic) {
          const k = Math.min(44 / pic.w, (h - 8) / pic.h);
          doc.addImage(pic.src, 'JPEG', L + (50 - pic.w * k) / 2, y + (h - pic.h * k) / 2, pic.w * k, pic.h * k);
        }
      }
      y += h;
    };
    const band = (text) => {
      room(24 + (pics ? 54 : 26));
      doc.setFillColor(...(shade++ % 2 ? light : grey)); doc.setDrawColor(0);
      doc.rect(L, y, W, 22, 'FD');
      doc.setFont('times', 'bold'); doc.setFontSize(11); doc.setTextColor(255, 0, 0);
      doc.text(text.toUpperCase(), L + W / 2, y + 15, { align: 'center' });
      y += 22;
    };

    header();
    let subtotal = 0, n = 0;
    const count = rows.reduce((s, a) => s + a.items.length, 0);
    for (const area of rows) {
      band(area.name || 'Selection');
      for (const it of area.items) {
        busy(true, `Making the quotation… ${++n} of ${count}`);
        const amt = amountOf(it);
        subtotal += amt;
        if (it.kind === 'tile') {
          const rate = Number(it.rate) || 0;
          await row([lineText(it), it.boxes ? Number(it.boxes).toFixed(2) : '', it.sqft ? `${it.sqft} Sqft` : '',
            rate ? rate.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '', amt ? money(amt) : ''], it);
        } else {
          const rate = Number(it.rate) || 0;
          await row([(it.desc || '').toUpperCase(), it.qty ? `${it.qty} ${String(it.unit || '').toUpperCase()}` : '', '',
            rate ? rate.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '', amt ? money(amt) : ''], it);
        }
      }
    }
    if (biz.footer_note) band(biz.footer_note);

    // totals, terms, bank
    const labour = Number(sel.data.labour) || 0;
    room(200);
    y += 22;
    const top = y;
    doc.setTextColor(0, 0, 0); doc.setFontSize(10);
    const tx = 445;
    [['Subtotal', money(subtotal)], ['Labour Charges', labour ? money(labour) : ''], ['Total Amount', money(subtotal + labour)]].forEach(([k, v], i) => {
      doc.setFont('times', i === 2 ? 'bold' : 'normal');
      doc.rect(tx, y, 90, 20); doc.rect(tx + 90, y, R - tx - 90, 20);
      doc.text(k, tx + 45, y + 13, { align: 'center' });
      if (v) { doc.text('Rs.', tx + 94, y + 13); doc.text(v, R - 5, y + 13, { align: 'right' }); }
      y += 20;
    });
    y = top;
    doc.setFillColor(...blue); doc.rect(L, y, 310, 18, 'FD');
    doc.setFont('times', 'bold'); doc.setFontSize(9); doc.text('TERMS AND CONDITIONS', L + 155, y + 12, { align: 'center' });
    y += 18;
    doc.setFont('times', 'normal');
    (biz.terms || []).forEach((t, i) => { doc.rect(L, y, 310, 20); doc.text(`${i + 1}. ${t}`, L + 155, y + 13, { align: 'center', maxWidth: 300 }); y += 20; });
    y += 14;
    const b = biz.bank || {};
    const bank = [`Bank  Details - ${b.title || ''}`, `Bank Name : ${b.name || ''}`, `Account Number : ${b.account || ''}`, `Branch : ${b.branch || ''}`, `IFSC Code : ${b.ifsc || ''}`];
    bank.forEach((t, i) => { doc.setFontSize(i ? 10 : 12); doc.rect(L, y, 310, i ? 15 : 18); doc.text(t, L + 155, y + (i ? 11 : 13), { align: 'center' }); y += i ? 15 : 18; });
    y += 22;
    doc.setFontSize(9);
    doc.text('If you have any questions about this price quote, please contact', L + 155, y, { align: 'center' });
    doc.text(`${biz.phone || ''} - ${biz.email || ''}`, L + 155, y + 13, { align: 'center' });
    doc.setFont('times', 'bolditalic'); doc.setFontSize(11);
    doc.text('Thank You For Your Business!', L + 155, y + 29, { align: 'center' });
    y += 42;
    if (y + 46 > 792) { doc.addPage(); y = 40; }
    const strip = await staticImage('icons/brand-strip.jpg');
    doc.addImage(strip, 'JPEG', L, y, 560, 59);
    await deliver(doc, `${sel.client} - Quote ${sel.quote_no.replace('/', '-')}.pdf`);
  } finally {
    busy(false);
  }
}

$('sel-pdf').addEventListener('click', () => selectionPdf().catch(() => { busy(false); alert('Could not make the PDF. Check your internet and try again.'); }));
$('sel-quote').addEventListener('click', () => quotationPdf().catch(() => { busy(false); alert('Could not make the quotation. Check your internet and try again.'); }));

$('area-names').innerHTML = AREA_NAMES.map((n) => `<option value="${n}">`).join('');
$('nav-home').addEventListener('click', stopPicking);
