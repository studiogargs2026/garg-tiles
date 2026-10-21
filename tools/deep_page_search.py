"""Second, more thorough search for tiles that match_pictures.py could not find.

Usage: python3 tools/deep_page_search.py OLD_PICTURES_DIR WORK_DIR
Works one brand at a time: looks at many more detail points on each page of that brand's
catalogs (brand from the file name, or from tiles already found in it), so small swatches
on busy pages are found too. Adds what it finds to WORK_DIR/hd/matches.json and writes the
pictures next to it, like match_pictures.py. Prints progress per brand.
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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from match_pictures import read, save_pair, slug, tile_features  # noqa: E402

PAGE_POINTS = 2500
CHUNK = 300         # pages per search index
BRAND_WORDS = {
    "Icon": ["icon"], "Itaca": ["itaca"], "Renite": ["renite"], "Morson": ["morson"], "Oasis": ["oasis"],
    "Nexona": ["nexona", "nx-royal"], "Colortile": ["colortile", "vita", "bi-mor", "evardo", "vistaro"],
    "Simero": ["simero"], "Seron": ["seron"], "Velbon": ["velbon"], "Subway Tiles LLP": ["subway"],
    "Skyart": ["skyart"], "GruppoNueva": ["grupponueva"], "Status Ceramic": ["status"],
    "Timex Ceramic": ["lookbook", "tmx"],
    "BEJ": ["bej", "athangudi", "moroccan", "cotto-series", "5-subway-series", "jewel", "rock-series", "interstone",
            "cool-roof", "swimming-pool", "30x30-master"],
}


def page_features(path):
    img = read(path)
    if img is None:
        return None
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, None, fx=1.5, fy=1.5, interpolation=cv2.INTER_CUBIC)   # small swatches need detail
    kp, des = cv2.SIFT_create(nfeatures=PAGE_POINTS).detectAndCompute(gray, None)
    if des is None:
        return None
    return np.array([k.pt for k in kp], np.float32) / 1.5, des, img.shape[:2]


def locate(k, tf, small_shape, flann, owner, points, feats):
    pts, des, _ = tf
    pairs = [m for m, n in (p for p in flann.knnMatch(des, k=2) if len(p) == 2) if m.distance < 0.75 * n.distance]
    if len(pairs) < 10:
        return None
    best = None
    for page_no, count in Counter(int(owner[m.trainIdx]) for m in pairs).most_common(3):
        if count < 10:
            break
        src = np.float32([pts[m.queryIdx] for m in pairs if owner[m.trainIdx] == page_no])
        dst = np.float32([points[m.trainIdx] for m in pairs if owner[m.trainIdx] == page_no])
        H, mask = cv2.findHomography(src, dst, cv2.RANSAC, 4.0)
        if H is None or mask.sum() < 10:
            continue
        th, tw = small_shape
        corners = cv2.perspectiveTransform(np.float32([[0, 0], [tw, 0], [tw, th], [0, th]]).reshape(-1, 1, 2), H).reshape(-1, 2)
        x0, y0 = corners.min(0)
        x1, y1 = corners.max(0)
        ph, pw = feats[page_no][2]
        if x0 < -5 or y0 < -5 or x1 > pw + 5 or y1 > ph + 5:
            continue
        if abs(np.log(((x1 - x0) / max(y1 - y0, 1)) / (tw / th))) > 0.15:
            continue
        if best is None or mask.sum() > best[0]:
            best = (int(mask.sum()), page_no, [max(0, x0), max(0, y0), min(pw, x1), min(ph, y1)], pw)
    return best


def main(old_dir, work):
    pics_dir, out = os.path.join(work, "pics"), os.path.join(work, "hd")
    matches = json.load(open(os.path.join(out, "matches.json")))
    old = {}
    for f in sorted(glob.glob(os.path.join(old_dir, "brands", "*_images.json"))):
        for k, v in json.load(open(f)).items():
            if v["kind"] == "tile":
                old[k] = os.path.join(old_dir, v["file"])

    # brand of each catalog: from tiles already found in it, else from words in its file name
    votes = defaultdict(Counter)
    for k, v in matches.items():
        votes[slug(v["catalog"]) if v["how"] == "stored" else v["catalog"]][k.split("|")[0]] += 1
    folders = [d for d in os.listdir(pics_dir) if os.path.isdir(os.path.join(pics_dir, d))]
    brand_folders = defaultdict(list)
    for d in folders:
        brands = {b for b, words in BRAND_WORDS.items() if any(w in d for w in words)}
        if votes[d]:
            brands.add(votes[d].most_common(1)[0][0])
        for b in brands or {None}:
            brand_folders[b].append(d)

    todo = defaultdict(list)
    for k in old:
        if k not in matches:
            todo[k.split("|")[0]].append(k)
    total, found = sum(len(v) for v in todo.values()), 0
    print(f"{total} tiles to look for", flush=True)

    with ProcessPoolExecutor(3) as pool:
        for brand, keys in sorted(todo.items(), key=lambda x: -len(x[1])):
            dirs = brand_folders.get(brand, [])
            pages = sorted(p for d in dirs for p in glob.glob(os.path.join(pics_dir, d, "page*.jpg")))
            if not pages:
                continue
            tile_feats = list(pool.map(tile_features, [old[k] for k in keys], chunksize=8))
            shapes = {k: read(old[k]).shape[:2] for k, tf in zip(keys, tile_feats) if tf is not None}
            best_of = {}
            # a few hundred pages at a time keeps memory in check on big brands
            for start in range(0, len(pages), CHUNK):
                chunk = pages[start:start + CHUNK]
                feats = list(pool.map(page_features, chunk, chunksize=8))
                owner, points, descs = [], [], []
                for n, f in enumerate(feats):
                    if f is not None:
                        owner.append(np.full(len(f[0]), n)); points.append(f[0]); descs.append(f[1])
                if not descs:
                    continue
                owner, points = np.concatenate(owner), np.concatenate(points)
                flann = cv2.FlannBasedMatcher({"algorithm": 1, "trees": 4}, {"checks": 64})
                flann.add([np.concatenate(descs)])
                flann.train()
                for k, tf in zip(keys, tile_feats):
                    if tf is None:
                        continue
                    best = locate(k, tf, shapes[k], flann, owner, points, feats)
                    if best and (k not in best_of or best[0] > best_of[k][0]):
                        best_of[k] = (best[0], chunk[best[1]], best[2], best[3])
                del flann, descs, feats
            hits = 0
            for k, (inliers, path, box, pw) in best_of.items():
                matches[k] = {"how": "page", "score": inliers, "catalog": os.path.basename(os.path.dirname(path)),
                              "page": int(re.search(r"page(\d+)", path).group(1)),
                              "box_px": [round(float(v), 1) for v in box], "preview_w": pw}
                hits += 1
            found += hits
            print(f"{brand}: {hits} of {len(keys)} found ({len(pages)} pages)", flush=True)
            json.dump(matches, open(os.path.join(out, "matches.json"), "w"), indent=0)

    docs = {}
    for k, v in matches.items():
        if v["how"] != "page" or v.get("file"):
            continue
        pdf = os.path.join(work, "pdf", v["catalog"] + ".pdf")
        doc = docs.get(pdf) or docs.setdefault(pdf, pymupdf.open(pdf))
        page = doc[v["page"] - 1]
        kpt = page.rect.width / v["preview_w"]
        x0, y0, x1, y1 = (c * kpt for c in v["box_px"])
        o = page.rect.tl
        pix = page.get_pixmap(dpi=300, clip=pymupdf.Rect(x0 + o.x, y0 + o.y, x1 + o.x, y1 + o.y))
        img = cv2.imdecode(np.frombuffer(pix.tobytes("jpg"), np.uint8), cv2.IMREAD_COLOR)
        v["file"] = slug(k.replace("|", " ")) + ".jpg"
        v["px"] = save_pair(img, v["file"], out)
    json.dump(matches, open(os.path.join(out, "matches.json"), "w"), indent=0)
    print(f"done: {found} more tiles found, {len(matches)} tiles have sharp pictures", flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:3])
