"""Pictures of long planks (Icon Wood 20x120 and the like) printed as small separate images.

Usage: python3 tools/plank_pictures.py OLD_PICTURES_DIR WORK_DIR PDF_NAME [BRAND]
catalog_pictures.py skips pictures this narrow, so the planks never reached WORK_DIR/pics. Here each
tile name printed on a page is paired with the plank picture standing right under it (same left
edge), taken from the PDF at its own resolution, and kept when its colour is close to the tile's old
small picture. Adds to WORK_DIR/hd/matches.json with how = "plank".
"""
import glob
import json
import os
import re
import sys

import cv2
import numpy as np
import pymupdf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from check_colours import mean_lab  # noqa: E402
from match_pictures import read, save_pair, slug  # noqa: E402

MAX_COLOUR = 20.0


def norm(text):
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def main(old_dir, work, pdf_name, brand="Icon"):
    out = os.path.join(work, "hd")
    matches = json.load(open(os.path.join(out, "matches.json")))
    old = {}
    for f in sorted(glob.glob(os.path.join(old_dir, "brands", "*_images.json"))):
        for k, v in json.load(open(f)).items():
            if k.startswith(brand + "|"):
                name = norm(k.split("|", 1)[1])
                old[name] = (k, os.path.join(old_dir, v["file"]))
                if re.fullmatch(r"wood \d+", name):      # "Wood 5402" is printed as just "5402"
                    old.setdefault(name.split()[1], old[name])
    doc = pymupdf.open(os.path.join(work, "pdf", pdf_name))
    found = 0
    for page in doc:
        infos = [i for i in page.get_image_info(xrefs=True) if i["xref"] and max(i["width"], i["height"]) / min(i["width"], i["height"]) >= 3]
        for b in page.get_text("blocks"):
            name = norm(b[4].split("\n")[0])
            if name not in old:
                continue
            k, small_path = old[name]
            under = [i for i in infos if abs(i["bbox"][0] - b[0]) < 12 and 0 <= i["bbox"][1] - b[3] < 60]
            if not under:
                continue
            pix = pymupdf.Pixmap(doc, under[0]["xref"])
            if pix.n - pix.alpha != 3:
                pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
            img = cv2.cvtColor(np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)[..., :3], cv2.COLOR_RGB2BGR)
            small = read(small_path)
            if small is not None and float(np.linalg.norm(mean_lab(small) - mean_lab(img))) > MAX_COLOUR:
                continue
            if small is not None and max(img.shape[:2]) <= 1.3 * max(small.shape[:2]):
                continue
            file = slug(k.replace("|", " ")) + ".jpg"
            matches[k] = {"how": "plank", "catalog": pdf_name, "page": page.number + 1, "src": f"{pdf_name}#xref{under[0]['xref']}",
                          "file": file, "px": save_pair(img, file, out)}
            found += 1
    json.dump(matches, open(os.path.join(out, "matches.json"), "w"), indent=0)
    print(f"{found} planks found")


if __name__ == "__main__":
    main(*sys.argv[1:5])
