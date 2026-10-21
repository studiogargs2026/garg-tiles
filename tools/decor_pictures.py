"""Find the picture of each decor tile made by load_tiles.split_decors.

Usage: python3 tools/decor_pictures.py TILES.json WORK_DIR
For each decor, find a catalog page whose text names it ("<tile> decor 04", also the
"decore" misspelling), then take the picture printed just above (or else below) that name.
Adds the pictures to WORK_DIR/hd/ and WORK_DIR/hd/matches.json under the decor's own name.
Decors not found keep the main tile's picture.
"""
import glob
import json
import os
import re
import sys

import pymupdf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from load_tiles import key, split_decors  # noqa: E402
from match_pictures import read, save_pair, slug  # noqa: E402
from name_layout_pictures import ratios  # noqa: E402


def norm(text):
    text = re.sub(r"[^a-z0-9]+", " ", text.lower())
    text = re.sub(r"\bdecore\b", "decor", text)
    return re.sub(r"\b0+(\d)", r"\1", text).strip()      # "decor 04" and "decor 4" read the same


def distance(a, b):
    """Gap between two page rectangles (0 when they touch or overlap)."""
    dx = max(0, b[0] - a[2], a[0] - b[2])
    dy = max(0, b[1] - a[3], a[1] - b[3])
    return (dx * dx + dy * dy) ** 0.5


def picture_near(block, images):
    """The picture whose column overlaps the text block and sits closest above it (else below)."""
    bx0, by0, bx1, by1 = block
    best = None
    for img in images:
        x0, y0, x1, y1 = img["bbox"]
        if min(bx1, x1) - max(bx0, x0) < 0.5 * min(bx1 - bx0, x1 - x0):
            continue
        gap = by0 - y1 if y1 <= by0 + 5 else (y0 - by1 + 1000 if y0 >= by1 - 5 else None)
        if gap is not None and (best is None or gap < best[0]):
            best = (gap, img)
    return best[1] if best else None


def main(tiles_path, work):
    decors = [d for d in split_decors(json.load(open(tiles_path))["designs"]) if "decor_of" in d]
    out = os.path.join(work, "hd")
    matches = json.load(open(os.path.join(out, "matches.json")))
    images = {}
    for line in open(os.path.join(work, "pics", "index.jsonl")):
        r = json.loads(line)
        images.setdefault((os.path.dirname(r["path"]), r["page"]), []).append(r)

    pages = []   # (folder, page number, [(block rect, normalised text)])
    for pdf in sorted(glob.glob(os.path.join(work, "pdf", "*.pdf"))):
        folder = os.path.basename(pdf)[:-4]
        try:
            doc = pymupdf.open(pdf)
        except Exception:
            continue
        for p in doc:
            blocks = [(b[:4], " " + norm(b[4]) + " ") for b in p.get_text("blocks") if "decor" in norm(b[4])]
            if blocks:
                pages.append((folder, p.number + 1, blocks))

    found = 0
    for d in decors:
        want = " " + norm(d["name"]) + " "
        # every picture printed near the decor's name on any page and shaped like the tile (so not a
        # room photo); the biggest close one wins, so a large face beats a small swatch on an index page
        want_r = ratios(d)
        best = None
        for folder, page, blocks in pages:
            for rect, text in blocks:
                if want not in text:
                    continue
                for img in images.get((folder, page), []):
                    w, h = img["w"], img["h"]
                    if w * h < 150 * 150 or not any(abs(max(w, h) / min(w, h) / r - 1) < 0.08 for r in want_r):
                        continue
                    score = img["w"] * img["h"] / (1 + distance(rect, img["bbox"]) / 40) ** 2
                    if best is None or score > best[0]:
                        best = (score, img)
        hit = best[1] if best else None
        if not hit:
            # no tile-shaped picture: the one printed just above (or below) the name
            for folder, page, blocks in pages:
                hit = next((h for rect, text in blocks if want in text
                            for h in [picture_near(rect, images.get((folder, page), []))] if h), None)
                if hit:
                    break
        if not hit:
            continue
        img = read(os.path.join(work, "pics", hit["path"]))
        if img is None:
            continue
        k = key(d["brand"], d["name"])
        name = slug(k.replace("|", " ")) + ".jpg"
        matches[k] = {"how": "decor", "catalog": hit["catalog"], "page": hit["page"], "src": hit["path"],
                      "file": name, "px": save_pair(img, name, out)}
        found += 1
    json.dump(matches, open(os.path.join(out, "matches.json"), "w"), indent=0)
    print(f"{found} of {len(decors)} decors have their own picture")


if __name__ == "__main__":
    main(*sys.argv[1:3])
