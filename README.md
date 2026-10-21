# Garg Tiles

Phone app for the Garg Studio sales team: search tiles by name or photo, see catalog
pictures, sizes, finishes, packing and suggested selling price. Admins also see cost price.

- **App**: plain HTML/JS in this folder, served by GitHub Pages. Staff open the link and
  tap "Add to Home Screen".
- **Login, data, pictures**: Supabase project `garg-tiles`. Database rules are in
  `supabase/schema.sql`; cost prices are in `offer_costs`, readable by admins only.
- **Updates** (run by hand for now, from a Claude session):
  1. `tools/catalog_pictures.py` downloads the catalogs from Drive and pulls out every picture.
  2. `tools/match_pictures.py` picks each tile's full-quality picture.
  3. `tools/load_tiles.py` sends tiles, prices and pictures to Supabase through the
     `admin-upload` function (needs `GARG_UPLOAD_TOKEN`).

No prices or catalog files are kept in this repository.
