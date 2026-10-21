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

// ---------- admin: upload and check names ----------

let pending = null;      // {room, file, lines} read from a PDF, waiting for Save

async function loadUploads() {
  const { data } = await db.rpc('stock_filters');
  const up = data?.uploads || {};
  for (const room of ['gs', 'kp']) {
    const u = up[room];
    $(`stock-last-${room}`).textContent = u ? `Last: ${dayText(u.at)} · ${u.lines} lines · ${boxesText(u.boxes)} boxes` : 'Not uploaded yet';
  }
  return data;
}

document.querySelectorAll('.stock-file').forEach((input) => input.addEventListener('change', async () => {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  const room = input.dataset.room;
  $('stock-msg').textContent = `Reading ${file.name}…`;
  $('stock-preview').hidden = true;
  try {
    const lines = stockLines(await pdfRows(file));
    if (!lines.length) {
      $('stock-msg').textContent = 'No stock lines found in this PDF. Please send this PDF to Claude so the app can learn its layout.';
      return;
    }
    pending = { room, file: file.name, lines };
    const total = lines.reduce((s, l) => s + l.boxes, 0);
    $('stock-msg').textContent = '';
    $('stock-preview-head').textContent = `${SHOWROOMS[room].name}: ${lines.length} tiles, ${boxesText(total)} boxes in total. Do these look right?`;
    $('stock-preview-rows').innerHTML = lines.slice(0, 12).map((l) => `<tr><td>${esc(l.name)}</td><td>${boxesText(l.boxes)}</td></tr>`).join('')
      + (lines.length > 12 ? `<tr><td class="muted">and ${lines.length - 12} more…</td><td></td></tr>` : '');
    $('stock-preview').hidden = false;
  } catch (e) {
    $('stock-msg').textContent = 'Could not read this PDF. Check it opens on the phone, then try again.';
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
    $('stock-msg').textContent = `${SHOWROOMS[room].name} stock saved: ${res.lines} lines, ${boxesText(res.boxes)} boxes. `
      + `${res.sure} matched to catalog tiles.` + (res.unsure ? ` ${res.unsure} names need your check below.` : '');
    loadUploads();
    loadReview();
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

$('admin').addEventListener('click', () => { loadUploads(); loadReview(); });

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
