/* =========================================================================
   asus.wtf — premium access for site accounts

   Paste this whole file into Supabase → SQL Editor → Run. It is idempotent:
   running it twice changes nothing.

   What it creates:
     public.profiles      one row per account; is_premium is the grant flag
     public.site_admins   which accounts may grant / remove premium
     public.is_site_admin()  true when the signed-in JWT's email is listed

   Then: change the seeded admin email below to the account you sign in with,
   and open /admin.html on the site. Until then that page says "not an admin".
   ========================================================================= */

/* ------------------------------- profiles ------------------------------- */

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text,
  is_premium boolean not null default false,
  premium_note text,
  premium_since timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists profiles_created_at_idx on public.profiles (created_at desc);

alter table public.profiles enable row level security;

grant select on public.profiles to authenticated;
grant update (is_premium, premium_note, premium_since) on public.profiles to authenticated;

/* ------------------------------- admins --------------------------------- */

create table if not exists public.site_admins (
  email text primary key,
  created_at timestamptz not null default now()
);

-- No policies on purpose: only the SQL editor / service role can change this.
alter table public.site_admins enable row level security;

-- CHANGE THIS to the account you sign in with. Add more rows for more admins.
insert into public.site_admins (email)
values ('d62565565@gmail.com')
on conflict (email) do nothing;

/* --------------------------- admin detection ---------------------------- */

create or replace function public.is_site_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.site_admins a
    where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke all on function public.is_site_admin() from public;
grant execute on function public.is_site_admin() to authenticated;

/* --------------------------------- RLS ---------------------------------- */

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = auth.uid());

drop policy if exists profiles_select_admin on public.profiles;
create policy profiles_select_admin on public.profiles
  for select to authenticated
  using (public.is_site_admin());

drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin on public.profiles
  for update to authenticated
  using (public.is_site_admin())
  with check (public.is_site_admin());

/* ------------------------- one row per new account ---------------------- */

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

/* ------------------------- backfill existing accounts ------------------- */

insert into public.profiles (id, email, full_name)
select
  u.id,
  u.email,
  coalesce(u.raw_user_meta_data ->> 'full_name', split_part(u.email, '@', 1))
from auth.users u
on conflict (id) do update set email = excluded.email;
