"""Swap in corrected pictures for a few tiles (for example a plain tile that showed its decor).

Usage: python3 tools/replace_pictures.py prepare SRC_DIR OUT_DIR TAG [QUALITY]
       python3 tools/replace_pictures.py send OUT_DIR
SRC_DIR holds one picture per tile, named <brand>-<name>.png the way the tile's slug is made
(lower case, every run of other characters turned into "-"), cut straight from the catalog page.
"prepare" writes OUT_DIR/hd/<slug>-<TAG>.webp and OUT_DIR/thumb/<slug>-<TAG>.webp (a new name, so
phones do not keep showing the old picture) and OUT_DIR/update.sql, which points each tile at its
new files; run that SQL in Supabase after "send". "send" uploads the files (needs GARG_UPLOAD_TOKEN).
QUALITY (WebP, default 80/72) can be raised to about 95 for very pale tiles whose faint pattern
otherwise gets smoothed away.
Afterwards rerun tools/photo_vectors.py so photo search learns the new pictures.
"""
import glob
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from upload_pictures import SIZES, send, webp  # noqa: E402

SLUG_SQL = "trim(both '-' from regexp_replace(lower(brand || '-' || name), '[^a-z0-9]+', '-', 'g'))"


def prepare(src, out, tag, quality=None):
    rows = []
    for f in sorted(glob.glob(os.path.join(src, "*.png")) + glob.glob(os.path.join(src, "*.jpg"))):
        slug = os.path.splitext(os.path.basename(f))[0]
        paths = {}
        for kind, (side, q) in SIZES.items():
            dest = f"{kind}/{slug}-{tag}.webp"
            os.makedirs(os.path.join(out, kind), exist_ok=True)
            with open(os.path.join(out, dest), "wb") as fh:
                fh.write(webp(f, side, int(quality) if quality else q))
            paths[kind] = dest
        rows.append(f"update public.tiles set image_path = '{paths['hd']}', thumb_path = '{paths['thumb']}', "
                    f"updated_at = now() where {SLUG_SQL} = '{slug}';")
    with open(os.path.join(out, "update.sql"), "w") as fh:
        fh.write("\n".join(rows) + "\n")
    print(f"{len(rows)} tiles ready in {out}")


def send_all(out):
    files = sorted(os.path.relpath(p, out) for kind in SIZES for p in glob.glob(os.path.join(out, kind, "*.webp")))
    for i, dest in enumerate(files, 1):
        send(dest, open(os.path.join(out, dest), "rb").read())
        if i % 50 == 0 or i == len(files):
            print(f"{i}/{len(files)} files sent", flush=True)


if __name__ == "__main__":
    if sys.argv[1] == "prepare":
        prepare(*sys.argv[2:6])
    else:
        send_all(sys.argv[2])
