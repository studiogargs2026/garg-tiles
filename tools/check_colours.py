"""Drop page matches whose colour differs from the tile's own small picture.

Usage: python3 tools/check_colours.py OLD_PICTURES_DIR WORK_DIR
The page searches look at light/dark detail only, so the same design in another colour
(a pink and a blue marble from one series) can be picked. This compares average colour and
removes those matches from WORK_DIR/hd/matches.json.
"""
import glob
import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from match_pictures import read  # noqa: E402

MAX_DIFF = 12.0   # average Lab colour difference allowed


def mean_lab(img):
    small = cv2.resize(img, (32, 32), interpolation=cv2.INTER_AREA)
    return cv2.cvtColor(small, cv2.COLOR_BGR2LAB).reshape(-1, 3).astype(np.float32).mean(0)


def main(old_dir, work):
    out = os.path.join(work, "hd")
    matches = json.load(open(os.path.join(out, "matches.json")))
    old = {}
    for f in sorted(glob.glob(os.path.join(old_dir, "brands", "*_images.json"))):
        for k, v in json.load(open(f)).items():
            old[k] = os.path.join(old_dir, v["file"])
    dropped = 0
    for k, v in list(matches.items()):
        if v["how"] != "page" or k not in old:
            continue
        a, b = read(old[k]), read(os.path.join(out, v["file"]))
        if a is None or b is None:
            continue
        diff = float(np.linalg.norm(mean_lab(a) - mean_lab(b)))
        if diff > MAX_DIFF:
            del matches[k]
            dropped += 1
    json.dump(matches, open(os.path.join(out, "matches.json"), "w"), indent=0)
    print(f"dropped {dropped} page matches with a different colour, {len(matches)} sharp pictures left")


if __name__ == "__main__":
    main(*sys.argv[1:3])
