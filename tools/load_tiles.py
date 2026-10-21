"""Send the tile list (names, sizes, finishes, packing, prices) to Supabase.

Usage: python3 tools/load_tiles.py TILES.json [PICTURES.json]
TILES.json is the merged list made by the old build (designs with offers).
PICTURES.json (optional) maps "Brand|name" to {"image": path, "thumb": path} in the "tiles" bucket.
Needs GARG_UPLOAD_TOKEN in the environment (see supabase/functions/admin-upload).

Pricing: net cost = list rate x (1 - discount %), per sq ft (box rates are divided by the
sq ft in a box when known). This is the price before insurance and GST. Only admins see it.
"""
import json
import os
import sys
import urllib.request

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


def key(brand, name):
    return f"{brand}|{name}".lower()


def main(tiles_path, pictures_path=None):
    designs = json.load(open(tiles_path))["designs"]
    pictures = {k.lower(): v for k, v in json.load(open(pictures_path)).items()} if pictures_path else {}

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
            pic = pictures.get(key(d["brand"], d["name"]), {})
            rows.append({"brand": d["brand"], "name": d["name"], "catalog": d.get("catalog"), "notes": d.get("notes"),
                         "image_path": pic.get("image"), "thumb_path": pic.get("thumb")})
        ids = {key(r["brand"], r["name"]): r["id"] for r in call("rows", rows, table="tiles")["rows"]}
        call("clear_offers", list(ids.values()))

        offers, costs = [], []
        for d in chunk:
            seen = set()
            for o in d["offers"]:
                price, unit, note = net_cost(o)
                sig = (o.get("size"), o.get("finish"), o.get("line"), price)
                if sig in seen:
                    continue
                seen.add(sig)
                offers.append({"tile_id": ids[key(d["brand"], d["name"])], "size": o.get("size"), "finish": o.get("finish"),
                               "series": o.get("line"), "unit": unit, "packing": o.get("box"), "box_sqft": o.get("boxSqft"),
                               "note": " ".join(filter(None, [note, o.get("extra")])) or None})
                costs.append(price)
        made = call("rows", offers, table="offers")["rows"]
        # inserted rows come back in the order they were sent
        call("rows", [{"offer_id": r["id"], "net_cost": c} for r, c in zip(made, costs)], table="offer_costs")
        done += len(chunk)
        print(f"{done}/{len(tiles)} tiles", flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:3])
