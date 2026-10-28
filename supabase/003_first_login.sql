-- =====================================================================
-- LCSO Connect — v0.7 first sign-in setup (name + title/rank)
-- Run once in Supabase > SQL Editor.
-- =====================================================================

-- false until the person completes the first sign-in setup screen
alter table public.profiles
  add column if not exists setup_done boolean not null default false;

-- Existing admins are already set up
update public.profiles set setup_done = true where is_admin;

-- Non-admins may choose their own title/rank ONCE, during first sign-in setup.
-- After that only an admin can change rank. Nobody can make themselves admin
-- or reactivate themselves.
create or replace function public.protect_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- auth.uid() is null when run from the Supabase SQL Editor (trusted)
  if auth.uid() is not null and not public.is_admin() then
    new.is_admin := old.is_admin;
    new.active   := old.active;
    if old.setup_done then
      new.rank       := old.rank;
      new.setup_done := true;
    end if;
  end if;
  return new;
end;
$$;
