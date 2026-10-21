"""Shrink the matched tile pictures to phone size and send them to the "tiles" bucket.

Usage: python3 tools/upload_pictures.py prepare WORK_DIR OUT_DIR [OLD_PICTURES_DIR]
       python3 tools/upload_pictures.py send OUT_DIR
"prepare" makes the phone-size files in OUT_DIR/hd and OUT_DIR/thumb plus OUT_DIR/pictures.json;
"send" uploads them (files already sent are listed in OUT_DIR/sent.txt and skipped).
Reads WORK_DIR/hd/matches.json and WORK_DIR/hd/*.jpg (made by match_pictures.py).
Tiles with no sharp match fall back to their small picture from the old build
(OLD_PICTURES_DIR/brands/*_images.json), so every tile that had a picture keeps one.
Each tile gets hd/<name>.webp (up to 1200 px, sharp on any phone) and thumb/<name>.webp
(320 px, for result lists). Supabase's free plan holds 1 GB, which this keeps under.
pictures.json is what load_tiles.py reads.
Needs GARG_UPLOAD_TOKEN in the environment.
"""
import glob
import io
import json
import os
import re
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


def norm(k):  # same key as load_tiles.key()
    brand, name = k.split("|", 1)
    return brand + "|" + re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()


def prepare(work, out, old_dir=None):
    matches = json.load(open(os.path.join(work, "hd", "matches.json")))
    sources = {norm(k): (os.path.join(work, "hd", v["file"]), v["file"].rsplit(".", 1)[0]) for k, v in matches.items()}
    sharp = len(sources)
    if old_dir:
        for f in sorted(glob.glob(os.path.join(old_dir, "brands", "*_images.json"))):
            for k, v in json.load(open(f)).items():
                stem = re.sub(r"[^a-z0-9]+", "-", norm(k).lower()).strip("-")[:80]
                sources.setdefault(norm(k), (os.path.join(old_dir, v["file"]), stem))
    for kind in SIZES:
        os.makedirs(os.path.join(out, kind), exist_ok=True)

    def one(item):
        k, (src, stem) = item
        paths = {}
        for kind, (side, q) in SIZES.items():
            dest = f"{kind}/{stem}.webp"
            if not os.path.exists(os.path.join(out, dest)):
                data = webp(src, side, q)
                with open(os.path.join(out, dest), "wb") as f:
                    f.write(data)
            paths["image" if kind == "hd" else "thumb"] = dest
        return k, paths

    with ThreadPoolExecutor(4) as pool:
        pictures = dict(pool.map(one, sources.items()))
    json.dump(pictures, open(os.path.join(out, "pictures.json"), "w"))
    size = sum(os.path.getsize(os.path.join(out, p)) for v in pictures.values() for p in v.values())
    print(f"{len(pictures)} tiles with pictures ({sharp} sharp), {size / 1e6:.0f} MB")


def send_all(out):
    pictures = json.load(open(os.path.join(out, "pictures.json")))
    sent_path = os.path.join(out, "sent.txt")
    sent = set(open(sent_path).read().split()) if os.path.exists(sent_path) else set()
    todo = sorted({p for v in pictures.values() for p in v.values()} - sent)

    def one(dest):
        send(dest, open(os.path.join(out, dest), "rb").read())
        return dest

    with ThreadPoolExecutor(8) as pool, open(sent_path, "a") as log:
        for i, dest in enumerate(pool.map(one, todo), 1):
            log.write(dest + "\n")
            if i % 500 == 0 or i == len(todo):
                log.flush()
                print(f"{i}/{len(todo)} files sent", flush=True)


if __name__ == "__main__":
    if sys.argv[1] == "prepare":
        prepare(*sys.argv[2:5])
    else:
        send_all(sys.argv[2])
