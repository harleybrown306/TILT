create schema if not exists private;
revoke all on schema private from public;

grant usage on schema private to authenticated, service_role;

create type public.platform_role as enum ('admin', 'user');
create type public.team_member_role as enum ('coach', 'assistant_coach', 'athlete');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  avatar_url text,
  platform_role public.platform_role not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) > 0),
  created_by_user_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.team_memberships (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.team_member_role not null,
  created_by_user_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint team_memberships_team_user_unique unique (team_id, user_id)
);

create index teams_created_by_user_id_idx on public.teams(created_by_user_id);
create index team_memberships_user_id_idx on public.team_memberships(user_id);
create index team_memberships_team_id_idx on public.team_memberships(team_id);
create index team_memberships_team_role_idx on public.team_memberships(team_id, role);

create or replace function private.is_admin(check_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = check_user_id
      and p.platform_role = 'admin'::public.platform_role
  );
$$;

create or replace function private.is_team_member(check_team_id uuid, check_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.team_memberships tm
    where tm.team_id = check_team_id
      and tm.user_id = check_user_id
  );
$$;

create or replace function private.can_manage_team(check_team_id uuid, check_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_admin(check_user_id)
    or exists (
      select 1
      from public.team_memberships tm
      where tm.team_id = check_team_id
        and tm.user_id = check_user_id
        and tm.role = 'coach'::public.team_member_role
    );
$$;

create or replace function private.can_manage_roster(check_team_id uuid, check_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_admin(check_user_id)
    or exists (
      select 1
      from public.team_memberships tm
      where tm.team_id = check_team_id
        and tm.user_id = check_user_id
        and tm.role in ('coach'::public.team_member_role, 'assistant_coach'::public.team_member_role)
    );
$$;

create or replace function private.can_view_profile(target_user_id uuid, viewer_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select target_user_id = viewer_user_id
    or private.is_admin(viewer_user_id)
    or exists (
      select 1
      from public.team_memberships viewer_membership
      join public.team_memberships target_membership
        on target_membership.team_id = viewer_membership.team_id
      where viewer_membership.user_id = viewer_user_id
        and viewer_membership.role in ('coach'::public.team_member_role, 'assistant_coach'::public.team_member_role)
        and target_membership.user_id = target_user_id
    );
$$;

revoke all on function private.is_admin(uuid) from public;
revoke all on function private.is_team_member(uuid, uuid) from public;
revoke all on function private.can_manage_team(uuid, uuid) from public;
revoke all on function private.can_manage_roster(uuid, uuid) from public;
revoke all on function private.can_view_profile(uuid, uuid) from public;

grant execute on function private.is_admin(uuid) to authenticated, service_role;
grant execute on function private.is_team_member(uuid, uuid) to authenticated, service_role;
grant execute on function private.can_manage_team(uuid, uuid) to authenticated, service_role;
grant execute on function private.can_manage_roster(uuid, uuid) to authenticated, service_role;
grant execute on function private.can_view_profile(uuid, uuid) to authenticated, service_role;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function private.protect_profile_platform_role()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.platform_role is distinct from old.platform_role
     and current_user not in ('postgres', 'service_role', 'supabase_admin')
     and not coalesce(private.is_admin((select auth.uid())), false) then
    raise exception 'Only an admin may change platform_role';
  end if;
  return new;
end;
$$;

create or replace function private.protect_team_creator()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.created_by_user_id is distinct from old.created_by_user_id
     and current_user not in ('postgres', 'service_role', 'supabase_admin')
     and not coalesce(private.is_admin((select auth.uid())), false) then
    raise exception 'Only an admin may change created_by_user_id';
  end if;
  return new;
end;
$$;

create or replace function private.protect_membership_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.team_id is distinct from old.team_id
     or new.user_id is distinct from old.user_id
     or new.created_by_user_id is distinct from old.created_by_user_id then
    if current_user not in ('postgres', 'service_role', 'supabase_admin')
       and not coalesce(private.is_admin((select auth.uid())), false) then
      raise exception 'Membership identity fields are immutable';
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace function private.handle_new_team()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.team_memberships (team_id, user_id, role, created_by_user_id)
  values (new.id, new.created_by_user_id, 'coach'::public.team_member_role, new.created_by_user_id)
  on conflict (team_id, user_id) do nothing;
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function private.set_updated_at();

create trigger profiles_protect_platform_role
before update on public.profiles
for each row execute function private.protect_profile_platform_role();

create trigger teams_set_updated_at
before update on public.teams
for each row execute function private.set_updated_at();

create trigger teams_protect_creator
before update on public.teams
for each row execute function private.protect_team_creator();

create trigger memberships_protect_identity
before update on public.team_memberships
for each row execute function private.protect_membership_identity();

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

create trigger on_team_created
  after insert on public.teams
  for each row execute function private.handle_new_team();

insert into public.profiles (id, full_name, avatar_url)
select
  u.id,
  coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name'),
  coalesce(u.raw_user_meta_data ->> 'avatar_url', u.raw_user_meta_data ->> 'picture')
from auth.users u
on conflict (id) do nothing;

alter table public.profiles enable row level security;
alter table public.teams enable row level security;
alter table public.team_memberships enable row level security;

revoke all on table public.profiles from anon;
revoke all on table public.teams from anon;
revoke all on table public.team_memberships from anon;

revoke all on table public.profiles from authenticated;
revoke all on table public.teams from authenticated;
revoke all on table public.team_memberships from authenticated;

grant select, update on table public.profiles to authenticated;
grant select, insert, update, delete on table public.teams to authenticated;
grant select, insert, update, delete on table public.team_memberships to authenticated;

grant select, insert, update, delete on table public.profiles to service_role;
grant select, insert, update, delete on table public.teams to service_role;
grant select, insert, update, delete on table public.team_memberships to service_role;

create policy profiles_select_visible
on public.profiles
for select
to authenticated
using (
  private.can_view_profile(id, (select auth.uid()))
);

create policy profiles_update_self_or_admin
on public.profiles
for update
to authenticated
using (
  id = (select auth.uid())
  or private.is_admin((select auth.uid()))
)
with check (
  id = (select auth.uid())
  or private.is_admin((select auth.uid()))
);

create policy teams_select_member_or_admin
on public.teams
for select
to authenticated
using (
  private.is_team_member(id, (select auth.uid()))
  or private.is_admin((select auth.uid()))
);

create policy teams_insert_self_or_admin
on public.teams
for insert
to authenticated
with check (
  created_by_user_id = (select auth.uid())
  or private.is_admin((select auth.uid()))
);

create policy teams_update_coach_or_admin
on public.teams
for update
to authenticated
using (
  private.can_manage_team(id, (select auth.uid()))
)
with check (
  private.can_manage_team(id, (select auth.uid()))
);

create policy teams_delete_coach_or_admin
on public.teams
for delete
to authenticated
using (
  private.can_manage_team(id, (select auth.uid()))
);

create policy memberships_select_self_or_roster_manager
on public.team_memberships
for select
to authenticated
using (
  user_id = (select auth.uid())
  or private.can_manage_roster(team_id, (select auth.uid()))
);

create policy memberships_insert_roster_manager
on public.team_memberships
for insert
to authenticated
with check (
  private.is_admin((select auth.uid()))
  or (
    private.can_manage_roster(team_id, (select auth.uid()))
    and created_by_user_id = (select auth.uid())
  )
);

create policy memberships_update_roster_manager
on public.team_memberships
for update
to authenticated
using (
  private.can_manage_roster(team_id, (select auth.uid()))
)
with check (
  private.can_manage_roster(team_id, (select auth.uid()))
);
create policy memberships_delete_roster_manager
on public.team_memberships
for delete
to authenticated
using (
  private.can_manage_roster(team_id, (select auth.uid()))
);
