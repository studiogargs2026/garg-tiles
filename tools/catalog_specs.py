"""Read thickness and box weight per tile size from the packing tables in the catalogs.

Usage: python3 tools/catalog_specs.py WORK_DIR
Reads WORK_DIR/pdf/*.pdf, writes WORK_DIR/specs.json:
{"<pdf name>": {"sizes": {"60x120 cm": {"mm": 9.0, "kg": 31.0}}, "mm": 9.0 or null}}
"mm" at catalog level is a thickness the catalog states once for everything ("Thickness: 9mm").
"""
import glob
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict

SIZE = re.compile(r"(?<![\d.])(\d{2,4})\s*[xX×*]\s*(\d{2,4})(?:\s*[xX×*]\s*\d{1,2}(?:\.\d)?)?\s*(mm|cm|MM|CM)?")
MM = re.compile(r"(?<![\d.x×])(\d{1,2}(?:\.\d{1,2})?)\s*(?:mm|MM|Mm)\b")
KG = re.compile(r"(\d{1,3}(?:\.\d{1,2})?)\s*(?:kg|KG|Kg|kgs|Kgs)\b")
STATED = re.compile(r"(?:thickness\s*[:\-]?\s*(\d{1,2}(?:\.\d{1,2})?)\s*mm|(\d{1,2}(?:\.\d{1,2})?)\s*mm\s+thick)", re.I)


def size_cm(a, b, unit):
    a, b = int(a), int(b)
    if unit and unit.lower() == "cm" or (not unit and max(a, b) <= 320):
        a, b = a * 10, b * 10
    if not (75 <= min(a, b) and max(a, b) <= 3200):
        return None
    fmt = lambda v: f"{v / 10:g}"
    return f"{fmt(a)}x{fmt(b)} cm"


def parse(text):
    sizes = defaultdict(Counter)
    weights = defaultdict(Counter)
    for line in text.splitlines():
        s = SIZE.search(line)
        if not s:
            continue
        rest = line[s.end():]
        mm = [float(m) for m in MM.findall(rest) if 5 <= float(m) <= 25]
        if not mm:
            continue
        size = size_cm(*s.groups())
        if not size:
            continue
        sizes[size][mm[0]] += 1
        kg = [float(k) for k in KG.findall(rest) if 3 <= float(k) <= 120]
        if kg:
            weights[size][kg[0]] += 1
    stated = Counter(float(a or b) for a, b in STATED.findall(text) if 5 <= float(a or b) <= 25)
    return {
        "sizes": {s: {"mm": c.most_common(1)[0][0], "kg": weights[s].most_common(1)[0][0] if weights[s] else None}
                  for s, c in sizes.items()},
        "mm": stated.most_common(1)[0][0] if len(stated) == 1 else None,
    }


def main(work):
    out = {}
    for pdf in sorted(glob.glob(os.path.join(work, "pdf", "*.pdf"))):
        text = subprocess.run(["pdftotext", "-q", "-layout", pdf, "-"], capture_output=True, text=True).stdout
        out[os.path.basename(pdf)[:-4]] = parse(text)
    json.dump(out, open(os.path.join(work, "specs.json"), "w"), indent=1)
    found = sum(1 for v in out.values() if v["sizes"] or v["mm"])
    print(f"{found} of {len(out)} catalogs state a thickness")


if __name__ == "__main__":
    main(sys.argv[1])
