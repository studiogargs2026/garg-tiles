"""Find each tile's full-quality picture among the pictures pulled out of the catalogs.

Usage: python3 tools/match_pictures.py OLD_PICTURES_DIR TILES.json WORK_DIR [yes|no]
(no = skip the slow search inside pages; tiles found that way keep their old small picture)
OLD_PICTURES_DIR is the old build folder: brands/*_images.json map "Brand|name" to a small
picture of that tile. Each small picture is looked up among WORK_DIR/pics (made by
catalog_pictures.py): first among the pictures stored in the PDFs, then, for tiles printed
as part of a bigger page, inside the page itself, which is then cut out at 300 dpi.
Writes WORK_DIR/hd/<slug>.jpg (up to 1600 px) plus thumbnails, and WORK_DIR/hd/matches.json.
"""
import glob
import json
import os
import pickle
import re
import sys
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor

import cv2
import numpy as np
import pymupdf

SIDE = 16
ACCEPT = 0.92        # pattern similarity needed to trust a stored picture
MAX_COLOUR = 10.0    # average colour difference allowed (Lab units)
FLAT = 6.0           # below this contrast a tile is plain, so colour must match closely
HD_SIDE = 1600
THUMB_SIDE = 400


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:80]


def descriptor(img):
    """Pattern (light/dark layout, scaled to unit length) plus average colour and contrast.
    Pattern alone is not enough: two plain tiles of different colours have the same pattern."""
    small = cv2.resize(img, (SIDE, SIDE), interpolation=cv2.INTER_AREA)
    lab = cv2.cvtColor(small, cv2.COLOR_BGR2LAB).astype(np.float32)
    light = lab[..., 0].ravel()
    contrast = float(light.std())
    v = light - light.mean()
    return v / (np.linalg.norm(v) + 1e-6), lab.reshape(-1, 3).mean(0), contrast


def read(path):
    data = np.fromfile(path, np.uint8)
    return cv2.imdecode(data, cv2.IMREAD_COLOR) if data.size else None


def describe(path):
    img = read(path)
    if img is None:
        return None
    h, w = img.shape[:2]
    return (*descriptor(img), w / h)


def save_pair(img, name, out):
    h, w = img.shape[:2]
    for side, sub in ((HD_SIDE, ""), (THUMB_SIDE, "thumb/")):
        scale = min(1.0, side / max(h, w))
        im = cv2.resize(img, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA) if scale < 1 else img
        cv2.imwrite(os.path.join(out, sub + name), im, [cv2.IMWRITE_JPEG_QUALITY, 88 if sub else 80])
    return max(h, w)


def page_features(path):
    img = read(path)
    if img is None:
        return None
    kp, des = cv2.SIFT_create(nfeatures=500).detectAndCompute(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), None)
    if des is None:
        return None
    return np.array([k.pt for k in kp], np.float32), des, img.shape[:2]


def tile_features(path):
    img = read(path)
    if img is None:
        return None
    img = cv2.resize(img, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)   # small pictures give few points
    kp, des = cv2.SIFT_create(nfeatures=400).detectAndCompute(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), None)
    if des is None or len(kp) < 8:
        return None
    return np.array([k.pt for k in kp], np.float32) / 2, des, img.shape[:2]


def main(old_dir, tiles_path, work, page_search="yes"):
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
    keys = sorted(old)
    cache = os.path.join(work, "descriptors.pkl")   # describing 40k pictures is the slow part
    if os.path.exists(cache) and os.path.getmtime(cache) > os.path.getmtime(os.path.join(pics_dir, "index.jsonl")):
        cand, mine = pickle.load(open(cache, "rb"))
    else:
        with ProcessPoolExecutor() as pool:
            cand = list(pool.map(describe, [os.path.join(pics_dir, r["path"]) for r in index], chunksize=64))
            mine = list(pool.map(describe, [old[k]["path"] for k in keys], chunksize=64))
        pickle.dump((cand, mine), open(cache, "wb"))
    ok = [i for i, c in enumerate(cand) if c is not None]
    C = np.stack([cand[i][0] for i in ok]).astype(np.float32)
    C_colour = np.stack([cand[i][1] for i in ok]).astype(np.float32)
    C_ratio = np.array([cand[i][3] for i in ok])
    file_brand = {}

    def best_match(k, m, only_brand=None):
        pattern, colour, contrast, ratio = m
        sims = C @ pattern
        dist = np.linalg.norm(C_colour - colour, axis=1)
        bad = (np.abs(np.log(C_ratio / ratio)) >= 0.2) | (dist > (MAX_COLOUR if contrast >= FLAT else MAX_COLOUR / 2))
        if only_brand:
            bad |= np.array([file_brand.get(index[i]["catalog"]) != only_brand for i in ok])
        sims[bad] = -1
        j = int(sims.argmax())
        if sims[j] < ACCEPT:
            return None
        r = index[ok[j]]
        return {"how": "stored", "score": round(float(sims[j]), 3), "colour_diff": round(float(dist[j]), 1),
                "catalog": r["catalog"], "page": r["page"], "src": r["path"]}

    matches, unmatched = {}, []
    mine_by_key = {}
    for k, m in zip(keys, mine):
        if m is None:
            continue
        mine_by_key[k] = m
        hit = best_match(k, m)
        if hit:
            matches[k] = hit
        else:
            unmatched.append(k)

    # Plain tiles look alike across brands: a match must come from a catalog whose other
    # matches are mostly the same brand, otherwise retry within that brand's catalogs.
    votes = defaultdict(Counter)
    for k, v in matches.items():
        votes[v["catalog"]][k.split("|")[0]] += 1
    file_brand.update({f: c.most_common(1)[0][0] for f, c in votes.items()})
    for k in [k for k, v in matches.items() if file_brand[v["catalog"]] != k.split("|")[0]]:
        hit = best_match(k, mine_by_key[k], only_brand=k.split("|")[0])
        if hit:
            matches[k] = hit
        else:
            del matches[k]
            unmatched.append(k)
    print(f"stored pictures: {len(matches)} of {len(keys)} tiles", flush=True)

    # Tiles printed as part of a bigger page: find them by their details (SIFT points)
    # among every catalog page, then cut them out of the PDF at 300 dpi.
    if page_search == "yes":
        page_list = sorted(glob.glob(os.path.join(pics_dir, "*", "page*.jpg")))
        with ProcessPoolExecutor() as pool:
            feats = list(pool.map(page_features, page_list, chunksize=16))
            tile_feats = list(pool.map(tile_features, [old[k]["path"] for k in unmatched], chunksize=16))
        owner, points, descs = [], [], []
        for n, f in enumerate(feats):
            if f is not None:
                owner.append(np.full(len(f[0]), n)); points.append(f[0]); descs.append(f[1])
        owner, points = np.concatenate(owner), np.concatenate(points)
        flann = cv2.FlannBasedMatcher({"algorithm": 1, "trees": 4}, {"checks": 64})
        flann.add([np.concatenate(descs)])
        flann.train()
        for k, tf in zip(unmatched, tile_feats):
            if tf is None:
                continue
            pts, des, _ = tf
            pairs = [m for m, n in (p for p in flann.knnMatch(des, k=2) if len(p) == 2) if m.distance < 0.75 * n.distance]
            if len(pairs) < 10:
                continue
            votes = Counter(int(owner[m.trainIdx]) for m in pairs)
            best = None
            for page_no, count in votes.most_common(3):
                if count < 10:
                    break
                src = np.float32([pts[m.queryIdx] for m in pairs if owner[m.trainIdx] == page_no])
                dst = np.float32([points[m.trainIdx] for m in pairs if owner[m.trainIdx] == page_no])
                H, mask = cv2.findHomography(src, dst, cv2.RANSAC, 4.0)
                if H is None or mask.sum() < 10:
                    continue
                th, tw = read(old[k]["path"]).shape[:2]
                corners = cv2.perspectiveTransform(np.float32([[0, 0], [tw, 0], [tw, th], [0, th]]).reshape(-1, 1, 2), H).reshape(-1, 2)
                x0, y0 = corners.min(0)
                x1, y1 = corners.max(0)
                ph, pw = feats[page_no][2]
                ratio = (x1 - x0) / max(y1 - y0, 1)
                if x0 < -5 or y0 < -5 or x1 > pw + 5 or y1 > ph + 5 or abs(np.log(ratio / (tw / th))) > 0.15:
                    continue
                if best is None or mask.sum() > best[0]:
                    best = (int(mask.sum()), page_no, [max(0, x0), max(0, y0), min(pw, x1), min(ph, y1)], pw)
            if best:
                inliers, page_no, box, pw = best
                path = page_list[page_no]
                matches[k] = {"how": "page", "score": inliers, "catalog": os.path.basename(os.path.dirname(path)),
                              "page": int(re.search(r"page(\d+)", path).group(1)),
                              "box_px": [round(float(v), 1) for v in box], "preview_w": pw}
    print(f"after page search: {len(matches)} of {len(keys)} tiles", flush=True)

    # write the pictures
    docs = {}
    for k, v in sorted(matches.items()):
        name = slug(k.replace("|", " ")) + ".jpg"
        if v["how"] == "stored":
            img = read(os.path.join(pics_dir, v["src"]))
        else:
            pdf = os.path.join(work, "pdf", v["catalog"] + ".pdf")   # page matches name the catalog by its file
            doc = docs.get(pdf) or docs.setdefault(pdf, pymupdf.open(pdf))
            page = doc[v["page"] - 1]
            kpt = page.rect.width / v["preview_w"]
            pix = page.get_pixmap(dpi=300, clip=pymupdf.Rect([c * kpt for c in v["box_px"]]) + page.rect.tl)
            img = cv2.imdecode(np.frombuffer(pix.tobytes("jpg"), np.uint8), cv2.IMREAD_COLOR)
        v["px"] = save_pair(img, name, out)
        v["file"] = name
    json.dump(matches, open(os.path.join(out, "matches.json"), "w"), indent=0)
    sizes = [v["px"] for v in matches.values()]
    print(f"done: {len(matches)} pictures, median longest side {int(np.median(sizes))} px", flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:5])
