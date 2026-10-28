-- =====================================================================
-- LCSO Connect — Pilot database (v0.1)
-- Paste this whole file into Supabase > SQL Editor > New query > Run.
-- Safe to run once on a fresh project.
-- =====================================================================

-- ---------- Tables ----------------------------------------------------

-- One row per person. Created automatically when you add a user in
-- Supabase > Authentication > Users.
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '',
  rank        text not null default 'Deputy',
  is_admin    boolean not null default false,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table public.groups (
  id          bigint generated always as identity primary key,
  name        text not null unique,
  sort_order  int not null default 100,
  created_at  timestamptz not null default now()
);

-- Membership. can_send = true  -> send + receive
--             can_send = false -> receive only
create table public.group_members (
  group_id    bigint not null references public.groups(id) on delete cascade,
  user_id     uuid   not null references public.profiles(id) on delete cascade,
  can_send    boolean not null default false,
  primary key (group_id, user_id)
);

create table public.messages (
  id               bigint generated always as identity primary key,
  group_id         bigint not null references public.groups(id) on delete cascade,
  sender_id        uuid   not null references public.profiles(id),
  body             text   not null check (char_length(body) between 1 and 4000),
  priority         text   not null default 'routine'
                     check (priority in ('routine','priority','urgent')),
  attachment_path  text,
  attachment_name  text,
  created_at       timestamptz not null default now()
);
create index messages_group_time on public.messages (group_id, created_at desc);

create table public.acknowledgments (
  message_id  bigint not null references public.messages(id) on delete cascade,
  user_id     uuid   not null references public.profiles(id) on delete cascade,
  acked_at    timestamptz not null default now(),
  primary key (message_id, user_id)
);

-- ---------- Helper functions (used by the security rules) ------------

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin and active from profiles where id = auth.uid()), false);
$$;

create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select active from profiles where id = auth.uid()), false);
$$;

create or replace function public.is_member(gid bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_active() and exists (
    select 1 from group_members where group_id = gid and user_id = auth.uid());
$$;

create or replace function public.can_send(gid bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_active() and exists (
    select 1 from group_members where group_id = gid and user_id = auth.uid() and can_send);
$$;

-- New sign-in account -> profile row
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)));
  -- Everyone active lands in All Staff as receive-only
  insert into group_members (group_id, user_id, can_send)
  select id, new.id, false from groups where name = 'All Staff'
  on conflict do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Users may not promote themselves or change their own rank
create or replace function public.protect_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- auth.uid() is null when run from the Supabase SQL Editor (trusted)
  if auth.uid() is not null and not public.is_admin() then
    new.is_admin := old.is_admin;
    new.rank     := old.rank;
    new.active   := old.active;
  end if;
  return new;
end;
$$;

create trigger profiles_protect
  before update on public.profiles
  for each row execute function public.protect_profile();

-- ---------- Row-level security ----------------------------------------

alter table public.profiles        enable row level security;
alter table public.groups          enable row level security;
alter table public.group_members   enable row level security;
alter table public.messages        enable row level security;
alter table public.acknowledgments enable row level security;

-- profiles: any active user can see the roster; edit own name; admins edit all
create policy "roster readable" on public.profiles
  for select to authenticated using (public.is_active() or id = auth.uid());
create policy "edit own name" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy "admin manage profiles" on public.profiles
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- groups: see groups you belong to; admins see/manage all
create policy "see my groups" on public.groups
  for select to authenticated using (public.is_member(id) or public.is_admin());
create policy "admin manage groups" on public.groups
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- group_members: see members of your groups; admins manage
create policy "see members of my groups" on public.group_members
  for select to authenticated using (public.is_member(group_id) or public.is_admin());
create policy "admin manage members" on public.group_members
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- messages: read if member; post only with send permission, as yourself
create policy "read group messages" on public.messages
  for select to authenticated using (public.is_member(group_id) or public.is_admin());
create policy "send if allowed" on public.messages
  for insert to authenticated
  with check (sender_id = auth.uid() and public.can_send(group_id));
create policy "admin delete messages" on public.messages
  for delete to authenticated using (public.is_admin());

-- acknowledgments: see acks on messages you can read; ack as yourself
create policy "read acks" on public.acknowledgments
  for select to authenticated using (
    exists (select 1 from public.messages m
            where m.id = message_id and (public.is_member(m.group_id) or public.is_admin())));
create policy "ack as self" on public.acknowledgments
  for insert to authenticated with check (
    user_id = auth.uid() and exists (
      select 1 from public.messages m where m.id = message_id and public.is_member(m.group_id)));

-- ---------- Attachments (private storage bucket) ---------------------
-- Files are stored as  <group_id>/<random>-<filename>

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments', 'attachments', false, 10485760, array[
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg','image/png','image/heic','image/heif','image/gif','image/webp'
]);

create policy "read attachments in my groups" on storage.objects
  for select to authenticated using (
    bucket_id = 'attachments'
    and (public.is_member((storage.foldername(name))[1]::bigint) or public.is_admin()));
create policy "upload attachments if sender" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'attachments'
    and public.can_send((storage.foldername(name))[1]::bigint));

-- ---------- Live updates ---------------------------------------------

alter publication supabase_realtime add table public.messages, public.acknowledgments;

-- ---------- Starter groups --------------------------------------------

insert into public.groups (name, sort_order) values
  ('All Staff', 1),
  ('Command Staff', 2),
  ('Captains', 3),
  ('Lieutenants', 4),
  ('Sergeants', 5),
  ('Deputies', 6),
  ('CID', 20),
  ('Detention Center', 21);
