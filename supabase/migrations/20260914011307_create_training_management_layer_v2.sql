create schema if not exists private;
DO $$ BEGIN CREATE TYPE public.training_plan_status AS ENUM ('draft','active','archived'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.training_assignment_status AS ENUM ('active','completed','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.training_session_status AS ENUM ('scheduled','completed','missed','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

create or replace function private.is_team_coach(check_team_id uuid, check_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.team_memberships tm
    where tm.team_id = check_team_id and tm.user_id = check_user_id
      and tm.role in ('coach'::public.team_member_role, 'assistant_coach'::public.team_member_role)
  );
$$;

create or replace function private.is_team_athlete(check_team_id uuid, check_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.team_memberships tm
    where tm.team_id = check_team_id and tm.user_id = check_user_id
      and tm.role = 'athlete'::public.team_member_role
  );
$$;

grant usage on schema private to authenticated;
grant execute on function private.is_team_coach(uuid, uuid) to authenticated;
grant execute on function private.is_team_athlete(uuid, uuid) to authenticated;

create table public.training_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  description text,
  team_id uuid references public.teams(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  status public.training_plan_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index training_plans_team_id_idx on public.training_plans(team_id);
create index training_plans_owner_user_id_idx on public.training_plans(owner_user_id);

create table public.training_plan_items (
  id uuid primary key default gen_random_uuid(),
  training_plan_id uuid not null references public.training_plans(id) on delete cascade,
  workout_id uuid not null references public.workouts(id) on delete restrict,
  day_offset integer not null default 0 check (day_offset >= 0),
  position integer not null check (position >= 0),
  scheduled_time time,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(training_plan_id, position)
);
create index training_plan_items_plan_id_idx on public.training_plan_items(training_plan_id);
create index training_plan_items_workout_id_idx on public.training_plan_items(workout_id);

create table public.training_plan_assignments (
  id uuid primary key default gen_random_uuid(),
  training_plan_id uuid not null references public.training_plans(id) on delete restrict,
  team_id uuid not null references public.teams(id) on delete cascade,
  athlete_user_id uuid not null references auth.users(id) on delete cascade,
  assigned_by_user_id uuid not null references auth.users(id) on delete restrict,
  start_date date not null,
  status public.training_assignment_status not null default 'active',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index training_plan_assignments_plan_id_idx on public.training_plan_assignments(training_plan_id);
create index training_plan_assignments_team_id_idx on public.training_plan_assignments(team_id);
create index training_plan_assignments_athlete_user_id_idx on public.training_plan_assignments(athlete_user_id);
create index training_plan_assignments_assigned_by_user_id_idx on public.training_plan_assignments(assigned_by_user_id);

create table public.training_sessions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid references public.training_plan_assignments(id) on delete cascade,
  plan_item_id uuid references public.training_plan_items(id) on delete set null,
  athlete_user_id uuid not null references auth.users(id) on delete cascade,
  coach_user_id uuid not null references auth.users(id) on delete restrict,
  team_id uuid not null references public.teams(id) on delete cascade,
  workout_id uuid not null references public.workouts(id) on delete restrict,
  scheduled_date date not null,
  scheduled_time time,
  status public.training_session_status not null default 'scheduled',
  completed_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(assignment_id, plan_item_id)
);
create index training_sessions_athlete_date_idx on public.training_sessions(athlete_user_id, scheduled_date);
create index training_sessions_team_date_idx on public.training_sessions(team_id, scheduled_date);
create index training_sessions_coach_user_id_idx on public.training_sessions(coach_user_id);
create index training_sessions_workout_id_idx on public.training_sessions(workout_id);
create index training_sessions_status_idx on public.training_sessions(status);

create table public.workout_results (
  id uuid primary key default gen_random_uuid(),
  training_session_id uuid not null unique references public.training_sessions(id) on delete cascade,
  athlete_user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz,
  completed_at timestamptz not null default now(),
  active_minutes integer check (active_minutes is null or active_minutes >= 0),
  total_duration_minutes integer check (total_duration_minutes is null or total_duration_minutes >= 0),
  exercises_completed integer check (exercises_completed is null or exercises_completed >= 0),
  notes text,
  result_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index workout_results_athlete_user_id_idx on public.workout_results(athlete_user_id);
create index workout_results_completed_at_idx on public.workout_results(completed_at);

create or replace function private.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$ begin new.updated_at = now(); return new; end; $$;
create trigger training_plans_set_updated_at before update on public.training_plans for each row execute function private.set_updated_at();
create trigger training_plan_items_set_updated_at before update on public.training_plan_items for each row execute function private.set_updated_at();
create trigger training_plan_assignments_set_updated_at before update on public.training_plan_assignments for each row execute function private.set_updated_at();
create trigger training_sessions_set_updated_at before update on public.training_sessions for each row execute function private.set_updated_at();
create trigger workout_results_set_updated_at before update on public.workout_results for each row execute function private.set_updated_at();

create or replace function private.can_view_training_plan(check_plan_id uuid, check_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.training_plans tp where tp.id = check_plan_id and (
      tp.owner_user_id = check_user_id
      or (tp.team_id is not null and private.is_team_member(tp.team_id, check_user_id))
      or private.is_admin(check_user_id)
    )
  );
$$;
create or replace function private.can_manage_training_plan(check_plan_id uuid, check_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.training_plans tp where tp.id = check_plan_id and (
      tp.owner_user_id = check_user_id
      or (tp.team_id is not null and private.is_team_coach(tp.team_id, check_user_id))
      or private.is_admin(check_user_id)
    )
  );
$$;
grant execute on function private.can_view_training_plan(uuid, uuid) to authenticated;
grant execute on function private.can_manage_training_plan(uuid, uuid) to authenticated;

create or replace function private.generate_sessions_for_assignment()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.training_sessions (assignment_id, plan_item_id, athlete_user_id, coach_user_id, team_id, workout_id, scheduled_date, scheduled_time, status)
  select new.id, tpi.id, new.athlete_user_id, new.assigned_by_user_id, new.team_id, tpi.workout_id,
         new.start_date + tpi.day_offset, tpi.scheduled_time, 'scheduled'::public.training_session_status
  from public.training_plan_items tpi
  where tpi.training_plan_id = new.training_plan_id
  order by tpi.day_offset, tpi.position;
  return new;
end; $$;
create trigger training_plan_assignment_generate_sessions after insert on public.training_plan_assignments for each row execute function private.generate_sessions_for_assignment();

create or replace function private.sync_session_from_result()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.training_sessions set status='completed'::public.training_session_status, completed_at=new.completed_at, updated_at=now()
  where id=new.training_session_id;
  return new;
end; $$;
create trigger workout_result_sync_session after insert or update of completed_at on public.workout_results for each row execute function private.sync_session_from_result();

alter table public.training_plans enable row level security;
alter table public.training_plan_items enable row level security;
alter table public.training_plan_assignments enable row level security;
alter table public.training_sessions enable row level security;
alter table public.workout_results enable row level security;

create policy training_plans_select on public.training_plans for select to authenticated using (
  owner_user_id=(select auth.uid()) or (team_id is not null and (select private.is_team_member(team_id,(select auth.uid())))) or (select private.is_admin((select auth.uid())))
);
create policy training_plans_insert on public.training_plans for insert to authenticated with check (
  (owner_user_id=(select auth.uid()) and (team_id is null or (select private.is_team_coach(team_id,(select auth.uid()))))) or (select private.is_admin((select auth.uid())))
);
create policy training_plans_update on public.training_plans for update to authenticated using (
  owner_user_id=(select auth.uid()) or (team_id is not null and (select private.is_team_coach(team_id,(select auth.uid())))) or (select private.is_admin((select auth.uid())))
) with check (
  owner_user_id=(select auth.uid()) or (team_id is not null and (select private.is_team_coach(team_id,(select auth.uid())))) or (select private.is_admin((select auth.uid())))
);
create policy training_plans_delete on public.training_plans for delete to authenticated using (
  owner_user_id=(select auth.uid()) or (team_id is not null and (select private.is_team_coach(team_id,(select auth.uid())))) or (select private.is_admin((select auth.uid())))
);

create policy training_plan_items_select on public.training_plan_items for select to authenticated using ((select private.can_view_training_plan(training_plan_id,(select auth.uid()))));
create policy training_plan_items_insert on public.training_plan_items for insert to authenticated with check ((select private.can_manage_training_plan(training_plan_id,(select auth.uid()))));
create policy training_plan_items_update on public.training_plan_items for update to authenticated using ((select private.can_manage_training_plan(training_plan_id,(select auth.uid())))) with check ((select private.can_manage_training_plan(training_plan_id,(select auth.uid()))));
create policy training_plan_items_delete on public.training_plan_items for delete to authenticated using ((select private.can_manage_training_plan(training_plan_id,(select auth.uid()))));

create policy training_plan_assignments_select on public.training_plan_assignments for select to authenticated using (
  athlete_user_id=(select auth.uid()) or (select private.is_team_coach(team_id,(select auth.uid()))) or (select private.is_admin((select auth.uid())))
);
create policy training_plan_assignments_insert on public.training_plan_assignments for insert to authenticated with check (
  (assigned_by_user_id=(select auth.uid()) and (select private.is_team_coach(team_id,(select auth.uid()))) and (select private.is_team_athlete(team_id,athlete_user_id)) and (select private.can_manage_training_plan(training_plan_id,(select auth.uid()))))
  or (select private.is_admin((select auth.uid())))
);
create policy training_plan_assignments_update on public.training_plan_assignments for update to authenticated using (
  (select private.is_team_coach(team_id,(select auth.uid()))) or (select private.is_admin((select auth.uid())))
) with check (
  (select private.is_team_coach(team_id,(select auth.uid()))) or (select private.is_admin((select auth.uid())))
);
create policy training_plan_assignments_delete on public.training_plan_assignments for delete to authenticated using (
  (select private.is_team_coach(team_id,(select auth.uid()))) or (select private.is_admin((select auth.uid())))
);

create policy training_sessions_select on public.training_sessions for select to authenticated using (
  athlete_user_id=(select auth.uid()) or (select private.is_team_coach(team_id,(select auth.uid()))) or (select private.is_admin((select auth.uid())))
);
create policy training_sessions_insert on public.training_sessions for insert to authenticated with check (
  (select private.is_team_coach(team_id,(select auth.uid()))) or (select private.is_admin((select auth.uid())))
);
create policy training_sessions_update on public.training_sessions for update to authenticated using (
  (select private.is_team_coach(team_id,(select auth.uid()))) or (select private.is_admin((select auth.uid())))
) with check (
  (select private.is_team_coach(team_id,(select auth.uid()))) or (select private.is_admin((select auth.uid())))
);
create policy training_sessions_delete on public.training_sessions for delete to authenticated using (
  (select private.is_team_coach(team_id,(select auth.uid()))) or (select private.is_admin((select auth.uid())))
);

create policy workout_results_select on public.workout_results for select to authenticated using (
  athlete_user_id=(select auth.uid()) or exists (
    select 1 from public.training_sessions ts where ts.id=training_session_id and (select private.is_team_coach(ts.team_id,(select auth.uid())))
  ) or (select private.is_admin((select auth.uid())))
);
create policy workout_results_insert on public.workout_results for insert to authenticated with check (
  athlete_user_id=(select auth.uid()) and exists (
    select 1 from public.training_sessions ts where ts.id=training_session_id and ts.athlete_user_id=(select auth.uid())
  )
);
create policy workout_results_update on public.workout_results for update to authenticated using (athlete_user_id=(select auth.uid())) with check (
  athlete_user_id=(select auth.uid()) and exists (
    select 1 from public.training_sessions ts where ts.id=training_session_id and ts.athlete_user_id=(select auth.uid())
  )
);
create policy workout_results_delete on public.workout_results for delete to authenticated using (
  exists (select 1 from public.training_sessions ts where ts.id=training_session_id and (select private.is_team_coach(ts.team_id,(select auth.uid())))) or (select private.is_admin((select auth.uid())))
);

grant select, insert, update, delete on public.training_plans, public.training_plan_items, public.training_plan_assignments, public.training_sessions, public.workout_results to authenticated;
