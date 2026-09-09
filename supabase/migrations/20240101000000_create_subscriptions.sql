-- supabase/migrations/20240101000000_create_subscriptions.sql
-- Single-row-per-user table backing the "Pro" gating in the auth store.
-- The Paddle webhook edge function (supabase/functions/paddle-webhook) upserts
-- into this table on conflict(user_id) using the service-role key.

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  paddle_customer_id text,
  paddle_subscription_id text not null unique,
  status text, -- e.g. active | trialing | past_due | paused | canceled
  price_id text,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Keep updated_at fresh on every write (including webhook upserts).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at
before update on public.subscriptions
for each row
execute function public.set_updated_at();

-- RLS: users may only see their own subscription row.
alter table public.subscriptions enable row level security;

drop policy if exists "Users read their own subscription" on public.subscriptions;
create policy "Users read their own subscription"
on public.subscriptions
for select
to authenticated
using (auth.uid() = user_id);

-- The service-role client used by the edge function bypasses RLS, so no
-- insert/update policy is required for webhook writes.

-- Realtime: broadcast row changes so the frontend auth store can flip Pro
-- state instantly when the checkout completes.
alter publication supabase_realtime add table public.subscriptions;
