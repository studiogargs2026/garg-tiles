// Photo search: a free picture-matching model (ConvNeXt, run on the phone with onnxruntime-web)
// turns a photo into a fingerprint and compares it with the fingerprints of every catalog
// picture, made beforehand by tools/photo_vectors.py. No server and no paid service is involved.
// A tile photo gives the closest tiles (and, for a close wall/floor photo, each different tile).
// A photo of a whole room is recognised as such: the person taps the wall tile, the highlighter
// and the floor tile, and each gets its own matches. Catalog pictures that show a whole room
// are never offered, only pictures of the tiles themselves.
views.push('photo-view');

const MODEL_URL = 'vendor/model/tile-match-v1.onnx';
const MODEL_CACHE = 'garg-photo-model-v1';
const SIZE = 224;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let engine = null;            // {session, index} once loaded
let loading = null;
let photo = null;             // the photo being checked, as a canvas
let regions = [];             // parts of the photo that were checked

function photoMsg(text) { $('ph-status').textContent = text; }

function loadScript(src) {
  return new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => fail(new Error('script ' + src));
    document.head.appendChild(s);
  });
}

// The model (about 34 MB) is downloaded once and kept on the phone.
async function modelBytes() {
  const cache = await caches.open(MODEL_CACHE).catch(() => null);
  let res = cache && (await cache.match(MODEL_URL));
  if (!res) {
    res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error('model ' + res.status);
    const total = Number(res.headers.get('content-length')) || 34e6;
    const reader = res.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      photoMsg(`Getting ready, first time only… ${Math.min(99, Math.round(got / total * 100))}%`);
    }
    res = new Response(new Blob(parts));
    await cache?.put(MODEL_URL, res.clone()).catch(() => {});
    caches.keys().then((keys) => keys.filter((k) => k.startsWith('garg-photo-model-') && k !== MODEL_CACHE).forEach((k) => caches.delete(k)));
  }
  return new Uint8Array(await res.arrayBuffer());
}

// Fingerprints of all catalog pictures, kept on the phone until the next update.
async function loadIndex() {
  const { data: files } = await db.storage.from('tiles').list('photo');
  const meta = (files || []).find((f) => f.name === 'meta.json');
  const vec = (files || []).find((f) => f.name === 'vectors.bin');
  if (!meta || !vec) throw new Error('no index');
  const stamp = [meta, vec].map((f) => f.updated_at || f.created_at || '').join('_');   // either file changing makes a fresh copy
  const cache = await caches.open('garg-photo-index').catch(() => null);
  const key = (name) => `photo-index/${name}?${stamp}`;
  async function get(name) {
    let res = cache && (await cache.match(key(name)));
    if (!res) {
      const urls = await signedUrls(['photo/' + name]);
      res = await fetch(urls['photo/' + name]);
      if (!res.ok) throw new Error(name + ' ' + res.status);
      if (cache) {
        for (const r of await cache.keys()) if (r.url.includes(`photo-index/${name}?`)) await cache.delete(r);
        await cache.put(key(name), res.clone()).catch(() => {});
      }
    }
    return res;
  }
  const [m, { data: hl }] = await Promise.all([get('meta.json').then((r) => r.json()), db.rpc('highlighter_thumbs')]);
  const v = new Int8Array(await (await get('vectors.bin')).arrayBuffer());
  const n = v.length / m.dim;
  const norms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * m.dim, e = j + m.dim; j < e; j++) s += v[j] * v[j];
    norms[i] = Math.sqrt(s) || 1;
  }
  const hlPaths = new Set(hl || []);
  const highlighter = new Set(m.paths.flatMap((p, t) => (hlPaths.has(p) ? [t] : [])));
  return { ...m, highlighter, room: new Set(m.room || []), vectors: v, norms, count: m.paths.length };
}

function ensureEngine() {
  if (engine) return Promise.resolve(engine);
  if (!loading) {
    loading = (async () => {
      photoMsg('Getting ready…');
      if (!window.ort) await loadScript('vendor/ort/ort.wasm.min.js');
      ort.env.wasm.wasmPaths = new URL('vendor/ort/', location.href).href;
      ort.env.wasm.numThreads = 1;
      const [bytes, index] = await Promise.all([modelBytes(), loadIndex()]);
      const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
      engine = { session, index };
      return engine;
    })().catch((err) => { loading = null; throw err; });
  }
  return loading;
}

// ---------- fingerprints ----------

// Part of the photo (x, y, w, h as fractions) squeezed to 224x224, like the catalog pictures were.
function pixels(box, size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  const W = photo.width, H = photo.height;
  g.drawImage(photo, box.x * W, box.y * H, box.w * W, box.h * H, 0, 0, size, size);
  return g.getImageData(0, 0, size, size).data;
}

async function fingerprint(box) {
  const px = pixels(box, SIZE);
  const plane = SIZE * SIZE;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let ch = 0; ch < 3; ch++) input[ch * plane + i] = (px[i * 4 + ch] / 255 - MEAN[ch]) / STD[ch];
  }
  const { session } = engine;
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });
  const v = out[session.outputNames[0]].data;
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  return { vec: Float32Array.from(v, (x) => x / s) };
}

// Score of every catalog tile for one fingerprint: the best of the tile's picture parts.
function scores(fp) {
  const { index } = engine;
  const { dim, vectors, norms, per } = index;
  const best = new Float32Array(index.count).fill(-9);
  for (let r = 0, n = norms.length; r < n; r++) {
    let s = 0;
    for (let j = 0, o = r * dim; j < dim; j++) s += fp.vec[j] * vectors[o + j];
    s /= norms[r];
    const t = Math.floor(r / per);
    if (s > best[t]) best[t] = s;
  }
  return best;
}

function topTiles(score, n, only) {
  const idx = [];
  for (let t = 0; t < score.length; t++) if (!only || only(t)) idx.push(t);
  idx.sort((a, b) => score[b] - score[a]);
  return idx.slice(0, n).map((t) => ({ t, score: score[t] }));
}

const isHighlighter = (t) => engine.index.highlighter.has(t);
// catalog pictures that show a whole room instead of the tile itself are never offered as matches
const isTilePicture = (t) => !engine.index.room.has(t);

// ---------- screen ----------

$('nav-photo').addEventListener('click', () => {
  if (current !== 'photo-view') show('photo-view');
  ensureEngine().then(() => { if (!photo) photoMsg(''); }).catch(() => photoMsg('Photo search could not get ready. Check the internet, then tap Photo again.'));
});

['ph-camera', 'ph-gallery'].forEach((id) => $(id).addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) await checkPhoto(file);
}));

async function readPhoto(file) {
  const img = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null)
    || await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = URL.createObjectURL(file); });
  const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

// Is this a photo of a whole room? Same check that marked the catalog's room pictures.
function looksLikeRoom(fp) {
  const { weights, bias } = engine.index.roomCheck;
  let z = bias;
  for (let i = 0; i < weights.length; i++) z += weights[i] * fp.vec[i];
  return z > 0;
}

// boxes of size w spread evenly over the photo, n across and n down
function grid(n, w) {
  const steps = Array.from({ length: n }, (_, i) => (n === 1 ? 0 : i * (1 - w) / (n - 1)));
  return steps.flatMap((y) => steps.map((x) => ({ x, y, w, h: w })));
}

async function checkPhoto(file) {
  $('ph-results').innerHTML = '';
  $('ph-groups').innerHTML = '';
  $('ph-make').hidden = true;
  $('ph-roles').hidden = true;
  roomMode = false;
  try { photo = await readPhoto(file); } catch { return photoMsg('Could not open this photo. Try another one.'); }
  drawPhoto();
  $('ph-photo-wrap').hidden = false;
  try { await ensureEngine(); } catch { return photoMsg('Photo search could not get ready. Check the internet and try again.'); }

  // 1. the whole photo and its middle: the tile itself when the photo is of one tile
  photoMsg('Checking the photo…');
  await pause();
  const wholeFp = await fingerprint({ x: 0, y: 0, w: 1, h: 1 });
  const room = looksLikeRoom(wholeFp);
  if (room) return startRoom();     // a whole room: the person points at each tile
  const whole = scores(wholeFp);
  const middle = scores(await fingerprint({ x: 0.15, y: 0.15, w: 0.7, h: 0.7 }));
  for (let t = 0; t < whole.length; t++) whole[t] = Math.max(whole[t], middle[t]);
  await showList($('ph-results'), topTiles(whole, 12, isTilePicture), 'Closest tiles');

  // 2. part by part, for a close photo of a wall or floor with more than one tile
  regions = [];
  const boxes = grid(3, 0.4);
  for (let i = 0; i < boxes.length; i++) {
    photoMsg(`Looking at each tile in the photo… ${Math.round((i + 1) / boxes.length * 100)}%`);
    await pause();
    const fp = await fingerprint(boxes[i]);
    regions.push({ box: boxes[i], fp, score: scores(fp) });
  }
  await showGroups();
  photoMsg('Tap on any tile in the photo to check just that spot.');
}

const pause = () => new Promise((r) => setTimeout(r, 30));

function drawPhoto(marks = []) {
  const c = $('ph-canvas');
  c.width = photo.width; c.height = photo.height;
  const g = c.getContext('2d');
  g.drawImage(photo, 0, 0);
  const lw = Math.max(4, photo.width / 150);
  for (const { box, label } of marks) {
    const [x, y, w, h] = [box.x * c.width, box.y * c.height, box.w * c.width, box.h * c.height];
    g.lineWidth = lw; g.setLineDash([]);
    g.strokeStyle = '#fff'; g.strokeRect(x, y, w, h);
    g.setLineDash([lw * 2, lw * 2]);
    g.strokeStyle = '#f05a28'; g.strokeRect(x, y, w, h);
    if (label) {
      g.font = `bold ${lw * 6}px Poppins, sans-serif`;
      const tw = g.measureText(label).width;
      g.fillStyle = '#f05a28'; g.fillRect(x, y - lw * 8, tw + lw * 3, lw * 8);
      g.fillStyle = '#fff'; g.fillText(label, x + lw * 1.5, y - lw * 2);
    }
  }
}

// ---------- room photos: the person taps the wall tile, the highlighter and the floor tile ----------

const ROOM_ROLES = ['Wall', 'Highlighter', 'Floor', 'Other'];
const ROLE_WORDS = { Wall: 'the wall tile', Highlighter: 'the highlighter', Floor: 'the floor tile', Other: 'any other tile' };
let roomMode = false;
let roleNow = 'Wall';
let picked = {};              // role -> {box, main, hl}

function startRoom() {
  roomMode = true;
  picked = {};
  $('ph-roles').hidden = false;
  chooseRole('Wall');
}

function chooseRole(role) {
  roleNow = role;
  $('ph-roles').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.role === role);
    b.classList.toggle('done', !!picked[b.dataset.role]);
  });
  photoMsg(`Room photo: tap on ${ROLE_WORDS[role]} in the photo.`);
}

$('ph-roles').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-role]');
  if (b) chooseRole(b.dataset.role);
});

function roomMarks() {
  return ROOM_ROLES.filter((r) => picked[r]).map((r) => ({ box: picked[r].box, label: r }));
}

// a small and a bigger square around the tapped point, so a narrow highlighter strip and a big floor both work
function boxesAround(fx, fy, sides) {
  return sides.map((f) => {
    const side = f * Math.min(photo.width, photo.height);
    const w = side / photo.width, h = side / photo.height;
    return { x: Math.min(1 - w, Math.max(0, fx - w / 2)), y: Math.min(1 - h, Math.max(0, fy - h / 2)), w, h };
  });
}

async function roomTap(fx, fy) {
  const role = roleNow;
  const [small, big] = boxesAround(fx, fy, [0.14, 0.24]);
  drawPhoto([...roomMarks().filter((m) => m.label !== role), { box: small, label: role }]);
  photoMsg(`Checking ${ROLE_WORDS[role]}…`);
  await pause();
  const a = scores(await fingerprint(small)), b = scores(await fingerprint(big));
  for (let t = 0; t < a.length; t++) a[t] = Math.max(a[t], b[t]);
  const hlOnly = (t) => isTilePicture(t) && isHighlighter(t);
  const main = await details(topTiles(a, 6, role === 'Highlighter' ? hlOnly : isTilePicture));
  const hl = role === 'Highlighter' ? await details(topTiles(a, 6, (t) => isTilePicture(t) && !isHighlighter(t)))
    : await details(topTiles(a, 3, hlOnly));
  picked[role] = { box: small, main, hl };
  drawPhoto(roomMarks());
  renderRoom();
  const next = ['Wall', 'Highlighter', 'Floor'].find((r) => !picked[r]);
  if (next) chooseRole(next);
  else {
    chooseRole(role);
    photoMsg('Done. Tap a button and then the photo to change any of them, or scroll down.');
  }
}

function renderRoom() {
  const html = ROOM_ROLES.filter((r) => picked[r]).map((r) => {
    const p = picked[r];
    const second = r === 'Highlighter' ? 'Other similar tiles' : 'Highlighter options';
    return `<div class="card pad ph-group">
      <div class="ph-group-head"><img src="${crop(p.box)}" alt=""><div><b>${r === 'Other' ? 'Other tile' : r === 'Highlighter' ? 'Highlighter' : r + ' tile'}</b>
        <div class="muted">Tap a tile below to see its details</div></div></div>
      <h3>${r === 'Highlighter' ? 'Highlighter options' : 'Similar tiles'}</h3><ul class="grid small-grid">${cards(p.main)}</ul>
      ${p.hl.length ? `<h3>${second}</h3><ul class="grid small-grid">${cards(p.hl)}</ul>` : ''}
    </div>`;
  });
  $('ph-groups').innerHTML = `<h2>Tiles in this photo</h2>${html.join('')}`;
  $('ph-make').hidden = !window.startSelectionWith;
}

// Tap a spot: check a square around it.
$('ph-canvas').addEventListener('click', async (e) => {
  if (!engine || !photo) return;
  const r = e.target.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
  if (roomMode) return roomTap(fx, fy);
  const side = 0.28 * Math.min(photo.width, photo.height);
  const w = side / photo.width, h = side / photo.height;
  const box = { x: Math.min(1 - w, Math.max(0, fx - w / 2)), y: Math.min(1 - h, Math.max(0, fy - h / 2)), w, h };
  drawPhoto([{ box }]);
  photoMsg('Checking that spot…');
  await pause();
  const fp = await fingerprint(box);
  await showList($('ph-results'), topTiles(scores(fp), 12, isTilePicture), 'Closest tiles for the marked spot');
  photoMsg('Tap another spot to check it, or scroll down for the tiles below.');
  $('ph-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// tile details for the matched pictures (pictures are found by their path)
async function details(list) {
  const paths = list.map((m) => engine.index.paths[m.t]);
  const { data } = await db.from('tiles').select('id, brand, name, thumb_path').in('thumb_path', paths);
  const byPath = Object.fromEntries((data || []).map((d) => [d.thumb_path, d]));
  const urls = await signedUrls(paths);
  return list.map((m) => ({ ...m, tile: byPath[engine.index.paths[m.t]], url: urls[engine.index.paths[m.t]] })).filter((m) => m.tile);
}

function cards(items, best) {
  return items.map((m, i) => `<li class="card" data-score="${m.score.toFixed(3)}"><button data-id="${m.tile.id}">
      ${m.url ? `<img src="${m.url}" alt="" loading="lazy">` : '<div class="thumb-empty"></div>'}
      <div class="info"><div class="name">${esc(m.tile.name)}</div><div class="muted">${esc(m.tile.brand)}${best && i === 0 ? ' · <b class="best">Best match</b>' : ''}</div></div>
    </button></li>`).join('');
}

async function showList(el, list, title) {
  const items = await details(list);
  el.innerHTML = `<h2>${esc(title)}</h2><ul class="grid">${cards(items, true)}</ul>`;
}

// Parts of the photo that show the same tile are put together; each group gets its own similar tiles.
async function showGroups() {
  const groups = [];
  for (const r of regions) {
    const first = topTiles(r.score, 1, isTilePicture)[0];
    const g = groups.find((g) => dot(g.fp.vec, r.fp.vec) > 0.7 || g.first === first.t);
    if (g) { g.parts.push(r); for (let t = 0; t < g.score.length; t++) g.score[t] += r.score[t]; }
    else groups.push({ fp: r.fp, first: first.t, parts: [r], score: Float32Array.from(r.score) });
  }
  // a group seen in a single small part is usually an edge or an object, unless it is all we have
  const kept = groups.filter((g) => g.parts.length > 1);
  kept.sort((a, b) => b.parts.length - a.parts.length);
  const shown = kept.slice(0, 4);
  if (shown.length < 2) return;          // a one-tile photo: the list above is the answer
  const html = [];
  photoGroups = [];
  for (const [i, g] of shown.entries()) {
    for (let t = 0; t < g.score.length; t++) g.score[t] /= g.parts.length;
    const main = await details(topTiles(g.score, 6, isTilePicture));
    const hl = await details(topTiles(g.score, 3, (t) => isTilePicture(t) && isHighlighter(t)));
    const y = g.parts.reduce((s, p) => s + p.box.y + p.box.h / 2, 0) / g.parts.length;
    const where = y > 0.62 ? 'lower part, floor?' : y < 0.38 ? 'upper part, wall?' : 'middle';
    const role = main[0] && isHighlighter(main[0].t) ? 'Highlighter' : y > 0.62 ? 'Floor' : 'Wall';
    photoGroups.push({ main, hl, role });
    html.push(`<div class="card pad ph-group">
      <div class="ph-group-head"><img src="${crop(g.parts[0].box)}" alt=""><div><b>Tile ${i + 1} in the photo</b>
        <div class="muted">${where}</div></div></div>
      <h3>Similar tiles</h3><ul class="grid small-grid">${cards(main)}</ul>
      ${hl.length ? `<h3>Highlighter options</h3><ul class="grid small-grid">${cards(hl)}</ul>` : ''}
    </div>`);
  }
  $('ph-groups').innerHTML = '<h2>Wall or floor photo with several tiles?</h2>'
    + `<p class="muted">Each different tile found in the photo, with similar tiles from our catalogs. If one is missed, tap on it in the photo.</p>${html.join('')}`;
  $('ph-make').hidden = !window.startSelectionWith;
}
let photoGroups = [];

function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

function crop(box) {
  const c = document.createElement('canvas');
  c.width = c.height = 120;
  c.getContext('2d').drawImage(photo, box.x * photo.width, box.y * photo.height, box.w * photo.width, box.h * photo.height, 0, 0, 120, 120);
  return c.toDataURL('image/jpeg', 0.8);
}

['ph-results', 'ph-groups'].forEach((id) => $(id).addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-id]');
  if (btn) pickOrOpen(Number(btn.dataset.id));
}));

// A ready-made client selection: the closest tile for each group, plus the best highlighter.
$('ph-make').addEventListener('click', () => {
  if (roomMode) {
    const items = ROOM_ROLES.filter((r) => picked[r]?.main[0]).map((r) => ({ id: picked[r].main[0].tile.id, role: r }));
    return window.startSelectionWith(items, 'From client photo');
  }
  const items = [];
  for (const g of photoGroups) if (g.main[0]) items.push({ id: g.main[0].tile.id, role: g.role });
  const hl = photoGroups.flatMap((g) => g.hl).sort((a, b) => b.score - a.score)[0];
  if (hl && !items.some((i) => i.id === hl.tile.id)) items.push({ id: hl.tile.id, role: 'Highlighter' });
  window.startSelectionWith(items, 'From client photo');
});
