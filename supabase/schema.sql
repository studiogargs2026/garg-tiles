-- Garg Tiles database. Run once in a fresh Supabase project.
-- Sales staff see tiles, pictures, packing and suggested selling price.
-- Cost prices live in offer_costs, which only admins can read.

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text,
  role text not null default 'sales' check (role in ('admin', 'sales')),
  created_at timestamptz not null default now()
);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

-- Every new login gets a sales profile; admins are promoted by hand.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name) values (new.id, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create table public.tiles (
  id bigint generated always as identity primary key,
  brand text not null,
  name text not null,
  catalog text,
  notes text,
  image_path text,          -- path in the "tiles" storage bucket
  thumb_path text,
  search_text text generated always as (lower(brand || ' ' || name || ' ' || coalesce(catalog, ''))) stored,
  updated_at timestamptz not null default now(),
  unique (brand, name)
);

create table public.offers (
  id bigint generated always as identity primary key,
  tile_id bigint not null references public.tiles on delete cascade,
  size text,
  finish text,
  series text,
  unit text,                -- 'sq ft' or 'box'
  packing text,             -- e.g. '2 pcs/box, 15.50 sq ft'
  box_sqft numeric,
  weight_kg numeric,        -- per box, when the catalog gives it
  selling_price numeric,    -- suggested selling price per sq ft (or per unit)
  note text
);
create index offers_tile_id on public.offers (tile_id);

create table public.offer_costs (
  offer_id bigint primary key references public.offers on delete cascade,
  net_cost numeric,         -- net cost per sq ft (or per unit) before insurance and GST
  cost_note text
);

-- Stock (feature 3) and image fingerprints (photo search) come later.

alter table public.profiles enable row level security;
alter table public.tiles enable row level security;
alter table public.offers enable row level security;
alter table public.offer_costs enable row level security;

create policy "read own profile" on public.profiles for select
  using (id = auth.uid() or public.is_admin());
create policy "admins manage profiles" on public.profiles for update
  using (public.is_admin());

create policy "staff read tiles" on public.tiles for select to authenticated using (true);
create policy "staff read offers" on public.offers for select to authenticated using (true);
create policy "admins read costs" on public.offer_costs for select to authenticated using (public.is_admin());

grant usage on schema public to authenticated;
grant select on public.profiles, public.tiles, public.offers, public.offer_costs to authenticated;
grant update (role, full_name) on public.profiles to authenticated;

insert into storage.buckets (id, name, public) values ('tiles', 'tiles', false)
  on conflict (id) do nothing;
create policy "staff read tile pictures" on storage.objects for select to authenticated
  using (bucket_id = 'tiles');

-- Only the database itself may run these helpers.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- Cost price PIN: admins always see cost; anyone else types the PIN.
-- Five wrong PINs lock that person until an admin unlocks them.
create extension if not exists pgcrypto with schema extensions;
alter table public.offers add column thickness_mm numeric;

create table public.app_secrets (key text primary key, value text not null, updated_at timestamptz not null default now());
alter table public.app_secrets enable row level security;

create table public.pin_attempts (user_id uuid primary key references auth.users on delete cascade, failed int not null default 0, locked boolean not null default false);
alter table public.pin_attempts enable row level security;
create policy "admins see pin locks" on public.pin_attempts for select to authenticated using (public.is_admin());
grant select on public.pin_attempts to authenticated;

create or replace function public.set_cost_pin(new_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not is_admin() then raise exception 'Only admins can change the PIN'; end if;
  if new_pin !~ '^[0-9]{4,8}$' then raise exception 'PIN must be 4 to 8 digits'; end if;
  insert into app_secrets (key, value) values ('cost_pin', crypt(new_pin, gen_salt('bf')))
    on conflict (key) do update set value = excluded.value, updated_at = now();
end;
$$;

-- Problems are reported in the result, not raised: raising would undo the failed-try count.
create or replace function public.cost_lookup(offer_ids bigint[], pin text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  stored text;
  tries pin_attempts;
begin
  if auth.uid() is null or not is_staff() then return jsonb_build_object('error', 'Not signed in'); end if;
  if not is_admin() then
    select * into tries from pin_attempts where user_id = auth.uid();
    if tries.locked then return jsonb_build_object('error', 'Locked after 5 wrong PINs. Ask an admin to unlock you.'); end if;
    select value into stored from app_secrets where key = 'cost_pin';
    if stored is null then return jsonb_build_object('error', 'No PIN has been set yet. Ask an admin.'); end if;
    if pin is null or crypt(pin, stored) <> stored then
      insert into pin_attempts (user_id, failed) values (auth.uid(), 1)
        on conflict (user_id) do update set failed = pin_attempts.failed + 1, locked = pin_attempts.failed + 1 >= 5;
      return jsonb_build_object('error', 'Wrong PIN');
    end if;
    update pin_attempts set failed = 0 where user_id = auth.uid();
  end if;
  return jsonb_build_object('costs', coalesce(
    (select jsonb_object_agg(c.offer_id, c.net_cost) from offer_costs c where c.offer_id = any(offer_ids)), '{}'::jsonb));
end;
$$;

create or replace function public.unlock_pin(target uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Only admins can unlock'; end if;
  update pin_attempts set failed = 0, locked = false where user_id = target;
end;
$$;

revoke execute on function public.set_cost_pin(text), public.cost_lookup(bigint[], text), public.unlock_pin(uuid) from public, anon;
grant execute on function public.set_cost_pin(text), public.cost_lookup(bigint[], text), public.unlock_pin(uuid) to authenticated;

-- Staff list: only people an admin has added can create an account (see functions/signup).
-- Access and role follow this list, so removing someone cuts their access at once.
create table public.allowed_emails (
  email text primary key check (email = lower(email)),
  full_name text,
  role text not null default 'sales' check (role in ('admin', 'sales')),
  created_at timestamptz not null default now()
);
alter table public.allowed_emails enable row level security;
create policy "admins manage staff list" on public.allowed_emails for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.allowed_emails to authenticated;
alter table public.profiles add column email text;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  a allowed_emails;
begin
  select * into a from allowed_emails where email = lower(new.email);
  insert into profiles (id, full_name, role, email)
    values (new.id, coalesce(a.full_name, new.raw_user_meta_data ->> 'full_name'), coalesce(a.role, 'sales'), lower(new.email));
  return new;
end;
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from allowed_emails a join auth.users u on lower(u.email) = a.email where u.id = auth.uid());
$$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from allowed_emails a join auth.users u on lower(u.email) = a.email where u.id = auth.uid() and a.role = 'admin');
$$;
revoke execute on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated;

alter policy "staff read tiles" on public.tiles using (public.is_staff());
alter policy "staff read offers" on public.offers using (public.is_staff());
create policy "staff read tile pictures only while listed" on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'tiles' or public.is_staff());

-- Search screen: brand and size filters, suggestions while typing (2026-10-21)
create or replace function public.base_size(s text) returns text language sql immutable as $$
  select case when m is null then null else
    (select string_agg(case when abs(v::numeric - round(v::numeric)) <= 0.3 then round(v::numeric)::text else v end, 'x' order by i)
       from unnest(m) with ordinality as u(v, i)) end
  from (select regexp_match(s, '^([0-9.]+)x([0-9.]+) cm') m) x
$$;
create index if not exists offers_base_size on public.offers (public.base_size(size));
create index if not exists offers_tile on public.offers (tile_id);

create or replace function public.tile_filters() returns jsonb language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'brands', (select jsonb_agg(brand order by brand) from (select distinct brand from tiles) b),
    'sizes', (select jsonb_agg(s order by split_part(s,'x',1)::numeric * split_part(s,'x',2)::numeric, s)
              from (select base_size(size) s from offers where base_size(size) is not null group by 1 having count(distinct tile_id) >= 3) z))
$$;

create or replace function public.suggest_tiles(q text, p_brand text default null, p_size text default null)
returns table (id bigint, brand text, name text, thumb_path text) language sql stable security invoker set search_path = public as $$
  select t.id, t.brand, t.name, t.thumb_path from tiles t
  where (p_brand is null or t.brand = p_brand)
    and (p_size is null or exists (select 1 from offers o where o.tile_id = t.id and base_size(o.size) = p_size))
    and trim(coalesce(q,'')) <> ''
    and not exists (select 1 from regexp_split_to_table(lower(trim(q)), '\s+') w
                    where lower(t.brand || ' ' || t.name) not like '%' || w || '%')
  order by lower(t.name) like lower(trim(q)) || '%' desc, length(t.name), t.name
  limit 8
$$;

create or replace function public.browse_tiles(q text default '', p_brand text default null, p_size text default null,
    p_offset int default 0, p_limit int default 40)
returns table (id bigint, brand text, name text, catalog text, thumb_path text) language sql stable security invoker set search_path = public as $$
  select t.id, t.brand, t.name, t.catalog, t.thumb_path from tiles t
  where (p_brand is null or t.brand = p_brand)
    and (p_size is null or exists (select 1 from offers o where o.tile_id = t.id and base_size(o.size) = p_size))
    and not exists (select 1 from regexp_split_to_table(lower(trim(coalesce(q,''))), '\s+') w
                    where w <> '' and t.search_text not like '%' || w || '%')
  order by (lower(t.name) like '%' || lower(trim(coalesce(q,''))) || '%') desc, t.name, t.brand
  offset greatest(p_offset,0) limit least(greatest(p_limit,1),100)
$$;
revoke execute on function public.tile_filters() from anon;
revoke execute on function public.suggest_tiles(text,text,text) from anon;
revoke execute on function public.browse_tiles(text,text,text,int,int) from anon;
-- 2026-10-21: browse_tiles and suggest_tiles also rank names with a word starting with the typed text first
-- (see migration search_word_start_first): order by lower(t.name) ~ ('\m' || q) desc, ...

-- Photo search (photo.js): pictures of highlighter, decor, mosaic and inlay tiles, so a room
-- photo can be offered highlighter options. The picture fingerprints are files photo/meta.json
-- and photo/vectors.bin in the tiles bucket, made by tools/photo_vectors.py.
create or replace function public.highlighter_thumbs() returns text[] language sql stable security invoker set search_path = public as $$
  select coalesce(array_agg(distinct t.thumb_path), '{}') from tiles t left join offers o on o.tile_id = t.id
  where t.thumb_path is not null and (
    t.name ~* '(highlight|\mhl\M|decor|\mdeco\M|mosaic|inlay|listello|accent|motif|punch)'
    or coalesce(o.series, '') || ' ' || coalesce(o.finish, '') ~* '(highlight|\mhl\M|decor|décor|\mdeco\M|mosaic|inlay|listello)');
$$;
grant execute on function public.highlighter_thumbs() to authenticated;

-- Two showrooms (2026-10-21): Garg's Studio ('gs') and KP Enterprises ('kp'). Everyone picks a
-- showroom after signing in; the app's look, the PDFs and the letterhead follow it. Each person
-- sees only their own selections and quotations, admins see all of them.
alter table public.selections add column if not exists showroom text not null default 'gs' check (showroom in ('gs', 'kp'));
alter table public.selections add column if not exists total numeric;     -- grand total, for the admin summary
alter table public.profiles add column if not exists showroom text check (showroom in ('gs', 'kp'));
create index if not exists selections_owner on public.selections (created_by, updated_at desc);
alter policy selections_read on public.selections
  using (public.is_staff() and (created_by = auth.uid() or public.is_admin()));
alter policy selections_add on public.selections
  with check (public.is_staff() and created_by = auth.uid());
alter policy selections_edit on public.selections
  using (public.is_staff() and (created_by = auth.uid() or public.is_admin()))
  with check (public.is_staff() and (created_by = auth.uid() or public.is_admin()));

create or replace function public.set_my_showroom(p_showroom text) returns void
language sql security definer set search_path = public as $$
  update profiles set showroom = p_showroom where id = auth.uid() and p_showroom in ('gs', 'kp') and is_staff();
$$;
revoke execute on function public.set_my_showroom(text) from public, anon;
grant execute on function public.set_my_showroom(text) to authenticated;

-- Letterheads: app_settings 'business' (Garg's Studio) and 'business_kp' (KP Enterprises).
-- Quote numbers run per showroom and financial year; staff cannot see each other's quotes, so the
-- database counts. KP writes them year first (26-27/01, quote_style 'year-first'); quote_start in
-- the letterhead lets the numbers carry on from a showroom's old quote book.
create or replace function public.next_quote_no(p_showroom text) returns text
language plpgsql security definer set search_path = public as $$
declare
  today date := (now() at time zone 'Asia/Kolkata')::date;
  fy int := case when extract(month from today) >= 4 then extract(year from today)::int else extract(year from today)::int - 1 end;
  tag text := right(fy::text, 2) || '-' || right((fy + 1)::text, 2);
  biz jsonb := (select value from app_settings where key = case p_showroom when 'kp' then 'business_kp' else 'business' end);
  year_first boolean := biz ->> 'quote_style' = 'year-first';
  top int;
begin
  if not is_staff() then raise exception 'Not signed in'; end if;
  if year_first then
    select coalesce(max(nullif(substring(quote_no from '/(\d+)$'), '')::int), 0) into top
      from selections where showroom = p_showroom and quote_no like tag || '/%';
  else
    select coalesce(max(nullif(substring(quote_no from '^(\d+)/'), '')::int), 0) into top
      from selections where showroom = p_showroom and quote_no like '%/' || tag;
  end if;
  top := greatest(top, coalesce((biz ->> 'quote_start')::int, 1) - 1);
  return case when year_first then tag || '/' || lpad((top + 1)::text, 2, '0')
              else lpad((top + 1)::text, 2, '0') || '/' || tag end;
end;
$$;
revoke execute on function public.next_quote_no(text) from public, anon;
grant execute on function public.next_quote_no(text) to authenticated;

-- Products typed in by hand ("+ Product not in the app") are kept here (2026-10-27), so anyone can
-- find them again in the quick-add box of any selection or quotation. One row per name and size;
-- saving the same name and size again updates it. Admins can remove a row.
create table if not exists public.saved_products (
  id bigint generated always as identity primary key,
  name text not null check (length(trim(name)) > 0),
  size text not null default '',
  role text,
  unit text,
  rate numeric,
  photo text,                -- small JPEG as a data: URL, like the item itself
  key text generated always as (lower(trim(name)) || '|' || lower(trim(size))) stored unique,
  created_by uuid default auth.uid() references auth.users on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.saved_products enable row level security;
create policy "staff read saved products" on public.saved_products for select to authenticated using (public.is_staff());
create policy "staff add saved products" on public.saved_products for insert to authenticated with check (public.is_staff());
create policy "staff edit saved products" on public.saved_products for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy "admins remove saved products" on public.saved_products for delete to authenticated using (public.is_admin());
grant select, insert, delete on public.saved_products to authenticated;
grant update (name, size, role, unit, rate, photo, updated_at) on public.saved_products to authenticated;
