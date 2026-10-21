"""Find each tile's full-quality picture among the pictures pulled out of the catalogs.

Usage: python3 tools/match_pictures.py OLD_PICTURES_DIR TILES.json WORK_DIR
OLD_PICTURES_DIR is the old build folder: brands/*_images.json map "Brand|name" to a small
picture of that tile. Each small picture is looked up among WORK_DIR/pics (made by
catalog_pictures.py): first among the pictures stored in the PDFs, then, for tiles printed
as part of a bigger page, inside the page itself, which is then cut out at 300 dpi.
Writes WORK_DIR/hd/<slug>.jpg (up to 1600 px) plus thumbnails, and WORK_DIR/hd/matches.json.
"""
import glob
import json
import os
import re
import sys
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor

import cv2
import numpy as np
import pymupdf

SIDE = 16
ACCEPT = 0.90        # similarity needed to trust a stored picture
PAGE_ACCEPT = 0.80   # template match score needed inside a page
HD_SIDE = 1600
THUMB_SIDE = 400


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:80]


def descriptor(img):
    small = cv2.resize(img, (SIDE, SIDE), interpolation=cv2.INTER_AREA)
    lab = cv2.cvtColor(small, cv2.COLOR_BGR2LAB).astype(np.float32)
    lab[..., 1:] *= 0.6          # colour counts a little less than light/dark pattern
    v = (lab - lab.mean()).ravel()
    return v / (np.linalg.norm(v) + 1e-6)


def read(path):
    data = np.fromfile(path, np.uint8)
    return cv2.imdecode(data, cv2.IMREAD_COLOR) if data.size else None


def describe(path):
    img = read(path)
    if img is None:
        return None
    h, w = img.shape[:2]
    return descriptor(img), w / h


def save_pair(img, name, out):
    h, w = img.shape[:2]
    for side, sub in ((HD_SIDE, ""), (THUMB_SIDE, "thumb/")):
        scale = min(1.0, side / max(h, w))
        im = cv2.resize(img, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA) if scale < 1 else img
        cv2.imwrite(os.path.join(out, sub + name), im, [cv2.IMWRITE_JPEG_QUALITY, 88 if sub else 80])
    return max(h, w)


SCALES = np.geomspace(0.5, 4.0, 15)


def search_catalog(args):
    """Look for small tile pictures inside one catalog's page previews.
    Returns {key: (score, page, box in points)}. After the first sure hit, only scales
    near it are tried, since one catalog is usually cut at one zoom."""
    catalog, previews, tiles = args
    pages = []
    for page, path, size in previews:
        img = read(path)
        if img is not None:
            pages.append((page, cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), size))
    hint, found = None, {}
    for key, small_path in tiles:
        small = read(small_path)
        if small is None:
            continue
        small = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        scales = SCALES if hint is None else SCALES[max(0, hint - 1):hint + 2]
        best = None
        for si, scale in enumerate(scales):
            th, tw = round(small.shape[0] * scale), round(small.shape[1] * scale)
            if th < 24 or tw < 24:
                continue
            tmpl = cv2.resize(small, (tw, th), interpolation=cv2.INTER_AREA)
            for page, big, size in pages:
                bh, bw = big.shape
                if th > bh or tw > bw:
                    continue
                _, score, _, (x, y) = cv2.minMaxLoc(cv2.matchTemplate(big, tmpl, cv2.TM_CCOEFF_NORMED))
                if best is None or score > best[0]:
                    k = size[0] / bw
                    best = (score, page, [x * k, y * k, (x + tw) * k, (y + th) * k], list(SCALES).index(scale))
        if best and best[0] >= PAGE_ACCEPT:
            found[key] = best[:3]
            if hint is None and best[0] >= 0.9:
                hint = best[3]
    return catalog, found


def main(old_dir, tiles_path, work):
    out = os.path.join(work, "hd")
    os.makedirs(os.path.join(out, "thumb"), exist_ok=True)

    old = {}
    for f in sorted(glob.glob(os.path.join(old_dir, "brands", "*_images.json"))):
        for k, v in json.load(open(f)).items():
            path = os.path.join(old_dir, v["file"])
            if k not in old or (old[k]["kind"] == "page" and v["kind"] == "tile"):
                old[k] = {"path": path, "kind": v["kind"]}
    old = {k: v for k, v in old.items() if v["kind"] == "tile"}
    catalog_of = {f"{d['brand']}|{re.sub(r'[^a-z0-9]+', ' ', d['name'].lower()).strip()}": d.get("catalog")
                  for d in json.load(open(tiles_path))["designs"]}

    index = [json.loads(line) for line in open(os.path.join(work, "pics", "index.jsonl"))]
    pics_dir = os.path.join(work, "pics")
    with ProcessPoolExecutor() as pool:
        cand = list(pool.map(describe, [os.path.join(pics_dir, r["path"]) for r in index], chunksize=64))
        keys = sorted(old)
        mine = list(pool.map(describe, [old[k]["path"] for k in keys], chunksize=64))
    ok = [i for i, c in enumerate(cand) if c is not None]
    C = np.stack([cand[i][0] for i in ok]).astype(np.float32)
    C_ratio = np.array([cand[i][1] for i in ok])

    matches, unmatched = {}, []
    for k, m in zip(keys, mine):
        if m is None:
            continue
        sims = C @ m[0]
        ratio_ok = np.abs(np.log(C_ratio / m[1])) < 0.2
        sims[~ratio_ok] = -1
        j = int(sims.argmax())
        if sims[j] >= ACCEPT:
            r = index[ok[j]]
            matches[k] = {"how": "stored", "score": round(float(sims[j]), 3), "catalog": r["catalog"], "page": r["page"],
                          "src": r["path"]}
        else:
            unmatched.append(k)
    # Plain tiles look alike across brands: a match must come from a catalog whose other
    # matches are mostly the same brand, otherwise retry within that brand's catalogs.
    votes = defaultdict(Counter)
    for k, v in matches.items():
        votes[v["catalog"]][k.split("|")[0]] += 1
    file_brand = {f: c.most_common(1)[0][0] for f, c in votes.items()}
    cand_brand = np.array([file_brand.get(index[i]["catalog"]) for i in ok], dtype=object)
    mine_by_key = dict(zip(keys, mine))
    for k in [k for k, v in matches.items() if file_brand[v["catalog"]] != k.split("|")[0]]:
        m = mine_by_key[k]
        sims = C @ m[0]
        sims[(np.abs(np.log(C_ratio / m[1])) >= 0.2) | (cand_brand != k.split("|")[0])] = -1
        j = int(sims.argmax())
        if sims[j] >= ACCEPT:
            r = index[ok[j]]
            matches[k] = {"how": "stored", "score": round(float(sims[j]), 3), "catalog": r["catalog"], "page": r["page"],
                          "src": r["path"]}
        else:
            del matches[k]
            unmatched.append(k)
    print(f"stored pictures: {len(matches)} of {len(keys)} tiles", flush=True)

    # Tiles printed inside a bigger page: search the pages of the catalogs that the
    # other tiles of the same catalog title were found in.
    title_files = defaultdict(set)
    for k, v in matches.items():
        title_files[catalog_of.get(k)].add(v["catalog"])
    pages_by_file = defaultdict(list)
    for preview in glob.glob(os.path.join(pics_dir, "*", "page*.jpg")):
        pages_by_file[os.path.basename(os.path.dirname(preview))].append(preview)
    file_slug = {r["catalog"]: os.path.dirname(r["path"]) for r in index}
    page_size = {(r["catalog"], r["page"]): r["page_size"] for r in index}
    by_file = defaultdict(list)
    for k in unmatched:
        for f in title_files.get(catalog_of.get(k)) or ():
            by_file[f].append((k, old[k]["path"]))
    jobs = []
    for f, tiles in by_file.items():
        previews = []
        for p in pages_by_file.get(file_slug.get(f, ""), []):
            n = int(re.search(r"page(\d+)", p).group(1))
            size = page_size.get((f, n)) or next(v for (c, _), v in page_size.items() if c == f)
            previews.append((n, p, size))
        jobs.append((f, previews, tiles))
    with ProcessPoolExecutor() as pool:
        for f, found in pool.map(search_catalog, jobs):
            for k, (score, page, box) in found.items():
                if k not in matches or matches[k]["score"] < score:
                    matches[k] = {"how": "page", "score": round(float(score), 3), "catalog": f, "page": page,
                                  "box": [round(v, 1) for v in box]}
    print(f"after page search: {len(matches)} of {len(keys)} tiles", flush=True)

    # write the pictures
    docs = {}
    for k, v in sorted(matches.items()):
        name = slug(k.replace("|", " ")) + ".jpg"
        if v["how"] == "stored":
            img = read(os.path.join(pics_dir, v["src"]))
        else:
            pdf = os.path.join(work, "pdf", file_slug[v["catalog"]] + ".pdf")
            doc = docs.get(pdf) or docs.setdefault(pdf, pymupdf.open(pdf))
            pix = doc[v["page"] - 1].get_pixmap(dpi=300, clip=pymupdf.Rect(v["box"]))
            img = cv2.imdecode(np.frombuffer(pix.tobytes("jpg"), np.uint8), cv2.IMREAD_COLOR)
        v["px"] = save_pair(img, name, out)
        v["file"] = name
    json.dump(matches, open(os.path.join(out, "matches.json"), "w"), indent=0)
    sizes = [v["px"] for v in matches.values()]
    print(f"done: {len(matches)} pictures, median longest side {int(np.median(sizes))} px", flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:4])
