// Instant suggestions: every phone keeps one copy of all tile and fitting names (about 1 MB to
// download, once), so the search boxes suggest products as each letter is typed, with no wait for
// the server. The copy is downloaded again only when the lists change after an update.
const INDEX_CACHE = 'garg-search-index';
let quick = null;             // { tiles, fits } once ready
let quickLoading = null;
let quickFailedAt = 0;

function lowerOf(s) { return String(s ?? '').toLowerCase(); }

function buildQuick(tiles, fits) {
  return {
    tiles: (tiles || []).map(([id, brand, name, thumb_path]) => ({
      id, brand, name, thumb_path, low: lowerOf(name),
      hay: lowerOf(brand + ' ' + name), tight: lowerOf(name).replace(/ /g, ''),
    })),
    fits: (fits || []).map(([id, brand, code, name, mrp, thumb_path, range, category]) => ({
      id, brand, code, name, mrp, thumb_path, lowCode: lowerOf(code),
      hay: lowerOf([brand, code, String(code).replace(/-/g, ''), name, range || '', category || ''].join(' ')),
    })),
    last: {},
  };
}

// Kept in the phone's cache, labelled with the lists' version.
async function cachedJson(cache, name, version, rpc) {
  const key = `search-index/${name}?${version}`;
  const hit = cache && (await cache.match(key).catch(() => null));
  if (hit) return hit.json();
  const { data, error } = await db.rpc(rpc);
  if (error || !data) throw new Error(name);
  if (cache) {
    for (const r of await cache.keys()) if (r.url.includes(`search-index/${name}?`)) await cache.delete(r);
    await cache.put(key, new Response(JSON.stringify(data))).catch(() => {});
  }
  return data;
}

function loadQuick() {
  if (quick) return Promise.resolve(quick);
  if (!quickLoading && Date.now() - quickFailedAt > 60e3) {
    quickLoading = (async () => {
      const { data: version } = await db.rpc('search_index_version');
      if (!version) throw new Error('no version');
      const cache = await caches.open(INDEX_CACHE).catch(() => null);
      const [tiles, fits] = await Promise.all([
        cachedJson(cache, 'tiles', version, 'search_index_tiles'),
        cachedJson(cache, 'fits', version, 'search_index_fittings'),
      ]);
      quick = buildQuick(tiles, fits);
      return quick;
    })().catch(() => { quickLoading = null; quickFailedAt = Date.now(); return null; });   // tried again a minute later; the server answers meanwhile
  }
  return quickLoading || Promise.resolve(null);
}

// Rows whose text holds every typed word. Typing more letters only narrows the last answer,
// so it is searched instead of the whole list.
function narrowed(list, kind, q, test) {
  const prev = quick.last[kind];
  const from = prev && q.startsWith(prev.q) ? prev.rows : list;
  const words = q.split(/\s+/).filter(Boolean);
  const rows = from.filter((r) => words.every((w) => test(r, w)));
  quick.last[kind] = { q, rows };
  return rows;
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Same order as the server's suggest_tiles: name starting with the text, then a word in the name
// starting with it, then shorter names.
function quickTiles(q, brand) {
  const rows = narrowed(quick.tiles, 'tiles', q, (t, w) => t.hay.includes(w) || t.tight.includes(w));
  const plain = q.replace(/[^a-z0-9 ]/g, '');
  const wordStart = plain ? new RegExp('\\b' + plain.replace(/ /g, '\\s')) : null;
  return rows.filter((t) => !brand || t.brand === brand)
    .map((t) => ({ t, a: t.low.startsWith(q) ? 0 : 1, b: wordStart && wordStart.test(t.low) ? 0 : 1 }))
    .sort((x, y) => x.a - y.a || x.b - y.b || x.t.name.length - y.t.name.length || byText(x.t.name, y.t.name))
    .slice(0, 8).map((x) => x.t);
}

// Same order as the server's suggest_fittings: exact code, code starting with the text, with a
// picture, shorter names. A code with an unknown finish (882IN-CP) shows the other finishes.
function quickFits(q, brand) {
  const rank = (f) => [f.lowCode === q ? 0 : 1, f.lowCode.startsWith(q) ? 0 : 1, f.thumb_path ? 0 : 1, f.name.length];
  const order = (a, b) => {
    const x = rank(a), y = rank(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3] - y[3] || byText(a.code, b.code);
  };
  let rows = narrowed(quick.fits, 'fits', q, (f, w) => f.hay.includes(w)).filter((f) => !brand || f.brand === brand);
  if (!rows.length) {
    const base = (q.match(/^(.+)-[a-z0-9]+$/) || [])[1];
    if (!base || base.length < 3) return [];
    rows = quick.fits.filter((f) => (f.lowCode === base || f.lowCode.startsWith(base + '-')) && (!brand || f.brand === brand));
    return rows.sort((a, b) => (a.thumb_path ? 0 : 1) - (b.thumb_path ? 0 : 1) || byText(a.code, b.code)).slice(0, 8);
  }
  return rows.sort(order).slice(0, 8);
}

// Suggestions for the typed text, or null while the phone's copy is not ready yet.
// opts: { tiles: true, fits: true, brand: tile brand, fitBrand: fitting brand }
function findQuick(text, opts = {}) {
  if (!quick) { loadQuick(); return null; }
  const q = lowerOf(text).trim().replace(/\s+/g, ' ');
  if (!q) return { tiles: [], fits: [] };
  return {
    tiles: opts.tiles === false ? [] : quickTiles(q, opts.brand),
    fits: opts.fits === false ? [] : quickFits(q, opts.fitBrand),
  };
}

// Signed picture links last an hour; they are kept and reused for 50 minutes.
const thumbLinks = new Map();       // path -> { url, until }
function knownThumb(path) {
  const k = path && thumbLinks.get(path);
  return k && k.until > Date.now() ? k.url : null;
}
async function thumbUrls(paths) {
  const missing = [...new Set(paths.filter((p) => p && !knownThumb(p)))];
  if (missing.length) {
    const got = await signedUrls(missing).catch(() => ({}));
    const until = Date.now() + 50 * 60e3;
    for (const [p, url] of Object.entries(got)) thumbLinks.set(p, { url, until });
  }
  return Object.fromEntries(paths.filter(knownThumb).map((p) => [p, knownThumb(p)]));
}

// A picture spot in a suggestion: the picture if its link is known, else a dot that
// fillThumbs() swaps for the picture when the link arrives.
function thumbSpot(path) {
  const url = knownThumb(path);
  if (url) return `<img src="${url}" alt="">`;
  return path ? `<span class="dot" data-thumb="${esc(path)}"></span>` : '<span class="dot"></span>';
}
async function fillThumbs(list, stillShown) {
  const spots = [...list.querySelectorAll('[data-thumb]')];
  if (!spots.length) return;
  const urls = await thumbUrls(spots.map((s) => s.dataset.thumb));
  if (!stillShown()) return;
  for (const s of spots) {
    const url = urls[s.dataset.thumb];
    if (!url || !s.isConnected) continue;
    const img = document.createElement('img');
    img.src = url; img.alt = '';
    s.replaceWith(img);
  }
}
