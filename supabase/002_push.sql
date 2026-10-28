-- =====================================================================
-- LCSO Connect — v0.4 phone notifications (web push)
-- Run once in Supabase > SQL Editor after schema.sql.
-- =====================================================================

-- Which messages each person wants pushed to their phone:
--   'all' = every message, 'priority' = Priority + Urgent, 'urgent' = Urgent only
alter table public.profiles
  add column if not exists notify_level text not null default 'all'
  check (notify_level in ('all','priority','urgent'));

-- Set once the notification for a message has gone out (prevents double sends)
alter table public.messages
  add column if not exists notified_at timestamptz;

-- One row per device that turned on alerts
create table if not exists public.push_subscriptions (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  device      text,
  created_at  timestamptz not null default now()
);
create index if not exists push_subs_user on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
create policy "manage own devices" on public.push_subscriptions
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Server-only settings (notification signing keys). Row-level security is on
-- with NO policies, so only the server function can read it — never the app.
create table if not exists public.push_config (
  id           int primary key default 1 check (id = 1),
  public_key   text not null,
  private_key  text not null,
  created_at   timestamptz not null default now()
);
alter table public.push_config enable row level security;
revoke all on public.push_config from anon, authenticated;
