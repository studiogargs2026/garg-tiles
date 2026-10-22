# Garg Tiles

Phone app "SalesDesk" (shown as "SalesDesk by Garg"; was "Master View") for the Garg Studio and KP Enterprises sales teams: search tiles by name or photo, see catalog
pictures, sizes, finishes, packing and suggested selling price. Admins also see cost price.

- **App**: plain HTML/JS in this folder, served by GitHub Pages. Staff open the link and
  tap "Add to Home Screen".
- **Login, data, pictures**: Supabase project `garg-tiles`. Database rules are in
  `supabase/schema.sql`; cost prices are in `offer_costs`, readable by admins only.
- **Updates** (run by hand for now, from a Claude session; WORK is a scratch folder,
  DATA is `/mnt/project-files/tile-app/v2`):
  1. `tools/catalog_pictures.py LIST.tsv WORK` downloads the catalogs from Drive and pulls out every picture.
  2. `tools/match_pictures.py OLD_BUILD TILES.json WORK [yes|no]` picks each tile's full-quality picture.
  3. `tools/catalog_specs.py WORK` reads thickness and box weight from the packing tables.
  4. `tools/upload_pictures.py prepare WORK DATA OLD_BUILD`, then `send DATA` uploads the pictures.
  5. `tools/load_tiles.py TILES.json DATA` sends tiles, prices and suggested selling prices.
  Steps 4 (send) and 5 go through the `admin-upload` function and need `GARG_UPLOAD_TOKEN`:
  make one with `python3 -c "import secrets;print(secrets.token_urlsafe(32))"` and store its
  sha256 in `public.upload_tokens`.

**Photo search** (`photo.js`) runs a free picture model on the phone (ConvNeXt-Tiny via
onnxruntime-web, in `vendor/`), so no paid service is used. After pictures change, refresh the
catalog fingerprints (THUMBS = a folder of the bucket's 320px `thumb/` files, ~35 min on 4 CPUs):
`tools/photo_vectors.py vectors vendor/model/tile-match-v1.onnx THUMBS OUT`, then
`GARG_UPLOAD_TOKEN=... tools/photo_vectors.py send OUT`. Phones pick up the new fingerprints the
next time Photo is opened. Highlighter options come from `highlighter_thumbs()` in the database.

No prices or catalog files are kept in this repository.
