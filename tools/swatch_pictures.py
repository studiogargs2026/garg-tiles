"""Cut tile pictures from catalogs that print small swatches with the design names written under them.

Usage: python3 tools/swatch_pictures.py CATALOG.pdf TILES.txt OUT_DIR
TILES.txt has one tile per line: id|name|stored hd size in bytes|design names from its offers, joined by "#".
Swatches stacked in one column get the label lines under the stack, top to bottom (the Itaca 300x600
catalog prints them this way). Each tile gets OUT_DIR/src/<slug>.png rendered from the page at 4x, so
masked swatches come out right; the tile's own design is preferred over its HL/LT/DK/decor variants.
OUT_DIR/designs.json lists every label found and OUT_DIR/rows.json the design chosen per tile.
Look at the pictures before using them: a label under a room photo gives a room photo.
Then feed the good ones to tools/replace_pictures.py.
"""
import json
import os
import re
import sys
import unicodedata

import pymupdf
from PIL import Image, ImageStat

VARIANT = re.compile(r"\b(hl|lt|dk|decor|waves|liner|honey|leaf|a / b)\b", re.I)


def norm(s):
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", s)).strip().lower()


def find_designs(doc):
    designs, problems = {}, []
    for pno, page in enumerate(doc):
        imgs = [pymupdf.Rect(i["bbox"]) for i in page.get_image_info()
                if i["bbox"][2] - i["bbox"][0] < 400 and i["bbox"][3] - i["bbox"][1] > 30]
        lines = []
        for b in page.get_text("dict")["blocks"]:
            for ln in b.get("lines", []):
                t = " ".join(s["text"] for s in ln["spans"]).strip()
                if t:
                    lines.append((ln["bbox"][0], ln["bbox"][1], t))
        lines.sort(key=lambda ln: ln[1])
        blocks = []
        for ln in lines:
            for bl in blocks:
                if abs(bl[-1][0] - ln[0]) < 3 and 0 < ln[1] - bl[-1][1] < 16:
                    bl.append(ln)
                    break
            else:
                blocks.append([ln])
        for bl in blocks:
            top = bl[0][1]
            below = [r for r in imgs if abs(r.x0 - bl[0][0]) < 6 and -2 <= top - r.y1 <= 20]
            if not below:
                continue
            stack = [min(below, key=lambda r: top - r.y1)]
            while True:
                up = [r for r in imgs if abs(r.x0 - stack[0].x0) < 6 and 0 <= stack[0].y0 - r.y1 <= 15]
                if not up:
                    break
                stack.insert(0, up[0])
            names = [ln[2] for ln in bl]
            if len(stack) != len(names):
                problems.append((pno + 1, names, len(stack)))
                if len(stack) < len(names):
                    continue
                stack = stack[-len(names):]  # e.g. "Leaf - A / B" covers two swatches
            for n, r in zip(names, stack):
                designs.setdefault(norm(n), (pno + 1, list(r)))
    return designs, problems


def main(pdf, tiles_file, out):
    doc = pymupdf.open(pdf)
    designs, problems = find_designs(doc)
    for p in problems:
        print("check page", *p)
    os.makedirs(os.path.join(out, "src"), exist_ok=True)
    rows = []
    for line in open(tiles_file):
        tid, name, size, fins = line.rstrip("\n").split("|")
        fins = [f for f in fins.split("#") if f]

        def own(f):
            return re.sub(r"^(g|ng|l|r|rl) ", "", norm(f)) != norm(name)
        pick = next((f for f in sorted(fins, key=lambda f: (own(f), bool(VARIANT.search(f)))) if norm(f) in designs), None)
        if not pick:
            print("no picture found for", name)
            continue
        pg, bb = designs[norm(pick)]
        slug = re.sub(r"[^a-z0-9]+", "-", ("itaca-" + name).lower()).strip("-")
        f = os.path.join(out, "src", slug + ".png")
        doc[pg - 1].get_pixmap(matrix=pymupdf.Matrix(4, 4), clip=pymupdf.Rect(bb) + (1, 1, -1, -1)).save(f)
        detail = sum(ImageStat.Stat(Image.open(f).convert("L")).stddev)
        rows.append([tid, name, size, pick, pg, round(detail, 1), slug])
    json.dump({k: v for k, v in designs.items()}, open(os.path.join(out, "designs.json"), "w"))
    json.dump(rows, open(os.path.join(out, "rows.json"), "w"))
    print(len(rows), "tile pictures cut into", os.path.join(out, "src"))


if __name__ == "__main__":
    main(*sys.argv[1:4])
