create type public.training_plan_kind as enum ('coach', 'template');
create type public.training_plan_visibility as enum ('private', 'public');

alter table public.training_plans
  add column kind public.training_plan_kind not null default 'coach',
  add column visibility public.training_plan_visibility not null default 'private',
  add column source_template_id uuid null references public.training_plans(id) on delete set null,
  add column archived_at timestamptz null;

-- Existing coach plans become coach-library plans rather than team-bound plans.
update public.training_plans
set team_id = null
where kind = 'coach';

-- Preserve a sensible archive timestamp for plans archived before this migration.
update public.training_plans
set archived_at = updated_at
where status = 'archived' and archived_at is null;

alter table public.training_plans
  add constraint training_plans_archive_timestamp_consistency
  check ((status = 'archived' and archived_at is not null) or (status <> 'archived' and archived_at is null)),
  add constraint training_plans_template_visibility_consistency
  check ((kind = 'template' and visibility = 'public') or (kind = 'coach' and visibility = 'private'));

create index training_plans_source_template_id_idx on public.training_plans(source_template_id) where source_template_id is not null;
create index training_plans_owner_kind_status_idx on public.training_plans(owner_user_id, kind, status);

create or replace function private.enforce_training_plan_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'template' then
    new.visibility := 'public'::public.training_plan_visibility;
  else
    new.visibility := 'private'::public.training_plan_visibility;
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'archived'::public.training_plan_status then
      new.archived_at := coalesce(new.archived_at, now());
    else
      new.archived_at := null;
    end if;
    return new;
  end if;

  if old.status <> 'archived'::public.training_plan_status
     and new.status = 'archived'::public.training_plan_status then
    new.archived_at := now();
  elsif old.status = 'archived'::public.training_plan_status
        and new.status <> 'archived'::public.training_plan_status then
    if not private.is_admin(auth.uid())
       and (old.archived_at is null or old.archived_at < now() - interval '30 days') then
      raise exception 'Training plans may only be restored by coaches within 30 days of archiving';
    end if;
    new.archived_at := null;
  elsif new.status = 'archived'::public.training_plan_status then
    new.archived_at := old.archived_at;
  else
    new.archived_at := null;
  end if;

  return new;
end;
$$;

create trigger training_plans_lifecycle_before_write
before insert or update on public.training_plans
for each row execute function private.enforce_training_plan_lifecycle();

create or replace function private.can_manage_training_plan(check_plan_id uuid, check_user_id uuid)
returns boolean
language sql
stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.training_plans tp
    where tp.id = check_plan_id
      and (
        private.is_admin(check_user_id)
        or (tp.kind = 'coach'::public.training_plan_kind and tp.owner_user_id = check_user_id)
      )
  );
$$;

create or replace function private.can_view_training_plan(check_plan_id uuid, check_user_id uuid)
returns boolean
language sql
stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.training_plans tp
    where tp.id = check_plan_id
      and (
        private.is_admin(check_user_id)
        or (tp.kind = 'coach'::public.training_plan_kind and tp.owner_user_id = check_user_id)
        or (tp.kind = 'template'::public.training_plan_kind and tp.visibility = 'public'::public.training_plan_visibility)
      )
  );
$$;

-- Replace plan policies so coach plans are personal reusable library objects and public templates are readable by authenticated users.
drop policy if exists training_plans_select on public.training_plans;
drop policy if exists training_plans_insert on public.training_plans;
drop policy if exists training_plans_update on public.training_plans;
drop policy if exists training_plans_delete on public.training_plans;

create policy training_plans_select on public.training_plans
for select to authenticated
using (
  private.is_admin((select auth.uid()))
  or (kind = 'coach'::public.training_plan_kind and owner_user_id = (select auth.uid()))
  or (kind = 'template'::public.training_plan_kind and visibility = 'public'::public.training_plan_visibility)
);

create policy training_plans_insert on public.training_plans
for insert to authenticated
with check (
  private.is_admin((select auth.uid()))
  or (
    kind = 'coach'::public.training_plan_kind
    and visibility = 'private'::public.training_plan_visibility
    and owner_user_id = (select auth.uid())
    and team_id is null
  )
);

create policy training_plans_update on public.training_plans
for update to authenticated
using (
  private.is_admin((select auth.uid()))
  or (kind = 'coach'::public.training_plan_kind and owner_user_id = (select auth.uid()))
)
with check (
  private.is_admin((select auth.uid()))
  or (
    kind = 'coach'::public.training_plan_kind
    and visibility = 'private'::public.training_plan_visibility
    and owner_user_id = (select auth.uid())
    and team_id is null
  )
);

-- Avoid hard deletion of plans through normal authenticated clients; archive instead.
create policy training_plans_delete on public.training_plans
for delete to authenticated
using (private.is_admin((select auth.uid())));
