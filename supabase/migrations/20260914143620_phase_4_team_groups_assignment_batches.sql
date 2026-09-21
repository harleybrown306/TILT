create table public.team_groups (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  name text not null,
  description text,
  category text,
  created_by_user_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_groups_name_not_blank check (btrim(name) <> ''),
  constraint team_groups_unique_name_per_team unique (team_id, name)
);

create table public.team_group_memberships (
  id uuid primary key default gen_random_uuid(),
  team_group_id uuid not null references public.team_groups(id) on delete cascade,
  athlete_user_id uuid not null references public.profiles(id) on delete cascade,
  created_by_user_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint team_group_memberships_unique unique (team_group_id, athlete_user_id)
);

create table public.training_assignment_batches (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  training_plan_id uuid not null references public.training_plans(id) on delete restrict,
  assigned_by_user_id uuid not null references public.profiles(id) on delete restrict,
  start_date date not null,
  notes text,
  selection_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.training_plan_assignments
  add column assignment_batch_id uuid references public.training_assignment_batches(id) on delete set null;

create index idx_team_groups_team_id on public.team_groups(team_id);
create index idx_team_group_memberships_group_id on public.team_group_memberships(team_group_id);
create index idx_team_group_memberships_athlete_user_id on public.team_group_memberships(athlete_user_id);
create index idx_training_assignment_batches_team_id on public.training_assignment_batches(team_id);
create index idx_training_assignment_batches_plan_id on public.training_assignment_batches(training_plan_id);
create index idx_training_plan_assignments_batch_id on public.training_plan_assignments(assignment_batch_id);

create trigger team_groups_set_updated_at
before update on public.team_groups
for each row execute function private.set_updated_at();

alter table public.team_groups enable row level security;
alter table public.team_group_memberships enable row level security;
alter table public.training_assignment_batches enable row level security;

create policy team_groups_select_team_member
on public.team_groups
for select
to authenticated
using (
  private.is_admin((select auth.uid()))
  or private.is_team_member(team_id, (select auth.uid()))
);

create policy team_groups_insert_roster_manager
on public.team_groups
for insert
to authenticated
with check (
  private.is_admin((select auth.uid()))
  or (
    private.can_manage_roster(team_id, (select auth.uid()))
    and created_by_user_id = (select auth.uid())
  )
);

create policy team_groups_update_roster_manager
on public.team_groups
for update
to authenticated
using (
  private.is_admin((select auth.uid()))
  or private.can_manage_roster(team_id, (select auth.uid()))
)
with check (
  private.is_admin((select auth.uid()))
  or private.can_manage_roster(team_id, (select auth.uid()))
);

create policy team_groups_delete_roster_manager
on public.team_groups
for delete
to authenticated
using (
  private.is_admin((select auth.uid()))
  or private.can_manage_roster(team_id, (select auth.uid()))
);

create policy team_group_memberships_select_team_member
on public.team_group_memberships
for select
to authenticated
using (
  private.is_admin((select auth.uid()))
  or exists (
    select 1
    from public.team_groups g
    where g.id = team_group_id
      and private.is_team_member(g.team_id, (select auth.uid()))
  )
);

create policy team_group_memberships_insert_roster_manager
on public.team_group_memberships
for insert
to authenticated
with check (
  private.is_admin((select auth.uid()))
  or (
    created_by_user_id = (select auth.uid())
    and exists (
      select 1
      from public.team_groups g
      join public.team_memberships tm
        on tm.team_id = g.team_id
       and tm.user_id = athlete_user_id
       and tm.role = 'athlete'::public.team_member_role
      where g.id = team_group_id
        and private.can_manage_roster(g.team_id, (select auth.uid()))
    )
  )
);

create policy team_group_memberships_delete_roster_manager
on public.team_group_memberships
for delete
to authenticated
using (
  private.is_admin((select auth.uid()))
  or exists (
    select 1
    from public.team_groups g
    where g.id = team_group_id
      and private.can_manage_roster(g.team_id, (select auth.uid()))
  )
);

create policy training_assignment_batches_select_manager
on public.training_assignment_batches
for select
to authenticated
using (
  private.is_admin((select auth.uid()))
  or private.can_manage_roster(team_id, (select auth.uid()))
);

create policy training_assignment_batches_insert_manager
on public.training_assignment_batches
for insert
to authenticated
with check (
  private.is_admin((select auth.uid()))
  or (
    private.can_manage_roster(team_id, (select auth.uid()))
    and assigned_by_user_id = (select auth.uid())
  )
);

create policy training_assignment_batches_update_manager
on public.training_assignment_batches
for update
to authenticated
using (
  private.is_admin((select auth.uid()))
  or private.can_manage_roster(team_id, (select auth.uid()))
)
with check (
  private.is_admin((select auth.uid()))
  or private.can_manage_roster(team_id, (select auth.uid()))
);

create policy training_assignment_batches_delete_manager
on public.training_assignment_batches
for delete
to authenticated
using (
  private.is_admin((select auth.uid()))
  or private.can_manage_roster(team_id, (select auth.uid()))
);
