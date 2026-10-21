"""Fifth pass: cut tiles out of catalog pages that are one big picture.

Usage: python3 tools/grid_crop_pictures.py OLD_PICTURES_DIR WORK_DIR [BRAND ...]
Some catalogs (Nexona Grace, Subway, many Icon books) store each page as a single picture with
a grid of tiles printed on it, and the tile names only as part of that picture. For tiles still
without a sharp picture, find every tile-shaped block on the brand's page pictures (a solid
rectangle standing out from the page background), compare it with the tile's old small picture
(pattern and colour), and keep the best clear match cut out at the page picture's own resolution.
Adds to WORK_DIR/hd/matches.json with how = "grid".
"""
import glob
import json
import os
import sys
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor

import cv2
import numpy as np
import pymupdf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from match_pictures import FLAT, read, save_pair, slug  # noqa: E402
from name_layout_pictures import drop_shared  # noqa: E402

MIN_PAGE = 1000      # only pictures this big (longest side) are whole pages worth cutting up
MIN_SIDE = 60        # smallest tile block, in the 1200 px working copy of the page
SIMILAR = 0.5        # pattern similarity needed (old pictures are small and cut a little differently)
MARGIN = 0.08        # the best block must beat any different-looking block by this much
MAX_COLOUR = 12.0    # average colour difference allowed (Lab units)
GAIN = 1.3           # the cut-out must be at least this much bigger than the old picture


def blocks(path):
    """Tile-shaped blocks on a page picture: [(x, y, w, h) in full resolution, descriptor]."""
    img = read(path)
    if img is None:
        return path, []
    H, W = img.shape[:2]
    s = 1200 / max(H, W)
    sm = cv2.resize(img, (round(W * s), round(H * s)), interpolation=cv2.INTER_AREA)
    lab = cv2.cvtColor(sm, cv2.COLOR_BGR2LAB).astype(np.float32)
    edge = np.concatenate([lab[:6].reshape(-1, 3), lab[-6:].reshape(-1, 3), lab[:, :6].reshape(-1, 3), lab[:, -6:].reshape(-1, 3)])
    bg = np.median(edge, 0)
    mask = (np.linalg.norm(lab - bg, axis=2) > 14).astype(np.uint8)
    mask |= (cv2.Canny(cv2.cvtColor(sm, cv2.COLOR_BGR2GRAY), 40, 120) > 0).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    out = []
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        # a name printed right under (or beside) the tile joins its block: trim sparse edge rows and
        # columns, but never more than 18% (a pale plain tile is sparse all over, so it is left alone)
        sub = mask[y:y + h, x:x + w]
        rows, cols = sub.mean(1), sub.mean(0)
        r0, r1, c0, c1 = 0, h, 0, w
        while r1 > r0 + 1 and rows[r1 - 1] < 0.35: r1 -= 1
        while r1 > r0 + 1 and rows[r0] < 0.35: r0 += 1
        while c1 > c0 + 1 and cols[c1 - 1] < 0.35: c1 -= 1
        while c1 > c0 + 1 and cols[c0] < 0.35: c0 += 1
        if r1 - r0 >= 0.82 * h:
            y, h = y + r0, r1 - r0
        if c1 - c0 >= 0.82 * w:
            x, w = x + c0, c1 - c0
        if min(w, h) < MIN_SIDE or max(w, h) / min(w, h) > 4.5 or w * h > 0.45 * sm.shape[0] * sm.shape[1]:
            continue
        if cv2.contourArea(c) < 0.85 * w * h:
            continue
        # trim 1.5% each side so a frame line does not count as part of the tile
        dx, dy = round(w * 0.015), round(h * 0.015)
        X0, Y0, X1, Y1 = (round(v / s) for v in (x + dx, y + dy, x + w - dx, y + h - dy))
        crop = img[Y0:Y1, X0:X1]
        if crop.size:
            out.append(((X0, Y0, X1 - X0, Y1 - Y0), look(crop)))
    return path, out


def look(img):
    """What a picture is compared by: a 64 px grey copy, average colour, contrast."""
    h, w = img.shape[:2]
    k = 64 / max(h, w)
    grey = cv2.cvtColor(cv2.resize(img, (max(8, round(w * k)), max(8, round(h * k))), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    lab = cv2.cvtColor(cv2.resize(img, (16, 16), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2LAB).astype(np.float32)
    return grey, lab.reshape(-1, 3).mean(0), float(lab[..., 0].std())


def similarity(old_grey, block_grey):
    """How well the old picture's middle lines up with the block (allows a few % shift)."""
    h, w = block_grey.shape
    g = cv2.resize(old_grey, (w, h), interpolation=cv2.INTER_AREA)
    my, mx = max(1, round(h * 0.08)), max(1, round(w * 0.08))
    t = g[my:h - my, mx:w - mx]
    if t.std() < 1e-3:
        return 0.0
    return float(cv2.matchTemplate(block_grey, t, cv2.TM_CCOEFF_NORMED).max())


def compare(a, b):
    """Score of an old picture a against a block b (higher is better), or None."""
    (ga, ca, ka), (gb, cb, kb) = a, b
    colour = float(np.linalg.norm(ca - cb))
    if colour > (MAX_COLOUR / 2 if max(ka, kb) < FLAT else MAX_COLOUR):
        return None
    sim = similarity(ga, gb)
    if max(ka, kb) >= FLAT and sim < SIMILAR:
        return None
    return sim - colour / 40


def main(old_dir, work, brands=()):
    out = os.path.join(work, "hd")
    matches = json.load(open(os.path.join(out, "matches.json")))
    old = {}
    for f in sorted(glob.glob(os.path.join(old_dir, "brands", "*_images.json"))):
        for k, v in json.load(open(f)).items():
            if v.get("kind") == "tile":
                old[k] = os.path.join(old_dir, v["file"])
    todo = {k: p for k, p in old.items() if k not in matches and (not brands or k.split("|")[0] in brands)}

    # the brand's catalogs: folders named after it, plus folders where its tiles were already found
    folders = defaultdict(set)
    all_folders = {os.path.basename(p)[:-4] for p in glob.glob(os.path.join(work, "pdf", "*.pdf"))}
    for k, v in matches.items():
        folders[k.split("|")[0]].add(os.path.dirname(v.get("src", "")))
    for b in {k.split("|")[0] for k in todo}:
        word = slug(b).split("-")[0]
        folders[b] |= {f for f in all_folders if word in f}
    pages = defaultdict(list)
    records = {}
    for line in open(os.path.join(work, "pics", "index.jsonl")):
        r = json.loads(line)
        if max(r["w"], r["h"]) >= MIN_PAGE:
            pages[os.path.dirname(r["path"])].append(r["path"])
            records[r["path"]] = r
    wanted = sorted({p for b in {k.split("|")[0] for k in todo} for f in folders[b] for p in pages.get(f, [])})
    print(f"{len(todo)} tiles left; cutting up {len(wanted)} page pictures", flush=True)

    # the page pictures in WORK_DIR/pics were made smaller; cut from the PDF at its own resolution
    docs, native = {}, {}

    def full_size(page):
        if page not in native:
            folder, name = page.split("/")
            pno, i = (int(v) for v in name[1:-4].split("-"))
            doc = docs.get(folder) or docs.setdefault(folder, pymupdf.open(os.path.join(work, "pdf", folder + ".pdf")))
            try:
                native[page] = doc.get_page_images(pno - 1)[i][2] / records[page]["w"]
            except (IndexError, ZeroDivisionError):
                native[page] = 1.0
        return native[page]

    def cut(page, x, y, w, h):
        r = records[page]
        folder = page.split("/")[0]
        bx0, by0, bx1, by1 = r["bbox"]
        sx, sy = (bx1 - bx0) / r["w"], (by1 - by0) / r["h"]
        clip = pymupdf.Rect(bx0 + x * sx, by0 + y * sy, bx0 + (x + w) * sx, by0 + (y + h) * sy)
        zoom = max(1.0, full_size(page) / sx)          # pixels per point of the stored picture
        pix = docs[folder][r["page"] - 1].get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), clip=clip, alpha=False)
        img = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)
        return cv2.cvtColor(img, cv2.COLOR_RGB2BGR if pix.n == 3 else cv2.COLOR_GRAY2BGR)

    found_blocks = {}
    with ProcessPoolExecutor() as pool:
        for i, (path, bl) in enumerate(pool.map(blocks, [os.path.join(work, "pics", p) for p in wanted], chunksize=8), 1):
            found_blocks[os.path.relpath(path, os.path.join(work, "pics"))] = bl
            if i % max(1, len(wanted) // 20) == 0:
                print(f"{round(100 * i / len(wanted))}% of pages cut up", flush=True)
    print(f"{sum(len(v) for v in found_blocks.values())} tile blocks found", flush=True)

    found = 0
    for n, (k, path) in enumerate(sorted(todo.items()), 1):
        if n % max(1, len(todo) // 20) == 0:
            print(f"{round(100 * n / len(todo))}% of tiles checked, {found} found", flush=True)
        small = read(path)
        if small is None:
            continue
        h0, w0 = small.shape[:2]
        da = look(small)
        cands = []
        b = k.split("|")[0]
        for f in folders[b]:
            for page in pages.get(f, []):
                for (x, y, w, h), db in found_blocks.get(page, []):
                    want_h = w * h0 / w0
                    if 1.03 < h / want_h < 1.16:       # the name under the tile is still in the block
                        g = db[0]
                        db = (g[:max(8, round(g.shape[0] * want_h / h))], db[1], db[2])
                        h = round(want_h)
                    if abs((w / h) / (w0 / h0) - 1) > 0.08 or max(w, h) * full_size(page) < GAIN * max(w0, h0):
                        continue
                    sc = compare(da, db)
                    if sc is not None:
                        cands.append((sc, page, (x, y, w, h), db[0]))
        if not cands:
            continue
        cands.sort(key=lambda c: -c[0])
        best = cands[0]
        # a near copy of the same block (the same page in two catalogs) is not a rival
        rival = next((c for c in cands[1:] if similarity(c[3], best[3]) < 0.9), None)
        if rival and best[0] - rival[0] < MARGIN:
            continue
        _, page, (x, y, w, h), _ = best
        file = slug(k.replace("|", " ")) + ".jpg"
        matches[k] = {"how": "grid", "catalog": os.path.dirname(page), "page": page, "src": f"{page}#{x},{y},{w},{h}",
                      "file": file, "px": save_pair(cut(page, x, y, w, h), file, out)}
        found += 1
    before = len(matches)
    drop_shared_grid(matches)
    json.dump(matches, open(os.path.join(out, "matches.json"), "w"), indent=0)
    print(f"done: {found} found, {before - len(matches)} dropped as shared, {len(matches)} tiles have sharp pictures", flush=True)


def drop_shared_grid(matches):
    """Same rule as the other passes: one block given to two different tiles is not trusted."""
    for v in matches.values():
        if v["how"] == "grid":
            v["how"] = "name"          # drop_shared looks at "name" and "decor" entries
            v["_grid"] = True
    drop_shared(matches)
    for v in matches.values():
        if v.pop("_grid", False):
            v["how"] = "grid"


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], tuple(sys.argv[3:]))
