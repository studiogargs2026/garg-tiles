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
