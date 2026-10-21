"""Fourth pass: take the tile's own face picture from the catalog page that prints its name.

Usage: python3 tools/name_layout_pictures.py OLD_PICTURES_DIR TILES.json WORK_DIR
Many catalogs (Itaca and others) give each tile a page: a room photo, the full tile face and
the tile's name. For tiles still without a sharp picture, find pages whose text has the tile's
name, then pick the biggest picture on that page shaped like the tile (600x1200 = 1:2, either
way up) and close in colour to the tile's old small picture. Adds to WORK_DIR/hd/matches.json.
"""
import glob
import json
import os
import re
import sys
from collections import defaultdict

import numpy as np
import pymupdf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from check_colours import mean_lab  # noqa: E402
from load_tiles import key, split_decors  # noqa: E402
from match_pictures import read, save_pair, slug  # noqa: E402

MAX_COLOUR = 15.0   # average Lab colour difference allowed against the old small picture
MAX_PAGES = 8       # a name printed on more pages than this is too common to trust


def norm(text):
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def ratios(design):
    out = set()
    for o in design["offers"]:
        m = re.match(r"([\d.]+)x([\d.]+)", o.get("size") or "")
        if m:
            a, b = float(m.group(1)), float(m.group(2))
            if a and b:
                out.add(max(a, b) / min(a, b))
    return out


FINISH_WORDS = {"matt", "endless", "glossy", "polished", "carving", "lapato", "gloss", "satin", "rustic"}


def drop_shared(matches):
    """One page picture given to two different tiles means at least one is wrong: drop them all,
    unless the names differ only by finish words ("Iconic Gris" and "Iconic Gris Matt")."""
    by = defaultdict(list)
    for k, v in matches.items():
        if v["how"] in ("name", "decor"):
            by[v["src"]].append(k)
    for ks in by.values():
        names = sorted((k.split("|", 1)[1] for k in ks), key=len)
        base = names[0]
        same = len({k.split("|")[0] for k in ks}) == 1 and all(
            n == base or (n.startswith(base + " ") and set(n[len(base):].split()) <= FINISH_WORDS) for n in names)
        if len(ks) > 1 and not same:
            for k in ks:
                del matches[k]


def main(old_dir, tiles_path, work):
    out = os.path.join(work, "hd")
    matches = json.load(open(os.path.join(out, "matches.json")))
    old = {}
    for f in sorted(glob.glob(os.path.join(old_dir, "brands", "*_images.json"))):
        for k, v in json.load(open(f)).items():
            old[k] = os.path.join(old_dir, v["file"])
    designs = {key(d["brand"], d["name"]): d for d in split_decors(json.load(open(tiles_path))["designs"])}
    todo = {k: d for k, d in designs.items() if k not in matches and ratios(d)}

    images = defaultdict(list)
    for line in open(os.path.join(work, "pics", "index.jsonl")):
        r = json.loads(line)
        images[(os.path.dirname(r["path"]), r["page"])].append(r)

    # where each name is printed: name -> [(folder, page, [x0, x1] of the text)]
    wanted = defaultdict(list)
    for k, d in todo.items():
        name = norm(d["name"])
        if len(name) >= 4:
            wanted[name].append(k)
    seen = defaultdict(list)
    for pdf in sorted(glob.glob(os.path.join(work, "pdf", "*.pdf"))):
        folder = os.path.basename(pdf)[:-4]
        try:
            doc = pymupdf.open(pdf)
        except Exception:
            continue
        for p in doc:
            if not images.get((folder, p.number + 1)):
                continue
            for b in p.get_text("blocks"):
                text = " " + norm(b[4]) + " "
                for name in wanted:
                    if " " + name + " " in text:
                        seen[name].append((folder, p.number + 1, (b[0], b[2])))
    print(f"{len(todo)} tiles left, {sum(1 for n in wanted if seen[n])} names found on a page", flush=True)

    found = 0
    for name, keys in wanted.items():
        spots = seen[name]
        if not spots or len({(f, p) for f, p, _ in spots}) > MAX_PAGES:
            continue
        for k in keys:
            d = designs[k]
            cands = []
            for folder, page, (tx0, tx1) in spots:
                for img in images[(folder, page)]:
                    w, h = img["w"], img["h"]
                    if min(w, h) < 250:
                        continue
                    r = max(w, h) / min(w, h)
                    if not any(abs(r / want - 1) < 0.08 for want in ratios(d)):
                        continue
                    x0, _, x1, _ = img["bbox"]
                    cands.append(((min(tx1, x1) - max(tx0, x0) > 0, w * h), img))
            # best first: under the name, then biggest; the first one close in colour wins
            small = read(old[k]) if k in old else None
            img = pic = None
            for _, c in sorted(cands, key=lambda c: c[0], reverse=True)[:6]:
                p = read(os.path.join(work, "pics", c["path"]))
                if p is None:
                    continue
                if small is None or float(np.linalg.norm(mean_lab(small) - mean_lab(p))) <= MAX_COLOUR:
                    img, pic = c, p
                    break
            if img is None:
                continue
            file = slug(k.replace("|", " ")) + ".jpg"
            matches[k] = {"how": "name", "catalog": img["catalog"], "page": img["page"], "src": img["path"],
                          "file": file, "px": save_pair(pic, file, out)}
            found += 1
    drop_shared(matches)
    json.dump(matches, open(os.path.join(out, "matches.json"), "w"), indent=0)
    print(f"done: {found} more tiles found, {len(matches)} tiles have sharp pictures", flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:4])
