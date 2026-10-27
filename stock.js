// Daily stock. An admin uploads each showroom's stock PDF (Admin screen); the phone reads the rows
// with pdf.js and the database matches every stock name to a catalog tile (upload_stock in
// supabase/stock.sql). Names it is unsure about are listed for the admin to confirm once. Staff see
// Garg + KP stock together on the Stock screen and on each tile, and can make a stock PDF with pictures.
views.push('stock-view');

const ROOM_SHORT = { gs: 'Garg', kp: 'KP' };

function boxesText(n) {
  const v = Number(n || 0);
  return v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function dayText(at) {
  return at ? new Date(at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : 'not uploaded yet';
}

// ---------- reading a stock PDF on the phone ----------

let pdfjs = null;
async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import(new URL('vendor/pdfjs/pdf.min.mjs', location.href).href);
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.mjs', location.href).href;
  return pdfjs;
}

// every line of text in the PDF, as cells {text, x0, x1} from left to right
async function pdfRows(file) {
  const lib = await loadPdfjs();
  const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const rows = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const { items } = await page.getTextContent();
    const lines = [];
    for (const it of items) {
      const text = it.str.trim();
      if (!text) continue;
      const y = it.transform[5], x0 = it.transform[4];
      let line = lines.find((l) => Math.abs(l.y - y) <= Math.max(2.5, it.height * 0.4));
      if (!line) lines.push((line = { y, cells: [] }));
      line.cells.push({ text, x0, x1: x0 + it.width });
    }
    lines.sort((a, b) => b.y - a.y);
    for (const l of lines) {
      l.cells.sort((a, b) => a.x0 - b.x0);
      // pieces of one word or phrase printed close together become one cell
      const merged = [];
      for (const c of l.cells) {
        const last = merged[merged.length - 1];
        if (last && c.x0 - last.x1 < 3) { last.text += (c.x0 - last.x1 > 0.8 ? ' ' : '') + c.text; last.x1 = c.x1; }
        else merged.push({ ...c });
      }
      rows.push(merged);
    }
  }
  return rows;
}

const NUM = /^-?\d{1,3}(,\d{2,3})*(\.\d+)?$|^-?\d+(\.\d+)?$/;
const QTY_HEAD = /\b(box(es)?|bxs?|qty|quantity|stock|closing|balance|bal\.?|in hand)\b/i;
const NAME_HEAD = /\b(item|items|description|particulars?|product|design|name)\b/i;
const SKIP_ROW = /\b(total|grand total|page \d|printed on|opening|report)\b/i;

function numberIn(text) {
  const m = /^(-?[\d,]+(\.\d+)?)\s*(box(es)?|bx|bxs|nos?|pcs)?\.?$/i.exec(text.trim());
  return m && NUM.test(m[1]) ? Number(m[1].replace(/,/g, '')) : null;
}

// [{name, boxes}] from the PDF rows: the quantity column is found from its heading ("Boxes",
// "Qty", "Closing"...); without a heading, the last number in each row is taken.
function stockLines(rows) {
  let qtyX = null;
  let nameX = null;
  for (const r of rows.slice(0, 40)) {
    // "Closing Qty" beats "Pcs/Box"; with two equal headings the one furthest right wins
    const heads = r.filter((c) => QTY_HEAD.test(c.text) && !NUM.test(c.text));
    const rank = (c) => (/closing|balance|bal\b|stock|in hand/i.test(c.text) ? 2 : /qty|quantity/i.test(c.text) ? 1 : 0);
    const q = heads.sort((a, b) => rank(b) - rank(a) || b.x0 - a.x0)[0];
    if (q && r.length > 1) {
      qtyX = (q.x0 + q.x1) / 2;
      const n = r.find((c) => NAME_HEAD.test(c.text));
      nameX = n ? n.x0 : null;
      break;
    }
  }
  const out = [];
  for (const r of rows) {
    if (r.some((c) => SKIP_ROW.test(c.text)) || r.some((c) => QTY_HEAD.test(c.text) && !numberIn(c.text))) continue;
    const nums = r.map((c, i) => ({ i, c, v: numberIn(c.text) })).filter((n) => n.v !== null);
    if (!nums.length) continue;
    let qty;
    if (qtyX !== null) {
      qty = nums.reduce((best, n) => (Math.abs((n.c.x0 + n.c.x1) / 2 - qtyX) < Math.abs((best.c.x0 + best.c.x1) / 2 - qtyX) ? n : best));
      if (Math.abs((qty.c.x0 + qty.c.x1) / 2 - qtyX) > 60) continue;
    } else {
      qty = nums[nums.length - 1];
    }
    // the name is the text before the quantity, without a serial number at the start
    let cells = r.slice(0, qty.i).filter((c) => numberIn(c.text) === null || /x/i.test(c.text));
    if (nameX !== null) cells = cells.filter((c) => c.x1 >= nameX - 4);
    const name = cells.map((c) => c.text).join(' ').replace(/^\d+[.)]?\s+/, '').trim();
    if (name.length < 3 || !/[a-z]/i.test(name)) continue;
    out.push({ name, boxes: qty.v });
  }
  return out;
}

// ---------- reading a stock Excel (.xlsx) on the phone ----------
// An .xlsx file is a zip of XML files. The day-by-day stock register is big (45 MB of XML for
// 1,400 columns), so only the name columns and the last stock column are kept.

async function zipFiles(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);
  let end = buf.length - 22;
  while (end >= 0 && dv.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip');
  const files = {};
  let p = dv.getUint32(end + 16, true);
  for (let n = dv.getUint16(end + 10, true); n > 0; n--) {
    const nameLen = dv.getUint16(p + 28, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    files[name] = { method: dv.getUint16(p + 10, true), size: dv.getUint32(p + 20, true), at: dv.getUint32(p + 42, true) };
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  const text = async (name) => {
    const f = files[name];
    if (!f) return '';
    const start = f.at + 30 + dv.getUint16(f.at + 26, true) + dv.getUint16(f.at + 28, true);
    const raw = buf.subarray(start, start + f.size);
    if (f.method === 0) return new TextDecoder().decode(raw);
    return new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  };
  return { files, text };
}

function xmlText(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => (e[0] === '#'
    ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
    : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()]));
}

function colNumber(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}

// the first sheet's rows as [{col: value}], keeping only the columns keep(col) says yes to
async function sheetRows(file) {
  const zip = await zipFiles(file);
  const book = await zip.text('xl/workbook.xml');
  const rid = (/<sheet\b[^>]*\br:id="([^"]+)"/.exec(book) || [])[1];
  const rels = await zip.text('xl/_rels/workbook.xml.rels');
  const target = (new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)
    || new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels) || [])[1] || 'worksheets/sheet1.xml';
  const sheetPath = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
  const shared = [];
  for (const m of (await zip.text('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    shared.push(xmlText([...m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  }
  return { xml: await zip.text(sheetPath), shared };
}

function* cellsOf(rowXml, shared, keep) {
  for (const m of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const ref = /\br="([A-Z]+)\d+"/.exec(m[1]);
    if (!ref || !m[2]) continue;
    const col = colNumber(ref[1]);
    if (keep && !keep(col)) continue;
    const type = (/\bt="(\w+)"/.exec(m[1]) || [])[1];
    let v = type === 'inlineStr' ? (/<t[^>]*>([\s\S]*?)<\/t>/.exec(m[2]) || [])[1] : (/<v>([\s\S]*?)<\/v>/.exec(m[2]) || [])[1];
    if (v === undefined) continue;
    if (type === 's') v = shared[Number(v)];
    else if (type === 'str' || type === 'inlineStr') v = xmlText(v);
    else if (type !== 'b' && type !== 'e' && v !== '' && !isNaN(v)) v = Number(v);
    if (typeof v === 'string') v = v.trim();
    if (v !== '' && v != null) yield [col, v];
  }
}

const ITEM_HEAD = /^(item|items|item name|item description|description|particulars?|product|design|name|tile name)\b/i;
const STOCK_HEAD = /stock|closing|balance|\bqty\b|quantity|boxes/i;
// not tiles: grout, adhesive (ARDEX-ENDURA GOLD STAR 20KG), plywood, display stands, samples, basins
const NOT_TILE = /grout|laticrete|latricate|adhes|epoxy|ardex|sika|\d\s*kg\b|kathi|brick|\bply\b|display stand|protector|\bsample\s*$|cabinet|basin|mirror/i;

// boxes from a cell: 45, "58(2pc)" and "8 BOX(7 PC)" are boxes; "6PC" or "2-4PC" are loose pieces
function boxesIn(v) {
  if (typeof v === 'number') return v;
  if (/^\s*[\d.\-]+\s*pcs?\b/i.test(v)) return null;
  const m = /^\s*(\d+(\.\d+)?)/.exec(v);
  return m ? Number(m[1]) : null;
}

// {lines: [{name, boxes}], date}. Built for the day-by-day register (ITEM, then OUT / IN / STOCK
// columns for every day, the newest on the right; the size and brand in the column before ITEM or
// in a heading row), and for a plain list with a name column and a stock column.
async function excelLines(file) {
  const { xml, shared } = await sheetRows(file);
  const rowXml = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((m) => m[1]);
  let head = -1, itemCol = 0, candidates = [], heads = {};
  for (let r = 0; r < Math.min(15, rowXml.length) && head < 0; r++) {
    const cells = [...cellsOf(rowXml[r], shared)];
    const item = cells.find(([, v]) => typeof v === 'string' && ITEM_HEAD.test(v));
    if (!item) continue;
    head = r;
    itemCol = item[0];
    candidates = cells.filter(([c, v]) => c > itemCol && typeof v === 'string' && STOCK_HEAD.test(v)).map(([c]) => c);
    heads = Object.fromEntries(cells);
  }
  if (head < 0) throw new Error('no ITEM heading');
  // the newest stock column is the rightmost one that has numbers in it
  const last = candidates.slice(-8);
  const keep = (c) => c <= itemCol || last.includes(c);
  const rows = rowXml.slice(head + 1).map((x) => Object.fromEntries(cellsOf(x, shared, keep)));
  const qtyCol = [...last].reverse().find((c) => rows.filter((r) => typeof r[c] === 'number').length >= 5) ?? last[last.length - 1];
  const dateHead = [heads[qtyCol - 1], heads[qtyCol - 2], heads[qtyCol]].find((h) => /\d{1,2}[-./]\d{1,2}[-./]\d{2,4}/.test(h || ''));
  const date = dateHead ? /\d{1,2}[-./]\d{1,2}[-./]\d{2,4}/.exec(dateHead)[0] : '';
  const groupCol = itemCol - 1;
  const out = [];
  let heading = '';
  for (const r of rows) {
    const item = String(r[itemCol] ?? '').trim();
    const group = groupCol > 0 ? String(r[groupCol] ?? '').trim() : '';
    const q = r[qtyCol];
    if (!item) continue;
    if (!group && (q === undefined || q === '')) { heading = item; continue; }   // a heading like "600X300 RAK"
    const boxes = q === undefined ? null : boxesIn(q);
    if (!(boxes > 0)) continue;
    const name = `${group || heading} ${item}`.replace(/\s+/g, ' ').trim();
    if (NOT_TILE.test(name)) continue;
    out.push({ name, boxes });
  }
  return { lines: out, date };
}

// ---------- admin: upload and check names ----------

let pending = null;      // {room, file, lines} read from a PDF or Excel file, waiting for Save

async function loadUploads() {
  const { data } = await db.rpc('stock_filters');
  const up = data?.uploads || {};
  for (const room of ['gs', 'kp']) {
    const u = up[room];
    $(`stock-last-${room}`).textContent = u ? `Last: ${dayText(u.at)} · ${u.lines} lines · ${boxesText(u.boxes)} boxes` : 'Not uploaded yet';
  }
  return data;
}

const STOCK_POINT = { gs: 'Garg', kp: 'KP' };

function isExcel(file) {
  return /\.xlsx$/i.test(file.name) || /spreadsheetml/.test(file.type);
}

document.querySelectorAll('.stock-file').forEach((input) => input.addEventListener('change', async () => {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  const room = input.dataset.room;
  $('stock-msg').textContent = `Reading ${file.name}… a big Excel file can take up to a minute.`;
  $('stock-preview').hidden = true;
  if (/\.xls$/i.test(file.name)) {
    $('stock-msg').textContent = 'This is an old Excel file (.xls). Open it in Excel and save it as .xlsx, then upload that.';
    return;
  }
  try {
    const { lines, date } = isExcel(file) ? await excelLines(file) : { lines: stockLines(await pdfRows(file)), date: '' };
    if (!lines.length) {
      $('stock-msg').textContent = 'No stock lines found in this file. Please send it to Claude so the app can learn its layout.';
      return;
    }
    pending = { room, file: file.name + (date ? ` (stock of ${date})` : ''), lines };
    const total = lines.reduce((s, l) => s + l.boxes, 0);
    $('stock-msg').textContent = '';
    $('stock-preview-head').textContent = `${STOCK_POINT[room]} stock${date ? ' of ' + date : ''}: ${lines.length} tiles in stock, `
      + `${boxesText(total)} boxes in total. Do these look right?`;
    $('stock-preview-rows').innerHTML = lines.slice(0, 12).map((l) => `<tr><td>${esc(l.name)}</td><td>${boxesText(l.boxes)}</td></tr>`).join('')
      + (lines.length > 12 ? `<tr><td class="muted">and ${lines.length - 12} more…</td><td></td></tr>` : '');
    $('stock-preview').hidden = false;
  } catch (e) {
    $('stock-msg').textContent = 'Could not read this file. Check it opens on the phone, then try again.';
  }
}));

$('stock-cancel').addEventListener('click', () => { pending = null; $('stock-preview').hidden = true; });

$('stock-save').addEventListener('click', async () => {
  if (!pending) return;
  const { room, file, lines } = pending;
  $('stock-save').disabled = true;
  let res = null;
  try {
    // sent in parts so a long stock list never times out
    for (let i = 0; i < lines.length; i += 80) {
      $('stock-msg').textContent = `Saving and matching names… ${Math.min(i + 80, lines.length)} of ${lines.length}`;
      const { data, error } = await db.rpc('upload_stock', { p_showroom: room, p_file: file, p_lines: lines.slice(i, i + 80), p_first: i === 0 });
      if (error) throw error;
      res = data;
    }
    pending = null;
    $('stock-preview').hidden = true;
    const others = res.sure - res.matched;      // other brands, kept as written
    $('stock-msg').textContent = `${STOCK_POINT[room]} stock saved: ${res.lines} tiles, ${boxesText(res.boxes)} boxes. `
      + `${res.matched} matched to tiles in the app.` + (res.unsure ? ` ${res.unsure} names need your check below.` : '')
      + (others > 0 ? ` ${others} are brands not in the app; they show with the name from your file.` : '');
    loadUploads();
    loadReview();
    loadMissing();
  } catch (e) {
    $('stock-msg').textContent = 'Could not save the stock: ' + (e.message || 'check your internet and try again.');
  } finally {
    $('stock-save').disabled = false;
  }
});

let reviewRows = [];

async function loadReview() {
  const { data } = await db.rpc('stock_review');
  reviewRows = data || [];
  $('stock-review-head').textContent = reviewRows.length
    ? `${reviewRows.length} stock name${reviewRows.length > 1 ? 's' : ''} to check. Tell the app once and it remembers for every day.`
    : 'All stock names are matched.';
  const urls = await signedUrls(reviewRows.map((r) => r.guess_thumb));
  $('stock-review').innerHTML = reviewRows.slice(0, 50).map((r, i) => `
    <li class="card pad review" data-i="${i}">
      <div><b>${esc(r.raw_name)}</b> <span class="muted">${boxesText(r.boxes)} boxes · ${r.showrooms.split(',').map((s) => ROOM_SHORT[s]).join(' + ')}</span></div>
      ${r.guess_id ? `<div class="guess">${urls[r.guess_thumb] ? `<img src="${urls[r.guess_thumb]}" alt="">` : '<span class="dot"></span>'}
        <span>Is it <b>${esc(r.guess_name)}</b> <span class="muted">${esc(r.guess_brand)}</span>?</span></div>` : '<div class="muted">No close name in the catalog.</div>'}
      <div class="review-actions">
        ${r.guess_id ? '<button type="button" class="primary small" data-act="yes">Yes, correct</button>' : ''}
        <button type="button" class="ghost small" data-act="pick">Choose tile</button>
        <button type="button" class="link small" data-act="none">Not in catalog</button>
      </div>
      <div class="suggest-wrap" hidden><input type="search" placeholder="Type the tile name" autocomplete="off"><ul class="suggest plainlist"></ul></div>
    </li>`).join('') + (reviewRows.length > 50 ? `<li class="muted">${reviewRows.length - 50} more after these.</li>` : '');
}

async function confirmName(li, tileId) {
  const r = reviewRows[li.dataset.i];
  const { error } = await db.rpc('confirm_stock', { p_key: r.match_key, p_tile: tileId });
  if (error) return alert('Could not save. Check your internet and try again.');
  li.remove();
  const left = $('stock-review').querySelectorAll('li.review').length;
  $('stock-review-head').textContent = left ? `${left} more to check.` : 'All stock names are matched.';
  if (!left) loadReview();
  if (!tileId) loadMissing();
}

$('stock-review').addEventListener('click', (e) => {
  const li = e.target.closest('li.review');
  if (!li) return;
  const act = e.target.dataset.act;
  if (act === 'yes') confirmName(li, reviewRows[li.dataset.i].guess_id);
  if (act === 'none') confirmName(li, null);
  if (act === 'pick') {
    const wrap = li.querySelector('.suggest-wrap');
    wrap.hidden = false;
    const input = wrap.querySelector('input');
    input.value = reviewRows[li.dataset.i].raw_name.replace(/\d+(\.\d+)?\s*[x*]\s*\d+(\.\d+)?\s*(mm|cm)?/ig, '').trim();
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const pick = e.target.closest('button[data-tile]');
  if (pick) confirmName(li, Number(pick.dataset.tile));
});

let reviewTimer = null;
$('stock-review').addEventListener('input', (e) => {
  if (e.target.type !== 'search') return;
  const input = e.target;
  const list = input.nextElementSibling;
  clearTimeout(reviewTimer);
  reviewTimer = setTimeout(async () => {
    const q = input.value.trim();
    if (!q) return (list.innerHTML = '');
    const { data } = await db.rpc('suggest_tiles', { q, p_brand: null, p_size: null });
    const urls = await signedUrls((data || []).map((t) => t.thumb_path));
    list.innerHTML = (data || []).map((t) => `<li><button type="button" data-tile="${t.id}">
      ${urls[t.thumb_path] ? `<img src="${urls[t.thumb_path]}" alt="">` : '<span class="dot"></span>'}
      <span><b>${esc(t.name)}</b> <span class="muted">${esc(t.brand)}</span></span></button></li>`).join('')
      || '<li class="muted">No tile with that name. Try fewer letters.</li>';
  }, 250);
});

// stock names that are not tiles of the app: other brands, and names marked "Not in catalog"
let missingRows = [];

async function loadMissing() {
  const { data } = await db.rpc('stock_missing');
  missingRows = data || [];
  const boxes = missingRows.reduce((t, r) => t + Number(r.total), 0);
  $('stock-missing-head').textContent = missingRows.length
    ? `${missingRows.length} stock item${missingRows.length > 1 ? 's' : ''} (${boxesText(boxes)} boxes) are not in the app.`
    : 'Every stock item is in the app.';
  $('stock-missing-pdf').hidden = !missingRows.length;
  $('stock-missing').innerHTML = missingRows.slice(0, 30).map((r) => `<tr><td>${esc(r.raw_name)}</td><td>${boxesText(r.total)}</td></tr>`).join('')
    + (missingRows.length > 30 ? `<tr><td class="muted">and ${missingRows.length - 30} more in the PDF…</td><td></td></tr>` : '');
}

async function missingPdf() {
  if (!missingRows.length) return;
  $('stock-missing-pdf').disabled = true;
  try {
    const doc = await startPdf({}, showroom);
    const PW = 595, PH = 842, M = 30;
    const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const cols = { name: M + 6, gs: PW - M - 110, kp: PW - M - 55, total: PW - M - 6 };
    let y = 0;
    const header = () => {
      doc.setFillColor(...C.main); doc.rect(0, 0, PW, 62, 'F');
      doc.addImage(logoData, 'JPEG', M, 7, 48 * LOGO_RATIO, 48);
      pen(doc, 'Playfair', 'bold', 18, C.accent);
      doc.text('Stock items not in the app', M + 48 * LOGO_RATIO + 14, 38);
      pen(doc, 'Poppins', 'normal', 8.5, C.white);
      doc.text(today, PW - M, 30, { align: 'right' });
      y = 80;
      doc.setFillColor(...C.sand); doc.rect(M, y, PW - 2 * M, 20, 'F');
      pen(doc, 'Poppins', 'bold', 8.5, C.ink);
      doc.text('Name in the stock file', cols.name, y + 13);
      doc.text('Garg', cols.gs, y + 13, { align: 'right' });
      doc.text('KP', cols.kp, y + 13, { align: 'right' });
      doc.text('Boxes', cols.total, y + 13, { align: 'right' });
      y += 32;
    };
    header();
    for (const r of missingRows) {
      const lines = doc.splitTextToSize(r.raw_name, cols.gs - cols.name - 40);
      if (y + lines.length * 11 > PH - 40) { doc.addPage(); header(); }
      pen(doc, 'Poppins', 'normal', 9, C.ink);
      doc.text(lines, cols.name, y);
      doc.text(boxesText(r.gs), cols.gs, y, { align: 'right' });
      doc.text(boxesText(r.kp), cols.kp, y, { align: 'right' });
      pen(doc, 'Poppins', 'bold', 9, C.ink);
      doc.text(boxesText(r.total), cols.total, y, { align: 'right' });
      y += lines.length * 11 + 3;
      doc.setDrawColor(...C.line); doc.setLineWidth(0.4);
      doc.line(M, y - 9, PW - M, y - 9);
      y += 4;
    }
    pageNumbers(doc, `${SHOWROOMS[showroom].name} · Stock items not in the app · ${today}`, 1, false);
    await deliver(doc, `Stock not in the app ${today}.pdf`);
  } catch (e) {
    alert('Could not make the PDF. Check your internet and try again.');
  } finally {
    $('stock-missing-pdf').disabled = false;
  }
}

$('stock-missing-pdf').addEventListener('click', missingPdf);

$('admin').addEventListener('click', () => { loadUploads(); loadReview(); loadMissing(); });

// ---------- stock screen ----------

const STOCK_PAGE = 60;
let stockRows = [];
let stockFiltersLoaded = false;

function stockArgs() {
  const min = Number($('st-min').value);
  return {
    q: $('st-q').value.trim(),
    p_brand: $('st-brand').value || null,
    p_size: $('st-size').value || null,
    p_finish: $('st-finish').value || null,
    p_min: min > 0 ? min : null,
    p_sort: $('st-sort').value,
  };
}

async function loadStockFilters() {
  const { data } = await db.rpc('stock_filters');
  if (!data) return;
  const up = data.uploads || {};
  $('st-dates').textContent = `Stock as of: Garg ${dayText(up.gs?.at)} · KP ${dayText(up.kp?.at)}`;
  if (stockFiltersLoaded) return;
  stockFiltersLoaded = true;
  $('st-size').insertAdjacentHTML('beforeend', (data.sizes || []).map((s) => `<option value="${esc(s)}">${sizeLabel(s)}</option>`).join(''));
  $('st-finish').insertAdjacentHTML('beforeend', (data.finishes || []).map((f) => `<option>${esc(f)}</option>`).join(''));
  $('st-brand').insertAdjacentHTML('beforeend', (data.brands || []).map((b) => `<option>${esc(b)}</option>`).join(''));
}

function stockRowHtml(r, url) {
  const details = [r.size ? sizeLabel(r.size) : '', r.finish].filter(Boolean).join(' · ');
  return `<li class="card stock-row"><button type="button" ${r.tile_id ? `data-id="${r.tile_id}"` : 'disabled'}>
    ${url ? `<img src="${url}" alt="" loading="lazy">` : '<span class="thumb-empty"></span>'}
    <span class="grow"><b>${esc(r.name)}</b><span class="muted">${esc(r.brand || 'Not in catalog')}${details ? ' · ' + esc(details) : ''}</span>
      <span class="split">Garg ${boxesText(r.gs)} · KP ${boxesText(r.kp)}</span></span>
    <span class="total"><b>${boxesText(r.total)}</b><span class="muted">boxes</span></span>
  </button></li>`;
}

async function runStock(more = false) {
  if (!more) { stockRows = []; $('st-results').innerHTML = ''; }
  $('st-status').textContent = 'Loading…';
  $('st-more').hidden = true;
  const { data, error } = await db.rpc('stock_list', { ...stockArgs(), p_offset: stockRows.length, p_limit: STOCK_PAGE });
  if (error) return ($('st-status').textContent = 'Could not load the stock. Check your internet and try again.');
  stockRows = stockRows.concat(data);
  const n = stockRows.length;
  $('st-status').textContent = n ? `${n}${data.length === STOCK_PAGE ? '+' : ''} tiles in stock` : 'No tiles in stock with these filters.';
  $('st-more').hidden = data.length < STOCK_PAGE;
  const urls = await signedUrls(data.map((r) => r.thumb_path));
  $('st-results').insertAdjacentHTML('beforeend', data.map((r) => stockRowHtml(r, urls[r.thumb_path])).join(''));
}

window.openStock = function () {
  show('stock-view');
  loadStockFilters();
  runStock();
};

$('nav-stock').addEventListener('click', () => { if (current !== 'stock-view') openStock(); });
['st-size', 'st-finish', 'st-brand', 'st-sort'].forEach((id) => $(id).addEventListener('change', () => {
  $(id).classList.toggle('on', !!$(id).value && id !== 'st-sort');
  runStock();
}));
let stockTimer = null;
['st-q', 'st-min'].forEach((id) => $(id).addEventListener('input', () => {
  clearTimeout(stockTimer);
  stockTimer = setTimeout(() => runStock(), 400);
}));
$('st-form').addEventListener('submit', (e) => { e.preventDefault(); document.activeElement?.blur(); runStock(); });
$('st-more').addEventListener('click', () => runStock(true));
$('st-results').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-id]');
  if (btn) pickOrOpen(Number(btn.dataset.id));
});

// ---------- stock on a tile's page ----------

window.tileStockHtml = async function (tileId) {
  const { data } = await db.rpc('tile_stock', { p_tile: tileId });
  if (!data?.length) return '<div class="stock-box muted">Not in today\'s stock.</div>';
  return `<div class="stock-box"><h3>In stock</h3>${data.map((r) => `<div class="stock-line">
    <span>${esc([r.size ? sizeLabel(r.size) : '', r.finish].filter(Boolean).join(' · ') || 'Size not given')}</span>
    <span>Garg ${boxesText(r.gs)} · KP ${boxesText(r.kp)} · <b>${boxesText(r.total)} boxes</b></span></div>`).join('')}</div>`;
};

// ---------- stock PDF with pictures ----------

function filterText(a) {
  return [a.p_size && sizeLabel(a.p_size), a.p_finish, a.p_brand, a.p_min && `at least ${a.p_min} boxes`, a.q && `"${a.q}"`]
    .filter(Boolean).join(' · ') || 'All tiles in stock';
}

async function stockPdf() {
  const args = stockArgs();
  $('st-pdf').disabled = true;
  $('st-status').textContent = 'Making the PDF…';
  try {
    const { data: rows, error } = await db.rpc('stock_list', { ...args, p_offset: 0, p_limit: 1000 });
    if (error) throw error;
    if (!rows.length) return alert('No tiles in stock with these filters.');
    const doc = await startPdf({}, showroom);
    const PW = 595, PH = 842, M = 30;
    const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const cols = { pic: M, name: M + 62, size: 300, gs: 425, kp: 475, total: PW - M };
    const ROW = 62;
    let y = 0;
    const header = (first) => {
      doc.setFillColor(...C.main); doc.rect(0, 0, PW, 62, 'F');
      doc.addImage(logoData, 'JPEG', M, 7, 48 * LOGO_RATIO, 48);
      pen(doc, 'Playfair', 'bold', 18, C.accent);
      doc.text('Tiles in stock', M + 48 * LOGO_RATIO + 14, 38);
      pen(doc, 'Poppins', 'normal', 8.5, C.white);
      doc.text(today, PW - M, 30, { align: 'right' });
      y = 82;
      if (first) {
        pen(doc, 'Poppins', 'bold', 10, C.ink);
        doc.text(filterText(args), M, y, { maxWidth: PW - 2 * M });
        pen(doc, 'Poppins', 'normal', 8, C.grey);
        doc.text($('st-dates').textContent + `  ·  ${rows.length} tiles`, M, y + 14);
        y += 30;
      }
      doc.setFillColor(...C.sand); doc.rect(M, y, PW - 2 * M, 20, 'F');
      pen(doc, 'Poppins', 'bold', 8.5, C.ink);
      doc.text('Tile', cols.name, y + 13);
      doc.text('Size / finish', cols.size, y + 13);
      doc.text('Garg', cols.gs, y + 13, { align: 'right' });
      doc.text('KP', cols.kp, y + 13, { align: 'right' });
      doc.text('Total boxes', cols.total, y + 13, { align: 'right' });
      y += 26;
    };
    header(true);
    // pictures load a few at a time, while the rows are written in order
    const pics = new Array(rows.length);
    let next = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (next < rows.length) {
        const i = next++;
        pics[i] = await pictureData(rows[i].thumb_path, { maxSide: 220, aspect: 1 });
        $('st-status').textContent = `Adding pictures… ${Math.min(next, rows.length)} of ${rows.length}`;
      }
    }));
    rows.forEach((r, i) => {
      if (y + ROW > PH - 40) { doc.addPage(); header(false); }
      if (pics[i]) doc.addImage(pics[i].src, 'JPEG', cols.pic, y, 54, 54);
      else { doc.setFillColor(...C.line); doc.rect(cols.pic, y, 54, 54, 'F'); }
      pen(doc, 'Poppins', 'bold', 9.5, C.ink);
      const nameLines = doc.splitTextToSize(r.name, cols.size - cols.name - 10).slice(0, 2);
      doc.text(nameLines, cols.name, y + 16);
      pen(doc, 'Poppins', 'normal', 8, C.grey);
      doc.text(r.brand || 'Not in catalog', cols.name, y + 16 + nameLines.length * 12);
      pen(doc, 'Poppins', 'normal', 8.5, C.ink);
      doc.text(doc.splitTextToSize([r.size ? sizeLabel(r.size) : '', r.finish].filter(Boolean).join('\n') || '-', 110).slice(0, 3), cols.size, y + 16);
      doc.text(boxesText(r.gs), cols.gs, y + 16, { align: 'right' });
      doc.text(boxesText(r.kp), cols.kp, y + 16, { align: 'right' });
      pen(doc, 'Poppins', 'bold', 11, C.accentDark || C.main);
      doc.text(boxesText(r.total), cols.total, y + 17, { align: 'right' });
      doc.setDrawColor(...C.line); doc.setLineWidth(0.5);
      doc.line(M, y + ROW - 4, PW - M, y + ROW - 4);
      y += ROW;
    });
    pageNumbers(doc, `${SHOWROOMS[showroom].name} · Stock list · ${today}`, 1, false);
    const name = [args.p_size && sizeLabel(args.p_size), args.p_finish].filter(Boolean).join(' ');
    await deliver(doc, `Stock ${name ? name + ' ' : ''}${today}.pdf`);
    $('st-status').textContent = `${stockRows.length}${stockRows.length % STOCK_PAGE === 0 && stockRows.length ? '+' : ''} tiles in stock`;
  } catch (e) {
    $('st-status').textContent = '';
    alert('Could not make the PDF. Check your internet and try again.');
  } finally {
    $('st-pdf').disabled = false;
  }
}

$('st-pdf').addEventListener('click', stockPdf);
