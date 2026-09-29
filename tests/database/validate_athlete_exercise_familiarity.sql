-- Execute against a disposable local database after all migrations.  This
-- validates the projection trigger independently; fixtures roll back.
BEGIN;

DO $validation$
DECLARE
  v_guardian uuid;
  v_self uuid;
  v_coach uuid;
  v_unrelated uuid;
  v_actor uuid;
  v_athlete_a uuid := gen_random_uuid();
  v_athlete_b uuid := gen_random_uuid();
  v_team_a uuid := gen_random_uuid();
  v_team_b uuid := gen_random_uuid();
  v_exercise_a uuid := gen_random_uuid();
  v_exercise_b uuid := gen_random_uuid();
  v_exercise_c uuid := gen_random_uuid();
  v_replacement uuid := gen_random_uuid();
  v_workout uuid := gen_random_uuid();
  v_step_a uuid := gen_random_uuid();
  v_step_b uuid := gen_random_uuid();
  v_step_c uuid := gen_random_uuid();
  v_session_a uuid := gen_random_uuid();
  v_session_b uuid := gen_random_uuid();
  v_result_a uuid := gen_random_uuid();
  v_result_b uuid := gen_random_uuid();
  v_attempt_a uuid := gen_random_uuid();
  v_attempt_b uuid := gen_random_uuid();
  v_denied boolean;
BEGIN
  SELECT athlete_id, profile_id INTO v_athlete_a, v_self
  FROM public.athlete_profile_relationships
  WHERE role = 'self' AND revoked_at IS NULL ORDER BY created_at LIMIT 1;
  SELECT id INTO v_guardian FROM public.profiles WHERE platform_role <> 'admin' AND id <> v_self ORDER BY id LIMIT 1;
  SELECT id INTO v_coach FROM public.profiles WHERE platform_role <> 'admin' AND id NOT IN (v_guardian, v_self) ORDER BY id LIMIT 1;
  SELECT id INTO v_unrelated FROM public.profiles WHERE platform_role <> 'admin' AND id NOT IN (v_guardian, v_self, v_coach) ORDER BY id LIMIT 1;
  IF v_guardian IS NULL OR v_self IS NULL OR v_coach IS NULL OR v_unrelated IS NULL THEN
    RAISE EXCEPTION 'Validation requires guardian, self, coach, and unrelated profiles';
  END IF;

  -- Use a separate sibling athlete, while the existing self athlete proves
  -- profile identity is not used as the projection key.
  INSERT INTO public.athletes(id, display_name, created_by_profile_id)
  VALUES (v_athlete_b, 'Familiarity sibling', v_guardian);
  INSERT INTO public.athlete_profile_relationships
    (athlete_id, profile_id, role, training_permission, manage_permission, created_by_profile_id)
  VALUES
    (v_athlete_a, v_guardian, 'guardian', true, true, v_guardian),
    (v_athlete_b, v_guardian, 'guardian', true, true, v_guardian);

  INSERT INTO public.teams(id, name, created_by_user_id)
  VALUES (v_team_a, 'Familiarity A', v_guardian), (v_team_b, 'Familiarity B', v_guardian);
  INSERT INTO public.team_staff_memberships(team_id, profile_id, role, created_by_profile_id)
  VALUES (v_team_a, v_coach, 'coach', v_guardian);
  INSERT INTO public.exercises(id, name) VALUES
    (v_exercise_a, 'Familiarity completed'), (v_exercise_b, 'Familiarity skipped'),
    (v_exercise_c, 'Familiarity completed again');
  INSERT INTO public.workouts(id, name) VALUES (v_workout, 'Familiarity workout');
  INSERT INTO public.workout_exercises
    (id, workout_id, exercise_id, position, duration_seconds, rest_seconds, exercise_snapshot)
  VALUES
    (v_step_a, v_workout, v_exercise_a, 0, 10, 0, jsonb_build_object('exercise_name', 'Familiarity completed')),
    (v_step_b, v_workout, v_exercise_b, 1, 10, 0, jsonb_build_object('exercise_name', 'Familiarity skipped')),
    (v_step_c, v_workout, v_exercise_c, 2, 10, 0, jsonb_build_object('exercise_name', 'Familiarity completed again'));
  INSERT INTO public.training_sessions
    (id, athlete_id, coach_user_id, team_id, workout_id, scheduled_date, status)
  VALUES
    (v_session_a, v_athlete_a, v_guardian, v_team_a, v_workout, current_date, 'scheduled'),
    (v_session_b, v_athlete_b, v_guardian, v_team_b, v_workout, current_date, 'scheduled');

  -- Assignment/session existence alone produces no familiarity.
  IF EXISTS (SELECT 1 FROM public.athlete_exercise_familiarity WHERE athlete_id IN (v_athlete_a, v_athlete_b)) THEN
    RAISE EXCEPTION 'Assignment or preview state created familiarity';
  END IF;

  -- The real public ACT finalization path, rather than a privileged attempt
  -- UPDATE, must be what crosses the production materialization boundary.
  PERFORM set_config('request.jwt.claim.sub', v_guardian::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT result_id INTO v_result_a FROM public.complete_my_training_session(v_session_a);
  INSERT INTO public.workout_session_events
    (id, session_id, attempt_id, sequence, event_type, workout_exercise_id, step_position, phase,
     phase_duration_ms, phase_elapsed_ms, elapsed_ms, occurred_at)
  VALUES
    (gen_random_uuid(), v_session_a, v_attempt_a, 0, 'workout_started', NULL, NULL, 'ready', NULL, NULL, 0, clock_timestamp());
  PERFORM public.register_my_workout_session_attempt(v_attempt_a, v_session_a);
  INSERT INTO public.workout_session_events
    (id, session_id, attempt_id, sequence, event_type, workout_exercise_id, step_position, phase,
     phase_duration_ms, phase_elapsed_ms, elapsed_ms, occurred_at)
  VALUES
    (gen_random_uuid(), v_session_a, v_attempt_a, 1, 'exercise_started', v_step_a, 0, 'work', 10000, 0, 0, clock_timestamp()),
    (gen_random_uuid(), v_session_a, v_attempt_a, 2, 'exercise_completed', v_step_a, 0, 'work', 10000, 10000, 10000, clock_timestamp()),
    (gen_random_uuid(), v_session_a, v_attempt_a, 3, 'exercise_started', v_step_b, 1, 'work', 10000, 0, 10000, clock_timestamp()),
    (gen_random_uuid(), v_session_a, v_attempt_a, 4, 'exercise_skipped', v_step_b, 1, 'work', 10000, 0, 10000, clock_timestamp()),
    (gen_random_uuid(), v_session_a, v_attempt_a, 5, 'exercise_started', v_step_c, 2, 'work', 10000, 0, 10000, clock_timestamp()),
    (gen_random_uuid(), v_session_a, v_attempt_a, 6, 'exercise_completed', v_step_c, 2, 'work', 10000, 10000, 20000, clock_timestamp()),
    (gen_random_uuid(), v_session_a, v_attempt_a, 7, 'workout_completed', NULL, NULL, 'finished', NULL, NULL, 20000, clock_timestamp());
  PERFORM public.finalize_my_workout_session_attempt(v_attempt_a);
  EXECUTE 'RESET ROLE';

  -- Plausible raw telemetry for the sibling remains inert without finalization.
  INSERT INTO public.workout_session_attempts
    (id, training_session_id, athlete_id, started_at, prescription_schema_version,
     prescribed_work_ms, prescribed_rest_ms, prescribed_total_ms, prescribed_step_count)
  VALUES (v_attempt_b, v_session_b, v_athlete_b, clock_timestamp(), 1, 30000, 0, 30000, 3);
  INSERT INTO public.workout_session_events
    (id, session_id, attempt_id, sequence, event_type, workout_exercise_id, step_position, phase,
     phase_duration_ms, phase_elapsed_ms, elapsed_ms, occurred_at)
  VALUES (gen_random_uuid(), v_session_b, v_attempt_b, 0, 'exercise_completed', v_step_a, 0, 'work', 10000, 10000, 10000, clock_timestamp());

  IF NOT EXISTS (SELECT 1 FROM public.athlete_exercise_familiarity WHERE athlete_id=v_athlete_a AND exercise_id=v_exercise_a)
     OR NOT EXISTS (SELECT 1 FROM public.athlete_exercise_familiarity WHERE athlete_id=v_athlete_a AND exercise_id=v_exercise_c)
     OR EXISTS (SELECT 1 FROM public.athlete_exercise_familiarity WHERE athlete_id=v_athlete_a AND exercise_id=v_exercise_b)
     OR EXISTS (SELECT 1 FROM public.athlete_exercise_familiarity WHERE athlete_id=v_athlete_b) THEN
    RAISE EXCEPTION 'completed/skipped or sibling projection semantics are incorrect';
  END IF;

  -- Retries and repeated semantic occurrences collapse at the database key.
  UPDATE public.workout_session_attempts SET finalized_at = clock_timestamp() WHERE id = v_attempt_a;
  IF (SELECT count(*) FROM public.athlete_exercise_familiarity WHERE athlete_id=v_athlete_a AND exercise_id=v_exercise_a) <> 1 THEN
    RAISE EXCEPTION 'retry created duplicate familiarity';
  END IF;

  -- Projection-boundary timestamp ordering is separately exercised because
  -- two legitimate finalizations can settle in either unique-index order.
  INSERT INTO public.athlete_exercise_familiarity(athlete_id, exercise_id, first_completed_at)
  VALUES (v_athlete_a, v_exercise_b, '2026-09-29T12:00:00Z')
  ON CONFLICT (athlete_id, exercise_id) DO UPDATE
  SET first_completed_at=LEAST(public.athlete_exercise_familiarity.first_completed_at, EXCLUDED.first_completed_at);
  INSERT INTO public.athlete_exercise_familiarity(athlete_id, exercise_id, first_completed_at)
  VALUES (v_athlete_a, v_exercise_b, '2026-09-29T11:00:00Z')
  ON CONFLICT (athlete_id, exercise_id) DO UPDATE
  SET first_completed_at=LEAST(public.athlete_exercise_familiarity.first_completed_at, EXCLUDED.first_completed_at);
  IF (SELECT first_completed_at FROM public.athlete_exercise_familiarity WHERE athlete_id=v_athlete_a AND exercise_id=v_exercise_b) <> '2026-09-29T11:00:00Z' THEN
    RAISE EXCEPTION 'later-first timestamp order did not retain the earliest trusted value';
  END IF;

  -- Team movement does not change athlete-owned familiarity.
  INSERT INTO public.team_athlete_memberships(team_id, athlete_id, created_by_profile_id)
  VALUES (v_team_b, v_athlete_a, v_guardian);
  IF NOT EXISTS (SELECT 1 FROM public.athlete_exercise_familiarity WHERE athlete_id=v_athlete_a AND exercise_id=v_exercise_a) THEN
    RAISE EXCEPTION 'team transfer reset familiarity';
  END IF;

  -- Deleting content preserves the historical UUID; a new UUID is unfamiliar.
  DELETE FROM public.exercises WHERE id=v_exercise_a;
  INSERT INTO public.exercises(id, name) VALUES (v_replacement, 'Familiarity replacement');
  IF NOT EXISTS (SELECT 1 FROM public.athlete_exercise_familiarity WHERE athlete_id=v_athlete_a AND exercise_id=v_exercise_a)
     OR EXISTS (SELECT 1 FROM public.athlete_exercise_familiarity WHERE athlete_id=v_athlete_a AND exercise_id=v_replacement) THEN
    RAISE EXCEPTION 'exercise deletion or replacement incorrectly changed history';
  END IF;

  -- Guardian and self see the same athlete row; sibling and unrelated access do not leak.
  PERFORM set_config('request.jwt.claim.sub', v_guardian::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
  IF NOT EXISTS (SELECT 1 FROM public.athlete_exercise_familiarity WHERE athlete_id=v_athlete_a AND exercise_id=v_exercise_a)
     OR NOT EXISTS (SELECT 1 FROM public.athlete_exercise_familiarity WHERE athlete_id=v_athlete_a AND exercise_id=v_exercise_c) THEN
    EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'guardian could not read athlete familiarity';
  END IF;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', v_self::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
  IF NOT EXISTS (SELECT 1 FROM public.athlete_exercise_familiarity WHERE athlete_id=v_athlete_a AND exercise_id=v_exercise_a)
     OR NOT EXISTS (SELECT 1 FROM public.athlete_exercise_familiarity WHERE athlete_id=v_athlete_a AND exercise_id=v_exercise_c)
     OR EXISTS (SELECT 1 FROM public.athlete_exercise_familiarity WHERE athlete_id=v_athlete_b) THEN
    EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'self read leaked sibling or failed';
  END IF;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', v_unrelated::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
  IF EXISTS (SELECT 1 FROM public.athlete_exercise_familiarity WHERE athlete_id=v_athlete_a) THEN
    EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'unrelated profile read familiarity';
  END IF;
  -- All ordinary roles, including roster-visible staff, are read-only.
  FOR v_actor IN SELECT id FROM (VALUES (v_self), (v_guardian), (v_coach)) AS actors(id) LOOP
    PERFORM set_config('request.jwt.claim.sub', v_actor::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    v_denied := false; BEGIN
      INSERT INTO public.athlete_exercise_familiarity(athlete_id, exercise_id, first_completed_at) VALUES (v_athlete_a, gen_random_uuid(), clock_timestamp());
    EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
    IF NOT v_denied THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'ordinary authenticated role directly inserted familiarity'; END IF;
    v_denied := false; BEGIN
      UPDATE public.athlete_exercise_familiarity SET first_completed_at=clock_timestamp() WHERE athlete_id=v_athlete_a AND exercise_id=v_exercise_a;
    EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
    IF NOT v_denied THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'ordinary authenticated role directly updated familiarity'; END IF;
    v_denied := false; BEGIN
      DELETE FROM public.athlete_exercise_familiarity WHERE athlete_id=v_athlete_a AND exercise_id=v_exercise_a;
    EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
    IF NOT v_denied THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'ordinary authenticated role directly deleted familiarity'; END IF;
    EXECUTE 'RESET ROLE';
  END LOOP;
  EXECUTE 'SET LOCAL ROLE anon';
  v_denied := false; BEGIN INSERT INTO public.athlete_exercise_familiarity(athlete_id, exercise_id, first_completed_at) VALUES (v_athlete_a, gen_random_uuid(), clock_timestamp()); EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'anon directly inserted familiarity'; END IF;
  v_denied := false; BEGIN UPDATE public.athlete_exercise_familiarity SET first_completed_at=clock_timestamp() WHERE athlete_id=v_athlete_a AND exercise_id=v_exercise_a; EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'anon directly updated familiarity'; END IF;
  v_denied := false; BEGIN DELETE FROM public.athlete_exercise_familiarity WHERE athlete_id=v_athlete_a AND exercise_id=v_exercise_a; EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  EXECUTE 'RESET ROLE';
  IF NOT v_denied THEN RAISE EXCEPTION 'anon directly deleted familiarity'; END IF;
END;
$validation$;

ROLLBACK;
