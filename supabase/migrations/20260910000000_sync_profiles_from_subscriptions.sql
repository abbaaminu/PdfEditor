-- Backfill profile entitlements for subscriptions recorded before the
-- Paddle webhook began synchronizing public.profiles.
insert into public.profiles (id, is_pro)
select
  s.user_id,
  s.status in ('active', 'trialing')
from public.subscriptions s
on conflict (id) do update
set
  is_pro = excluded.is_pro,
  updated_at = now();
