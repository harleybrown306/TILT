create type public.content_visibility as enum ('private','team','public');
create type public.exercise_difficulty as enum ('novice','intermediate','advanced');

create table public.exercises (
 id uuid primary key default gen_random_uuid(),
 name text not null check(char_length(btrim(name))>0),
 category text,
 difficulty public.exercise_difficulty not null default 'novice',
 instructions text,
 explanation text,
 video_url text,
 images text[] not null default '{}',
 skills text[] not null default '{}',
 skill_spot text,
 skill_context text,
 skill_context_2 text,
 grid_code text,
 switch_need boolean not null default false,
 body_tag_1 text,
 body_tag_type_1 text,
 body_tag_2 text,
 body_tag_type_2 text,
 visibility public.content_visibility not null default 'private',
 owner_user_id uuid references public.profiles(id) on delete set null,
 team_id uuid references public.teams(id) on delete cascade,
 source_system text,
 source_id text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check (visibility <> 'team' or team_id is not null)
);

create table public.workouts (
 id uuid primary key default gen_random_uuid(),
 name text not null check(char_length(btrim(name))>0),
 description text,
 difficulty public.exercise_difficulty not null default 'novice',
 image_url text,
 areas text[] not null default '{}',
 visibility public.content_visibility not null default 'private',
 owner_user_id uuid references public.profiles(id) on delete set null,
 team_id uuid references public.teams(id) on delete cascade,
 source_system text,
 source_id text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check (visibility <> 'team' or team_id is not null)
);

create table public.workout_exercises (
 id uuid primary key default gen_random_uuid(),
 workout_id uuid not null references public.workouts(id) on delete cascade,
 exercise_id uuid references public.exercises(id) on delete set null,
 position integer not null check(position >= 0),
 duration_seconds integer check(duration_seconds is null or duration_seconds >= 0),
 rest_seconds integer check(rest_seconds is null or rest_seconds >= 0),
 off_hand boolean not null default false,
 notes text,
 exercise_snapshot jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(workout_id, position)
);

create unique index exercises_source_unique_idx on public.exercises(source_system,source_id) where source_system is not null and source_id is not null;
create unique index workouts_source_unique_idx on public.workouts(source_system,source_id) where source_system is not null and source_id is not null;
create index exercises_owner_user_id_idx on public.exercises(owner_user_id);
create index exercises_team_id_idx on public.exercises(team_id);
create index workouts_owner_user_id_idx on public.workouts(owner_user_id);
create index workouts_team_id_idx on public.workouts(team_id);
create index workout_exercises_workout_id_idx on public.workout_exercises(workout_id);
create index workout_exercises_exercise_id_idx on public.workout_exercises(exercise_id);

create or replace function private.can_view_content(p_visibility public.content_visibility,p_owner uuid,p_team uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select private.is_admin(p_user)
 or p_visibility='public'
 or (p_owner=p_user)
 or (p_visibility='team' and p_team is not null and private.is_team_member(p_team,p_user));
$$;
create or replace function private.can_manage_content(p_owner uuid,p_team uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select private.is_admin(p_user)
 or p_owner=p_user
 or (p_team is not null and private.can_manage_team(p_team,p_user));
$$;

alter table public.exercises enable row level security; alter table public.workouts enable row level security; alter table public.workout_exercises enable row level security;

create policy exercises_select_visible on public.exercises for select to authenticated using(private.can_view_content(visibility,owner_user_id,team_id,(select auth.uid())));
create policy exercises_insert_authorized on public.exercises for insert to authenticated with check(private.is_admin((select auth.uid())) or owner_user_id=(select auth.uid()) or (team_id is not null and private.can_manage_team(team_id,(select auth.uid()))));
create policy exercises_update_authorized on public.exercises for update to authenticated using(private.can_manage_content(owner_user_id,team_id,(select auth.uid()))) with check(private.can_manage_content(owner_user_id,team_id,(select auth.uid())));
create policy exercises_delete_authorized on public.exercises for delete to authenticated using(private.can_manage_content(owner_user_id,team_id,(select auth.uid())));

create policy workouts_select_visible on public.workouts for select to authenticated using(private.can_view_content(visibility,owner_user_id,team_id,(select auth.uid())));
create policy workouts_insert_authorized on public.workouts for insert to authenticated with check(private.is_admin((select auth.uid())) or owner_user_id=(select auth.uid()) or (team_id is not null and private.can_manage_team(team_id,(select auth.uid()))));
create policy workouts_update_authorized on public.workouts for update to authenticated using(private.can_manage_content(owner_user_id,team_id,(select auth.uid()))) with check(private.can_manage_content(owner_user_id,team_id,(select auth.uid())));
create policy workouts_delete_authorized on public.workouts for delete to authenticated using(private.can_manage_content(owner_user_id,team_id,(select auth.uid())));

create policy workout_exercises_select_visible on public.workout_exercises for select to authenticated using(exists(select 1 from public.workouts w where w.id=workout_id and private.can_view_content(w.visibility,w.owner_user_id,w.team_id,(select auth.uid()))));
create policy workout_exercises_insert_authorized on public.workout_exercises for insert to authenticated with check(exists(select 1 from public.workouts w where w.id=workout_id and private.can_manage_content(w.owner_user_id,w.team_id,(select auth.uid()))));
create policy workout_exercises_update_authorized on public.workout_exercises for update to authenticated using(exists(select 1 from public.workouts w where w.id=workout_id and private.can_manage_content(w.owner_user_id,w.team_id,(select auth.uid())))) with check(exists(select 1 from public.workouts w where w.id=workout_id and private.can_manage_content(w.owner_user_id,w.team_id,(select auth.uid()))));
create policy workout_exercises_delete_authorized on public.workout_exercises for delete to authenticated using(exists(select 1 from public.workouts w where w.id=workout_id and private.can_manage_content(w.owner_user_id,w.team_id,(select auth.uid()))));

create trigger exercises_set_updated_at before update on public.exercises for each row execute function private.set_updated_at();
create trigger workouts_set_updated_at before update on public.workouts for each row execute function private.set_updated_at();
create trigger workout_exercises_set_updated_at before update on public.workout_exercises for each row execute function private.set_updated_at();
