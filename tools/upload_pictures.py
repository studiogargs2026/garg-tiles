"""Shrink the matched tile pictures to phone size and send them to the "tiles" bucket.

Usage: python3 tools/upload_pictures.py WORK_DIR
Reads WORK_DIR/hd/matches.json and WORK_DIR/hd/*.jpg (made by match_pictures.py).
Each tile gets hd/<name>.webp (up to 1200 px, sharp on any phone) and thumb/<name>.webp
(320 px, for result lists). Supabase's free plan holds 1 GB, which this keeps under.
Writes WORK_DIR/pictures.json for load_tiles.py. Pictures already sent are skipped.
Needs GARG_UPLOAD_TOKEN in the environment.
"""
import io
import json
import os
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from PIL import Image

FUNCTION_URL = "https://sdsvuhwfzqkmiktysqsy.supabase.co/functions/v1/admin-upload"
SIZES = {"hd": (1200, 80), "thumb": (320, 72)}


def webp(path, side, quality):
    im = Image.open(path).convert("RGB")
    im.thumbnail((side, side), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=quality, method=5)
    return buf.getvalue()


def send(dest, data):
    req = urllib.request.Request(
        f"{FUNCTION_URL}?op=file&path={urllib.parse.quote(dest)}", data=data, method="POST",
        headers={"x-upload-token": os.environ["GARG_UPLOAD_TOKEN"], "content-type": "image/webp"},
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except Exception:
            if attempt == 3:
                raise


def main(work):
    matches = json.load(open(os.path.join(work, "hd", "matches.json")))
    out_path = os.path.join(work, "pictures.json")
    done = json.load(open(out_path)) if os.path.exists(out_path) else {}
    todo = [(k, v["file"]) for k, v in matches.items() if k not in done]
    total = {"bytes": 0}

    def one(item):
        k, file = item
        stem = file.rsplit(".", 1)[0]
        paths = {}
        for kind, (side, q) in SIZES.items():
            data = webp(os.path.join(work, "hd", file), side, q)
            send(f"{kind}/{stem}.webp", data)
            total["bytes"] += len(data)
            paths["image" if kind == "hd" else "thumb"] = f"{kind}/{stem}.webp"
        return k, paths

    with ThreadPoolExecutor(8) as pool:
        for i, (k, paths) in enumerate(pool.map(one, todo), 1):
            done[k] = paths
            if i % 250 == 0 or i == len(todo):
                json.dump(done, open(out_path, "w"))
                print(f"{i}/{len(todo)} pictures, {total['bytes'] / 1e6:.0f} MB so far", flush=True)


if __name__ == "__main__":
    main(sys.argv[1])
