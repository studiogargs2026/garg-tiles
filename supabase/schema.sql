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
