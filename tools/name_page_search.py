"""Third pass: find a tile on the catalog page that prints its name.

Usage: python3 tools/name_page_search.py OLD_PICTURES_DIR WORK_DIR
For tiles still without a sharp picture, look for the tile's name in the text of every
catalog page, then search only those pages for the tile's small picture at many zooms.
Works for plain tiles too, where detail points are too few. Adds to WORK_DIR/hd/matches.json
and writes the pictures, like the other passes.
"""
import glob
import json
import os
import re
import sys
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor

import cv2
import numpy as np
import pymupdf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from match_pictures import read, save_pair, slug  # noqa: E402

ACCEPT = 0.85
SCALES = np.geomspace(0.4, 5.0, 28)


def norm(text):
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def page_texts(pdf):
    try:
        doc = pymupdf.open(pdf)
    except Exception:
        return pdf, []
    return pdf, [" " + norm(p.get_text()) + " " for p in doc]


def search(args):
    key, small_path, pages = args
    small = read(small_path)
    if small is None:
        return key, None
    best = None
    for preview in pages:
        big = read(preview)
        if big is None:
            continue
        bh, bw = big.shape[:2]
        for scale in SCALES:
            th, tw = round(small.shape[0] * scale), round(small.shape[1] * scale)
            if th < 20 or tw < 20 or th > bh or tw > bw:
                continue
            tmpl = cv2.resize(small, (tw, th), interpolation=cv2.INTER_AREA)
            _, score, _, (x, y) = cv2.minMaxLoc(cv2.matchTemplate(big, tmpl, cv2.TM_CCOEFF_NORMED))
            if best is None or score > best[0]:
                best = (score, preview, [x, y, x + tw, y + th], bw)
    return key, best if best and best[0] >= ACCEPT else None


def main(old_dir, work):
    pics_dir, out = os.path.join(work, "pics"), os.path.join(work, "hd")
    matches = json.load(open(os.path.join(out, "matches.json")))
    old = {}
    for f in sorted(glob.glob(os.path.join(old_dir, "brands", "*_images.json"))):
        for k, v in json.load(open(f)).items():
            if v["kind"] == "tile":
                old[k] = os.path.join(old_dir, v["file"])
    todo = [k for k in old if k not in matches]

    pdfs = sorted(glob.glob(os.path.join(work, "pdf", "*.pdf")))
    with ProcessPoolExecutor(3) as pool:
        texts = dict(pool.map(page_texts, pdfs))
    jobs = []
    for k in todo:
        name = " " + norm(k.split("|", 1)[1]) + " "
        if len(name.strip()) < 3:
            continue
        pages = [os.path.join(pics_dir, os.path.basename(pdf)[:-4], f"page{n + 1}.jpg")
                 for pdf, ts in texts.items() for n, t in enumerate(ts) if name in t]
        if 0 < len(pages) <= 6:          # a name on dozens of pages is too common to help
            jobs.append((k, old[k], pages))
    print(f"{len(todo)} tiles left, {len(jobs)} have their name on a few pages", flush=True)

    found = 0
    with ProcessPoolExecutor(3) as pool:
        for i, (k, best) in enumerate(pool.map(search, jobs, chunksize=4), 1):
            if best:
                score, preview, box, bw = best
                matches[k] = {"how": "page", "score": round(float(score), 3),
                              "catalog": os.path.basename(os.path.dirname(preview)),
                              "page": int(re.search(r"page(\d+)", preview).group(1)), "box_px": box, "preview_w": bw}
                found += 1
            if i % max(1, len(jobs) // 20) == 0:
                print(f"{i}/{len(jobs)} checked, {found} found", flush=True)
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
