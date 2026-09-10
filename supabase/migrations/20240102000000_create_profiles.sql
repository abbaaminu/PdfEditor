-- supabase/migrations/20240102000000_create_profiles.sql
-- Per-account entitlement table: read by `fetchProfileProStatus` and confirmed
-- by the browser after a web checkout completes (frontend UpgradeModal).
--
-- The authoritative write still happens server-side — the Paddle webhook edge
-- function (supabase/functions/paddle-webhook) upserts `public.subscriptions`
-- with the service-role key. The policies below therefore only let a signed-in
-- user *confirm* a purchase the webhook has already recorded; a client can
-- never grant itself Pro by POSTing { is_pro: true } to PostgREST.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  is_pro boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Keep updated_at fresh (same helper the subscriptions migration defines).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

alter table public.profiles enable row level security;

-- Reads: a user may only read their own entitlement row.
drop policy if exists "Users read their own profile" on public.profiles;
create policy "Users read their own profile"
on public.profiles
for select
to authenticated
using (auth.uid() = id);

-- Inserts: only for the user's own row and only while an active/trialing
-- subscription exists, so the client write merely confirms the webhook write.
drop policy if exists "Users confirm their own paid profile" on public.profiles;
create policy "Users confirm their own paid profile"
on public.profiles
for insert
to authenticated
with check (
  auth.uid() = id
  and exists (
    select 1
    from public.subscriptions s
    where s.user_id = auth.uid()
      and s.status in ('active', 'trialing')
  )
);

-- Updates (the ON CONFLICT path of `upsert`) are gated the same way.
drop policy if exists "Users update their own paid profile" on public.profiles;
create policy "Users update their own paid profile"
on public.profiles
for update
to authenticated
using (auth.uid() = id)
with check (
  auth.uid() = id
  and exists (
    select 1
    from public.subscriptions s
    where s.user_id = auth.uid()
      and s.status in ('active', 'trialing')
  )
);

grant select, insert, update on public.profiles to authenticated;
