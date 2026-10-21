"""Pull every picture out of the catalog PDFs at the resolution it was printed with.

Usage: python3 tools/catalog_pictures.py CATALOG_LIST.tsv WORK_DIR
CATALOG_LIST.tsv has one catalog per line: drive_file_id <tab> file name <tab> size in bytes.
Catalogs go to WORK_DIR/pdf/, pictures to WORK_DIR/pics/<catalog>/, and one line per
picture is appended to WORK_DIR/pics/index.jsonl. Catalogs already done are skipped,
so the script can be stopped and run again.
"""
import json
import os
import re
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor

import pymupdf

MIN_SIDE = 160      # smaller pictures are logos and icons
MAX_SIDE = 2400     # bigger is never needed on a phone
PAGE_DPI = 100      # page previews, used to find tiles that are not separate pictures


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:80]


def download(file_id, dest):
    if os.path.exists(dest):
        return
    url = f"https://drive.usercontent.google.com/download?id={file_id}&export=download&confirm=t"
    subprocess.run(["curl", "-sSL", "--retry", "4", "-o", dest + ".part", url], check=True)
    os.rename(dest + ".part", dest)


def extract(pdf_path, out_dir, catalog):
    os.makedirs(out_dir, exist_ok=True)
    rows = []
    doc = pymupdf.open(pdf_path)
    for page in doc:
        page.get_pixmap(dpi=PAGE_DPI).save(os.path.join(out_dir, f"page{page.number + 1}.jpg"), jpg_quality=80)
        seen = set()
        for n, info in enumerate(page.get_image_info(xrefs=True)):
            xref = info.get("xref")
            if not xref or info["width"] < MIN_SIDE or info["height"] < MIN_SIDE:
                continue
            box = pymupdf.Rect(info["bbox"])
            visible = box & page.rect
            if visible.is_empty or visible.width < 20 or visible.height < 20 or (xref, tuple(box)) in seen:
                continue
            seen.add((xref, tuple(box)))
            try:
                pix = pymupdf.Pixmap(doc, xref)
                if pix.n - pix.alpha >= 4:          # CMYK
                    pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
                if pix.alpha:
                    pix = pymupdf.Pixmap(pix, 0)
            except Exception:
                continue
            # keep only the part that shows on the page (pictures often bleed off the edge)
            sx, sy = pix.width / box.width, pix.height / box.height
            clip = pymupdf.IRect(
                int((visible.x0 - box.x0) * sx), int((visible.y0 - box.y0) * sy),
                int((visible.x1 - box.x0) * sx), int((visible.y1 - box.y0) * sy),
            ) & pymupdf.IRect(0, 0, pix.width, pix.height)
            if clip.width < MIN_SIDE or clip.height < MIN_SIDE:
                continue
            if clip != pix.irect:
                part = pymupdf.Pixmap(pix.colorspace, clip, False)
                part.copy(pix, clip)
                pix = part
            if max(pix.width, pix.height) > MAX_SIDE:
                pix.shrink(1 if max(pix.width, pix.height) < 2 * MAX_SIDE else 2)
            name = f"p{page.number + 1}-{n}.jpg"
            pix.save(os.path.join(out_dir, name), jpg_quality=90)
            rows.append({
                "catalog": catalog, "page": page.number + 1, "path": os.path.join(os.path.basename(out_dir), name),
                "w": pix.width, "h": pix.height, "bbox": [round(v, 1) for v in visible], "page_size": [page.rect.width, page.rect.height],
            })
    return rows


def run_one(args):
    file_id, name, work = args
    pdf = os.path.join(work, "pdf", slug(name) + ".pdf")
    out = os.path.join(work, "pics", slug(name))
    done = out + ".done"
    if os.path.exists(done):
        return name, None
    download(file_id, pdf)
    rows = extract(pdf, out, name)
    with open(done, "w") as f:
        json.dump(rows, f)
    return name, rows


def main(listing, work):
    os.makedirs(os.path.join(work, "pdf"), exist_ok=True)
    os.makedirs(os.path.join(work, "pics"), exist_ok=True)
    jobs, sizes = [], set()
    for line in open(listing):
        file_id, name, size = line.rstrip("\n").split("\t")[:3]
        if size in sizes:            # the same catalog uploaded twice
            continue
        sizes.add(size)
        jobs.append((file_id, name, work))
    with ProcessPoolExecutor(3) as pool, open(os.path.join(work, "pics", "index.jsonl"), "a") as index:
        for i, (name, rows) in enumerate(pool.map(run_one, jobs), 1):
            if rows is not None:
                for r in rows:
                    index.write(json.dumps(r) + "\n")
                index.flush()
            print(f"{i}/{len(jobs)} {name}: {'skipped' if rows is None else len(rows)} pictures", flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:3])
