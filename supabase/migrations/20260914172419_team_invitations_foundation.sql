create type public.team_invitation_status as enum ('pending','accepted','revoked','expired');

create table public.team_invitations (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  invited_email text not null,
  role public.team_member_role not null,
  invited_by_user_id uuid not null references public.profiles(id),
  token_hash text not null unique,
  status public.team_invitation_status not null default 'pending',
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_by_user_id uuid null references public.profiles(id),
  accepted_at timestamptz null,
  revoked_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_invitations_email_nonempty check (btrim(invited_email) <> ''),
  constraint team_invitations_role_allowed check (role in ('athlete'::public.team_member_role, 'assistant_coach'::public.team_member_role)),
  constraint team_invitations_acceptance_consistent check (
    (status = 'accepted' and accepted_by_user_id is not null and accepted_at is not null)
    or (status <> 'accepted' and accepted_by_user_id is null and accepted_at is null)
  )
);

create unique index team_invitations_one_pending_per_email_role
  on public.team_invitations (team_id, lower(invited_email), role)
  where status = 'pending';
create index team_invitations_team_id_idx on public.team_invitations(team_id);
create index team_invitations_invited_by_idx on public.team_invitations(invited_by_user_id);
create index team_invitations_expires_at_idx on public.team_invitations(expires_at) where status = 'pending';

alter table public.team_invitations enable row level security;

create policy team_invitations_select_manager
on public.team_invitations for select
to authenticated
using (
  private.is_admin((select auth.uid()))
  or private.can_manage_roster(team_id, (select auth.uid()))
);

create policy team_invitations_insert_authorized
on public.team_invitations for insert
to authenticated
with check (
  invited_by_user_id = (select auth.uid())
  and status = 'pending'
  and accepted_by_user_id is null
  and accepted_at is null
  and revoked_at is null
  and expires_at > now()
  and (
    private.is_admin((select auth.uid()))
    or (role = 'athlete'::public.team_member_role and private.can_manage_roster(team_id, (select auth.uid())))
    or (role = 'assistant_coach'::public.team_member_role and private.can_manage_team(team_id, (select auth.uid())))
  )
);

create policy team_invitations_update_manager
on public.team_invitations for update
to authenticated
using (
  private.is_admin((select auth.uid()))
  or (role = 'athlete'::public.team_member_role and private.can_manage_roster(team_id, (select auth.uid())))
  or (role = 'assistant_coach'::public.team_member_role and private.can_manage_team(team_id, (select auth.uid())))
)
with check (
  private.is_admin((select auth.uid()))
  or (role = 'athlete'::public.team_member_role and private.can_manage_roster(team_id, (select auth.uid())))
  or (role = 'assistant_coach'::public.team_member_role and private.can_manage_team(team_id, (select auth.uid())))
);

create policy team_invitations_delete_admin
on public.team_invitations for delete
to authenticated
using (private.is_admin((select auth.uid())));

create or replace function private.validate_team_invitation_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.team_id <> old.team_id
     or lower(new.invited_email) <> lower(old.invited_email)
     or new.role <> old.role
     or new.invited_by_user_id <> old.invited_by_user_id
     or new.token_hash <> old.token_hash
     or new.created_at <> old.created_at then
    raise exception 'Invitation identity fields cannot be changed';
  end if;

  if old.status = 'pending' then
    if new.status not in ('pending','accepted','revoked','expired') then
      raise exception 'Invalid invitation status transition';
    end if;
  elsif new.status <> old.status then
    raise exception 'Completed invitations cannot change status';
  end if;

  if new.status = 'revoked' and new.revoked_at is null then
    new.revoked_at := now();
  elsif new.status <> 'revoked' and new.revoked_at is distinct from old.revoked_at then
    raise exception 'revoked_at may only be set when revoking';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger validate_team_invitation_update
before update on public.team_invitations
for each row execute function private.validate_team_invitation_update();

create or replace function public.accept_team_invitation(invitation_token text)
returns table(team_id uuid, membership_id uuid, membership_role public.team_member_role)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_user_email text;
  v_inv public.team_invitations%rowtype;
  v_membership_id uuid;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select u.email into v_user_email
  from auth.users u
  where u.id = v_user_id;

  if v_user_email is null then
    raise exception 'Authenticated account has no email';
  end if;

  select i.* into v_inv
  from public.team_invitations i
  where i.token_hash = encode(extensions.digest(invitation_token, 'sha256'), 'hex')
  for update;

  if not found then
    raise exception 'Invitation not found';
  end if;

  if v_inv.status <> 'pending' then
    raise exception 'Invitation is no longer pending';
  end if;

  if v_inv.expires_at <= now() then
    update public.team_invitations set status = 'expired' where id = v_inv.id;
    raise exception 'Invitation has expired';
  end if;

  if lower(v_user_email) <> lower(v_inv.invited_email) then
    raise exception 'Invitation email does not match the signed-in account';
  end if;

  if v_inv.role = 'athlete'::public.team_member_role then
    if not private.can_manage_roster(v_inv.team_id, v_inv.invited_by_user_id) then
      raise exception 'Inviter no longer has permission to invite athletes';
    end if;
  elsif v_inv.role = 'assistant_coach'::public.team_member_role then
    if not private.can_manage_team(v_inv.team_id, v_inv.invited_by_user_id) then
      raise exception 'Inviter no longer has permission to invite assistant coaches';
    end if;
  else
    raise exception 'Unsupported invitation role';
  end if;

  if exists (
    select 1 from public.team_memberships tm
    where tm.team_id = v_inv.team_id and tm.user_id = v_user_id
  ) then
    raise exception 'User is already a member of this team';
  end if;

  insert into public.team_memberships(team_id, user_id, role, created_by_user_id)
  values (v_inv.team_id, v_user_id, v_inv.role, v_inv.invited_by_user_id)
  returning id into v_membership_id;

  update public.team_invitations
  set status = 'accepted', accepted_by_user_id = v_user_id, accepted_at = now()
  where id = v_inv.id;

  return query select v_inv.team_id, v_membership_id, v_inv.role;
end;
$$;

revoke all on function public.accept_team_invitation(text) from public;
grant execute on function public.accept_team_invitation(text) to authenticated;

create or replace function public.get_team_invitation_summary(invitation_token text)
returns table(team_name text, invitation_role public.team_member_role, expires_at timestamptz, invitation_status public.team_invitation_status)
language sql
stable
security definer
set search_path = ''
as $$
  select t.name, i.role, i.expires_at,
    case when i.status = 'pending' and i.expires_at <= now()
      then 'expired'::public.team_invitation_status
      else i.status
    end
  from public.team_invitations i
  join public.teams t on t.id = i.team_id
  where i.token_hash = encode(extensions.digest(invitation_token, 'sha256'), 'hex')
  limit 1;
$$;

revoke all on function public.get_team_invitation_summary(text) from public;
grant execute on function public.get_team_invitation_summary(text) to anon, authenticated;
