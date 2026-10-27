-- Daily stock (2026-10-21). An admin uploads each showroom's stock PDF in the app; the phone reads
-- the rows (name, size, boxes) and sends them to upload_stock, which matches every stock name to a
-- catalog tile by similarity. Names it is unsure about wait for an admin to confirm once; the answer
-- is remembered in stock_aliases and used for every later upload. Staff see Garg + KP stock together.

create index if not exists tiles_name_trgm on public.tiles using gin (lower(name) extensions.gin_trgm_ops);
create index if not exists tiles_brand_name_trgm on public.tiles using gin (lower(brand || ' ' || name) extensions.gin_trgm_ops);

-- "600X1200" (mm), "2X4" (feet), "18X12" / "48X8" (inches), "60x120" (cm) -> "60x120" (cm, small
-- side first, as base_size). Catalog sizes in cm are kept as they are; otherwise sides up to 12 are
-- feet, a side of 100 or more means mm, and anything else is inches (how the showroom writes them).
create or replace function public.stock_size(s text) returns text language plpgsql immutable as $$
declare
  m text[] := regexp_match(lower(coalesce(s, '')), '(\d+(?:\.\d+)?)\s*(?:"|''|ft|mm|cm)?\s*(?:x|\*|×)\s*(\d+(?:\.\d+)?)');
  a numeric; b numeric; k numeric; v numeric[];
begin
  if m is null then return null; end if;
  a := m[1]::numeric; b := m[2]::numeric;
  if least(a, b)::text || 'x' || greatest(a, b)::text in ('60x120', '80x160', '120x180', '120x240', '80x240', '80x300',
      '60x60', '30x60', '120x120', '20x120', '30x90', '80x80', '90x180') then
    k := 1;
  elsif greatest(a, b) <= 12 then k := 30.48;
  elsif greatest(a, b) >= 100 then k := 0.1;
  else k := 2.54;
  end if;
  v := array[a * k, b * k];
  -- 605 mm, 2 ft (61 cm), 18" (45.7 cm) and 48" (122 cm) are the 60, 60, 45 and 120 cm sizes of the catalogs
  for i in 1..2 loop
    v[i] := case when abs(v[i] - round(v[i] / 5) * 5) <= greatest(1.3, v[i] * 0.02) then round(v[i] / 5) * 5 else round(v[i]) end;
  end loop;
  if v[1] = 0 or v[2] = 0 then return null; end if;
  return least(v[1], v[2])::text || 'x' || greatest(v[1], v[2])::text;
end;
$$;

-- one name for each kind of finish, used by the stock filter
create or replace function public.finish_group(f text) returns text language sql immutable as $$
  select case
    when f is null or trim(f) = '' then null
    when f ~* 'carv' then 'Carving'
    when f ~* 'rustic' then 'Rustic'
    when f ~* 'satin|silk' then 'Satin'
    when f ~* 'polish' then 'Polished'
    when f ~* 'gloss|pgvt|\mgl\M|\mhg\M' then 'Glossy'
    when f ~* '\mmatt?e?\M|\mmt\M' then 'Matt'
    when f ~* 'lust' then 'Luster'
    when f ~* 'granula|sugar' then 'Sugar'
    when f ~* 'punch' then 'Punch'
    when f ~* 'decor|highlight|\mhl\M' then 'Decor / Highlighter'
    else null end
$$;

-- the stock name without size, finish and packing words, for comparing with catalog names
create or replace function public.stock_clean(s text) returns text language sql immutable as $$
  select trim(regexp_replace(regexp_replace(regexp_replace(translate(lower(coalesce(s, '')), 'áàâäãéèêëíìîïóòôöõúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn'),
    '\d+(\.\d+)?\s*("|''|ft|mm|cm)?\s*(x|\*|×)\s*\d+(\.\d+)?\s*("|''|mm|cm|ft)?|\(?\d+\s*(pcs?|pack|ps)\)?|\(?\d*\s*pack\)?', ' ', 'g'),
    '\m(glossy|gloss|matt|matte|polished|polish|pgvt|gvt|dgvt|gvt|hg|gl|mt|satin|carving|rustic|lustre|luster|sugar|tiles?|pcs|box(es)?|mm|cm|ft|vitrified|porcelain|digital)\M', ' ', 'g'),
    '[^a-z0-9 ]+|\s+', ' ', 'g'))
$$;

create table if not exists public.stock_aliases (
  match_key text primary key,               -- stock_clean(name) | size
  tile_id bigint references public.tiles on delete cascade,
  skip boolean not null default false,      -- "not in the catalog": keep the stock name as it is
  set_by uuid references auth.users on delete set null,
  set_at timestamptz not null default now()
);
alter table public.stock_aliases enable row level security;
create policy "admins read stock aliases" on public.stock_aliases for select to authenticated using (public.is_admin());

create table if not exists public.stock_lines (
  id bigint generated always as identity primary key,
  showroom text not null check (showroom in ('gs', 'kp')),
  raw_name text not null,
  raw_size text,                            -- cm, small side first ("60x120")
  raw_finish text,                          -- finish_group of the stock name
  boxes numeric not null,
  match_key text not null,
  tile_id bigint references public.tiles on delete set null,
  offer_id bigint references public.offers on delete set null,
  score real,
  guess_tile_id bigint references public.tiles on delete set null,
  sure boolean not null default false
);
create index if not exists stock_lines_tile on public.stock_lines (tile_id);
create index if not exists stock_lines_key on public.stock_lines (match_key);
alter table public.stock_lines enable row level security;
create policy "staff read stock" on public.stock_lines for select to authenticated using (public.is_staff());

create table if not exists public.stock_uploads (
  showroom text primary key check (showroom in ('gs', 'kp')),
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid references auth.users on delete set null,
  file_name text,
  lines int,
  boxes numeric
);
alter table public.stock_uploads enable row level security;
create policy "staff read stock uploads" on public.stock_uploads for select to authenticated using (public.is_staff());

-- the offer of a tile that fits the stock size and finish best
create or replace function public.stock_offer(p_tile bigint, p_size text, p_finish text) returns bigint
language sql stable set search_path = public as $$
  select o.id from offers o where o.tile_id = p_tile and (p_size is null or base_size(o.size) = p_size)
  order by (finish_group(o.finish) is not distinct from p_finish) desc, (o.finish ~* 'border|corner|decor') , o.id limit 1
$$;

-- the catalog brand written in a stock name ("1200X600 ITALAKE ...", "COLOR" = Colortile), if any
create or replace function public.stock_brand(p_name text) returns text
language sql stable set search_path = public as $$
  select b.brand from (select distinct brand from tiles) b
  where lower(coalesce(p_name, '')) ~ ('\m(' || lower(split_part(b.brand, ' ', 1))
          || case when b.brand = 'Colortile' then '|color' else '' end || ')\M')
  order by length(b.brand) desc limit 1
$$;

-- best catalog tile for a stock name: similar name, and a bonus when the tile comes in that size and
-- finish. When the stock name says the brand, only that brand's tiles are looked at. "whole" = every
-- word of the catalog name is in the stock name; tiles like that come first.
-- (older stock_guess and stock_match without the brand are left unused in the database)
create or replace function public.stock_pick(p_name text, p_size text, p_finish text)
returns table (tile_id bigint, score real, runner_up real, whole boolean, brand text)
language plpgsql stable set search_path = public, extensions as $$
declare
  v_brand text := stock_brand(p_name);
  clean text := stock_clean(p_name);
begin
  if v_brand is not null then
    clean := trim(regexp_replace(clean, '\m(' || lower(split_part(v_brand, ' ', 1))
               || case when v_brand = 'Colortile' then '|color' else '' end || ')\M', ' ', 'g'));
  end if;
  if length(clean) < 3 then return; end if;
  -- within one brand a looser likeness is enough to make a guess for the admin
  perform set_config('pg_trgm.similarity_threshold', case when v_brand is null then '0.3' else '0.2' end, true);
  return query
  with c as (
    select t.id, t.name,
      similarity(lower(t.name), clean)
      + case when p_size is not null and exists (select 1 from offers o where o.tile_id = t.id and base_size(o.size) = p_size) then 0.12
             when p_size is not null then -0.15 else 0 end
      + case when p_finish is not null and exists (select 1 from offers o where o.tile_id = t.id and finish_group(o.finish) = p_finish) then 0.05 else 0 end as s,
      stock_clean(t.name) <> '' and not exists (select 1 from regexp_split_to_table(stock_clean(t.name), ' ') w
                  where length(w) > 1 and word_similarity(w, clean) < 0.8) as w   -- "J-", "M-" collection letters can be left out
    from tiles t
    where (v_brand is null or t.brand = v_brand) and lower(t.name) % clean
  ), r as (select c.*, row_number() over (order by c.w desc, c.s desc, length(c.name)) n from c)
  select (select id from r where n = 1), (select s from r where n = 1)::real,
         (select max(s) from r where n > 1 and r.w = (select w from r where n = 1))::real,   -- the same name from two brands is never "sure"
         (select w from r where n = 1), v_brand
  where exists (select 1 from r);
end;
$$;

-- p_lines: [{name, size, finish, boxes}]. The phone sends a showroom's stock in parts; the first part
-- (p_first) clears that showroom's old stock. Admins only.
create or replace function public.upload_stock(p_showroom text, p_file text, p_lines jsonb, p_first boolean default true) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  l jsonb;
  v_name text; v_size text; v_finish text; v_key text; v_boxes numeric;
  a stock_aliases; v_guess bigint; v_score real; v_runner real; v_whole boolean; v_brand text; v_tile bigint; v_sure boolean;
begin
  if not is_admin() then raise exception 'Only admins can upload stock'; end if;
  if p_showroom not in ('gs', 'kp') then raise exception 'Unknown showroom'; end if;
  if p_first then delete from stock_lines where showroom = p_showroom; end if;
  for l in select * from jsonb_array_elements(p_lines) loop
    v_name := trim(l ->> 'name');
    v_boxes := nullif(l ->> 'boxes', '')::numeric;
    continue when v_name is null or v_name = '' or v_boxes is null;
    v_size := coalesce(stock_size(l ->> 'size'), stock_size(v_name));
    v_finish := coalesce(finish_group(l ->> 'finish'), finish_group(v_name));
    v_key := stock_clean(v_name) || '|' || coalesce(v_size, '');
    v_guess := null; v_score := null; v_runner := null; v_whole := null; v_brand := null; v_tile := null; v_sure := false;
    select * into a from stock_aliases where match_key = v_key;
    if found then
      v_tile := a.tile_id; v_sure := true; v_score := 1;
    else
      v_brand := stock_brand(v_name);
      select g.tile_id, g.score, g.runner_up, g.whole into v_guess, v_score, v_runner, v_whole
        from stock_pick(v_name, v_size, v_finish) g;
      -- sure only when the stock name says a catalog brand and has the whole catalog name (or one
      -- letter off, like Berlin / Berlim) and no other tile of that brand is as close
      v_sure := coalesce(v_brand is not null and (
                  (v_whole and v_score >= 0.75 and (v_runner is null or v_score - v_runner >= 0.05))
                  or (v_score >= 0.95 and (v_runner is null or v_score - v_runner >= 0.3))), false);
      if v_sure then v_tile := v_guess;
      -- other brands (Somany, Comet...) are not in the catalogs: they stay as written, without a
      -- question, unless the whole name of a catalog tile is in them
      elsif v_brand is null and not coalesce(v_whole, false) then v_sure := true; v_guess := null;
      end if;
    end if;
    insert into stock_lines (showroom, raw_name, raw_size, raw_finish, boxes, match_key, tile_id, offer_id, score, guess_tile_id, sure)
    values (p_showroom, v_name, v_size, v_finish, v_boxes, v_key, v_tile,
            case when v_tile is not null then stock_offer(v_tile, v_size, v_finish) end, v_score, v_guess, v_sure);
  end loop;
  insert into stock_uploads (showroom, uploaded_at, uploaded_by, file_name, lines, boxes)
  select p_showroom, now(), auth.uid(), p_file, count(*), coalesce(sum(boxes), 0) from stock_lines where showroom = p_showroom
  on conflict (showroom) do update set uploaded_at = excluded.uploaded_at, uploaded_by = excluded.uploaded_by,
    file_name = excluded.file_name, lines = excluded.lines, boxes = excluded.boxes;
  return (select jsonb_build_object('lines', count(*), 'boxes', coalesce(sum(boxes), 0), 'sure', count(*) filter (where sure),
      'matched', count(*) filter (where tile_id is not null),
      'unsure', (select count(distinct match_key) from stock_lines where not sure))
    from stock_lines where showroom = p_showroom);
end;
$$;

-- stock names waiting for an admin, with the app's best guess
create or replace function public.stock_review() returns table (match_key text, raw_name text, raw_size text, boxes numeric,
  showrooms text, guess_id bigint, guess_name text, guess_brand text, guess_thumb text)
language sql stable security definer set search_path = public as $$
  select l.match_key, min(l.raw_name), min(l.raw_size), sum(l.boxes), string_agg(distinct l.showroom, ','),
         t.id, t.name, t.brand, t.thumb_path
  from stock_lines l left join tiles t on t.id = l.guess_tile_id
  where not l.sure and is_admin()
  group by l.match_key, t.id order by sum(l.boxes) desc
$$;

-- an admin's answer for one stock name: the right tile, or p_tile null = not in the catalog
create or replace function public.confirm_stock(p_key text, p_tile bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Only admins can do this'; end if;
  insert into stock_aliases (match_key, tile_id, skip, set_by) values (p_key, p_tile, p_tile is null, auth.uid())
  on conflict (match_key) do update set tile_id = excluded.tile_id, skip = excluded.skip, set_by = excluded.set_by, set_at = now();
  update stock_lines set tile_id = p_tile, sure = true,
    offer_id = case when p_tile is not null then stock_offer(p_tile, raw_size, raw_finish) end
  where match_key = p_key;
end;
$$;

-- combined stock, one row per tile size and finish (stock names not in the catalog stay as they are)
create or replace function public.stock_list(q text default '', p_brand text default null, p_size text default null,
    p_finish text default null, p_min numeric default null, p_sort text default 'most',
    p_offset int default 0, p_limit int default 60)
returns table (tile_id bigint, name text, brand text, thumb_path text, size text, finish text,
  gs numeric, kp numeric, total numeric, matched boolean)
language sql stable security invoker set search_path = public as $$
  with g as (
    select l.tile_id, coalesce(t.name, min(l.raw_name)) name, t.brand, t.thumb_path,
      coalesce(base_size(o.size), l.raw_size) size, coalesce(o.finish, min(l.raw_finish)) finish,
      coalesce(sum(l.boxes) filter (where l.showroom = 'gs'), 0) gs,
      coalesce(sum(l.boxes) filter (where l.showroom = 'kp'), 0) kp,
      sum(l.boxes) total, l.tile_id is not null matched, min(l.raw_finish) raw_finish
    from stock_lines l left join tiles t on t.id = l.tile_id left join offers o on o.id = l.offer_id
    group by l.tile_id, t.name, t.brand, t.thumb_path, coalesce(base_size(o.size), l.raw_size), o.finish,
      case when l.tile_id is null then l.match_key end
  )
  select g.tile_id, g.name, g.brand, g.thumb_path, g.size, g.finish, g.gs, g.kp, g.total, g.matched from g
  where (p_brand is null or g.brand = p_brand)
    and (p_size is null or g.size = p_size)
    -- the finish from the catalog, or the one written in the stock name ("HG", "PGVT"...)
    and (p_finish is null or finish_group(g.finish) = p_finish or g.raw_finish = p_finish)
    and (p_min is null or g.total >= p_min)
    and g.total > 0
    and not exists (select 1 from regexp_split_to_table(lower(trim(coalesce(q, ''))), '\s+') w
                    where w <> '' and lower(coalesce(g.brand, '') || ' ' || g.name) not like '%' || w || '%')
  order by case when p_sort = 'least' then g.total end asc,
           case when p_sort = 'name' then lower(g.name) end asc,
           g.total desc, g.name
  offset greatest(p_offset, 0) limit least(greatest(p_limit, 1), 1000)
$$;

-- stock of one tile, for its page
create or replace function public.tile_stock(p_tile bigint) returns table (offer_id bigint, size text, finish text,
  gs numeric, kp numeric, total numeric)
language sql stable security invoker set search_path = public as $$
  select l.offer_id, coalesce(base_size(o.size), min(l.raw_size)), o.finish,
    coalesce(sum(l.boxes) filter (where l.showroom = 'gs'), 0), coalesce(sum(l.boxes) filter (where l.showroom = 'kp'), 0), sum(l.boxes)
  from stock_lines l left join offers o on o.id = l.offer_id
  where l.tile_id = p_tile group by l.offer_id, o.size, o.finish order by sum(l.boxes) desc
$$;

-- finishes and sizes that are in stock, for the filters
create or replace function public.stock_filters() returns jsonb language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    -- biggest size first, like everywhere in the app (Kirti 2026-10-22)
    'sizes', (select jsonb_agg(s order by split_part(s,'x',1)::numeric * split_part(s,'x',2)::numeric desc,
                greatest(split_part(s,'x',1)::numeric, split_part(s,'x',2)::numeric) desc, s) from (
       select distinct coalesce(base_size(o.size), l.raw_size) s from stock_lines l left join offers o on o.id = l.offer_id
       where coalesce(base_size(o.size), l.raw_size) ~ '^[0-9.]+x[0-9.]+$') z),
    'finishes', (select jsonb_agg(f order by f) from (
       select finish_group(o.finish) f from stock_lines l join offers o on o.id = l.offer_id
       union select l.raw_finish from stock_lines l) z where f is not null),
    'brands', (select jsonb_agg(b order by b) from (
       select distinct t.brand b from stock_lines l join tiles t on t.id = l.tile_id) z),
    'uploads', (select jsonb_object_agg(showroom, jsonb_build_object('at', uploaded_at, 'lines', lines, 'boxes', boxes, 'file', file_name))
                from stock_uploads where lines > 0))
$$;

revoke execute on function public.upload_stock(text, text, jsonb, boolean) from public, anon;
revoke execute on function public.confirm_stock(text, bigint) from public, anon;
revoke execute on function public.stock_review() from public, anon;
revoke execute on function public.stock_list(text, text, text, text, numeric, text, int, int) from anon;
revoke execute on function public.tile_stock(bigint) from anon;
revoke execute on function public.stock_filters() from anon;
grant execute on function public.upload_stock(text, text, jsonb, boolean), public.confirm_stock(text, bigint), public.stock_review(),
  public.stock_list(text, text, text, text, numeric, text, int, int), public.tile_stock(bigint), public.stock_filters() to authenticated;
