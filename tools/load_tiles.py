"""Send the tile list (names, sizes, finishes, packing, prices) to Supabase.

Usage: python3 tools/load_tiles.py TILES.json DATA_DIR
TILES.json is the merged list made by the old build (designs with offers).
From DATA_DIR it reads matches.json (which catalog each tile was found in),
specs.json (thickness and box weight per catalog and size) and pictures.json
("Brand|name" -> {"image": path, "thumb": path} in the "tiles" bucket).
Needs GARG_UPLOAD_TOKEN in the environment (see supabase/functions/admin-upload).

Pricing: net cost = list rate x (1 - discount %), per sq ft (box rates are divided by the
sq ft in a box when known). This is the price before insurance and GST. Only admins see it.
Suggested selling price (Kirti, 2026-10-21) = (net cost + transport) x 1.18 GST x 2, where
transport per sq ft is Rs 12 up to 9 mm thick, Rs 15 above 9 up to 13 mm, Rs 20 above 13 mm,
and Rs 25 for every Timex tile whatever the thickness.
"""
import json
import os
import re
import sys
import urllib.request
from collections import Counter, defaultdict

FUNCTION_URL = "https://sdsvuhwfzqkmiktysqsy.supabase.co/functions/v1/admin-upload"
BATCH = 300


def call(op, payload, **params):
    query = "&".join(f"{k}={v}" for k, v in {"op": op, **params}.items())
    req = urllib.request.Request(
        f"{FUNCTION_URL}?{query}", data=json.dumps(payload).encode(), method="POST",
        headers={"x-upload-token": os.environ["GARG_UPLOAD_TOKEN"], "content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def net_cost(o):
    """Returns (price, unit, note) the way the old app showed it."""
    if o.get("basic") is None:
        return None, "sq ft", None
    net = o["basic"] * (1 - (o.get("disc") or 0) / 100)
    if o.get("unit") == "piece":
        return round(net, 2), "piece", None
    if o.get("unit") == "box":
        if o.get("boxSqft"):
            return round(net / o["boxSqft"], 2), "sq ft", None
        return round(net, 2), "box", "sq ft per box not in catalog"
    return round(net, 2), "sq ft", None


def key(brand, name):  # same as the old build's merge key
    return brand + "|" + re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:80]


FIXED_TRANSPORT = {"Timex Ceramic": 25}


def transport(brand, mm):
    if brand in FIXED_TRANSPORT:
        return FIXED_TRANSPORT[brand]
    return 12 if mm <= 9 else 15 if mm <= 13 else 20


def selling_price(net, unit, brand, mm):
    if net is None or unit != "sq ft":
        return None
    return round((net + transport(brand, mm)) * 1.18 * 2)   # whole rupees (Kirti, 2026-10-21)


class Specs:
    """Thickness and box weight for a tile size, from the catalog the tile was found in
    (or the catalogs where other tiles of the same catalog title were found)."""

    def __init__(self, designs, work):
        self.specs = json.load(open(os.path.join(work, "specs.json")))
        matches = json.load(open(os.path.join(work, "matches.json")))
        self.file_of = {key(*k.split("|", 1)): slug(v["catalog"]) for k, v in matches.items()}
        by_title = defaultdict(Counter)
        for d in designs:
            f = self.file_of.get(key(d["brand"], d["name"]))
            if f:
                by_title[(d["brand"], d.get("catalog"))][f] += 1
        self.title_files = {t: [f for f, _ in c.most_common()] for t, c in by_title.items()}
        # fallback: what this brand's catalogs say for the same size
        brand_files = defaultdict(set)
        for (brand, _), files in self.title_files.items():
            brand_files[brand].update(files)
        self.brand_size = defaultdict(Counter)
        for brand, files in brand_files.items():
            for f in files:
                for size, v in self.specs.get(f, {}).get("sizes", {}).items():
                    self.brand_size[(brand, size)][v["mm"]] += 1

    def lookup(self, d, size):
        files = [self.file_of.get(key(d["brand"], d["name"]))] + self.title_files.get((d["brand"], d.get("catalog")), [])
        for f in filter(None, files):
            spec = self.specs.get(f, {})
            if size in spec.get("sizes", {}):
                return spec["sizes"][size]["mm"], spec["sizes"][size]["kg"]
        for f in filter(None, files):
            if self.specs.get(f, {}).get("mm"):
                return self.specs[f]["mm"], None
        same = self.brand_size.get((d["brand"], size))
        if same:
            return same.most_common(1)[0][0], None
        return None, None


DECOR = re.compile(r"^(decor[^:]*?)\s*(?::|\s-\s)\s*(.*)$", re.I)


def split_decors(designs):
    """A decor printed as a size/finish row ("Decor 04: Matt + Carving") is a different tile
    with its own picture, so it becomes its own tile named "<tile> Decor 04" (Kirti, 2026-10-21)."""
    out = []
    for d in designs:
        plain, decors = [], defaultdict(list)
        for o in d["offers"]:
            m = DECOR.match(o.get("finish") or "")
            if m:
                label = " ".join(w.capitalize() if w.islower() else w for w in m.group(1).split())
                decors[label].append({**o, "finish": m.group(2) or None})
            else:
                plain.append(o)
        if plain or not decors:
            out.append({**d, "offers": plain})
        base = re.sub(r"\s+decor$", "", d["name"], flags=re.I)
        for label, offers in decors.items():
            out.append({**d, "name": f"{base} {label}", "decor_of": d["name"], "offers": offers})
    return out


def main(tiles_path, work):
    designs = split_decors(json.load(open(tiles_path))["designs"])
    pictures = json.load(open(os.path.join(work, "pictures.json")))
    specs = Specs(designs, work)
    tally = Counter()

    # same brand + name twice: keep one tile with every size/finish
    merged = {}
    for d in designs:
        m = merged.setdefault(key(d["brand"], d["name"]), {**d, "offers": []})
        m["offers"].extend(d["offers"])

    tiles = list(merged.values())
    done = 0
    for start in range(0, len(tiles), BATCH):
        chunk = tiles[start:start + BATCH]
        rows = []
        for d in chunk:
            pic = pictures.get(key(d["brand"], d["name"])) or pictures.get(key(d["brand"], d.get("decor_of", "")), {})
            rows.append({"brand": d["brand"], "name": d["name"], "catalog": d.get("catalog"), "notes": d.get("notes"),
                         "image_path": pic.get("image"), "thumb_path": pic.get("thumb")})
        ids = {key(r["brand"], r["name"]): r["id"] for r in call("rows", rows, table="tiles")["rows"]}
        call("clear_offers", list(ids.values()))

        offers, costs = [], []
        for d in chunk:
            seen = set()
            for o in d["offers"]:
                price, unit, note = net_cost(o)
                mm, kg = specs.lookup(d, o.get("size"))
                tally["thickness from catalog" if mm else "thickness assumed 9 mm"] += 1
                if not mm and d["brand"] not in FIXED_TRANSPORT:
                    note = " ".join(filter(None, [note, "Thickness not in catalog, 9 mm assumed for selling price."]))
                sig = (o.get("size"), o.get("finish"), o.get("line"), price)
                if sig in seen:
                    continue
                seen.add(sig)
                offers.append({"tile_id": ids[key(d["brand"], d["name"])], "size": o.get("size"), "finish": o.get("finish"),
                               "series": o.get("line"), "unit": unit, "packing": o.get("box"), "box_sqft": o.get("boxSqft"),
                               "thickness_mm": mm, "weight_kg": kg, "selling_price": selling_price(price, unit, d["brand"], mm or 9),
                               "note": " ".join(filter(None, [note, o.get("extra")])) or None})
                costs.append(price)
        made = call("rows", offers, table="offers")["rows"]
        # inserted rows come back in the order they were sent
        call("rows", [{"offer_id": r["id"], "net_cost": c} for r, c in zip(made, costs)], table="offer_costs")
        done += len(chunk)
        print(f"{done}/{len(tiles)} tiles", flush=True)
    print(dict(tally))


if __name__ == "__main__":
    main(*sys.argv[1:3])
