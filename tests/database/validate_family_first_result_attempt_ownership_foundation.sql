-- Execute only after create_family_first_result_attempt_ownership_foundation.sql.
-- Every fixture, role change, and assertion is contained in this transaction.
BEGIN;

DO $validation$
DECLARE
  v_self uuid;
  v_guardian uuid;
  v_coach uuid;
  v_assistant uuid;
  v_admin uuid;
  v_unrelated uuid;
  v_child uuid;
  v_sibling uuid;
  v_team uuid;
  v_session uuid;
  v_other_session uuid;
  v_self_session uuid;
  v_result uuid;
  v_attempt uuid := gen_random_uuid();
  v_before_results bigint;
  v_before_attempts bigint;
  v_before_events bigint;
  v_failed boolean;
  v_actor uuid;
BEGIN
  SELECT relationship.athlete_id INTO v_self
  FROM public.athlete_profile_relationships AS relationship
  WHERE relationship.profile_id = relationship.athlete_id
    AND relationship.role = 'self'
    AND relationship.revoked_at IS NULL
    AND relationship.training_permission
  ORDER BY relationship.created_at LIMIT 1;
  SELECT profile.id INTO v_guardian FROM public.profiles AS profile
  WHERE profile.platform_role <> 'admin' AND profile.id <> v_self
  ORDER BY profile.id LIMIT 1;
  SELECT profile.id INTO v_coach FROM public.profiles AS profile
  WHERE profile.platform_role <> 'admin' AND profile.id NOT IN (v_self, v_guardian)
  ORDER BY profile.id LIMIT 1;
  SELECT profile.id INTO v_assistant FROM public.profiles AS profile
  WHERE profile.platform_role <> 'admin' AND profile.id NOT IN (v_self, v_guardian, v_coach)
  ORDER BY profile.id LIMIT 1;
  SELECT profile.id INTO v_admin FROM public.profiles AS profile
  WHERE profile.platform_role = 'admin' AND profile.id NOT IN (v_self, v_guardian, v_coach, v_assistant)
  ORDER BY profile.id LIMIT 1;
  SELECT profile.id INTO v_unrelated FROM public.profiles AS profile
  WHERE profile.platform_role <> 'admin' AND profile.id NOT IN (v_self, v_guardian, v_coach, v_assistant)
  ORDER BY profile.id LIMIT 1;
  IF v_self IS NULL OR v_guardian IS NULL OR v_coach IS NULL OR v_assistant IS NULL
     OR v_admin IS NULL OR v_unrelated IS NULL THEN
    RAISE EXCEPTION 'Validation requires self athlete, guardian, coach, assistant, admin, and unrelated profiles';
  END IF;

  SELECT count(*) INTO v_before_results FROM public.workout_results;
  SELECT count(*) INTO v_before_attempts FROM public.workout_session_attempts;
  SELECT count(*) INTO v_before_events FROM public.workout_session_events;

  -- Structural assertions retain compatibility FKs and historical guarantees.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name IN ('workout_results','workout_session_attempts')
      AND column_name='athlete_user_id' AND is_nullable <> 'YES'
  ) THEN RAISE EXCEPTION 'Legacy result or attempt athlete_user_id remains NOT NULL'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workout_results_owner_present')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workout_session_attempts_owner_present') THEN
    RAISE EXCEPTION 'Result or attempt owner-presence constraint missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid IN ('public.workout_results'::regclass, 'public.workout_session_attempts'::regclass)
      AND pg_get_constraintdef(oid) ~ 'athlete_id.*athlete_user_id.*='
  ) THEN RAISE EXCEPTION 'Global durable-to-legacy athlete equality constraint is not permitted'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workout_results_training_session_id_fkey' AND confdeltype='r')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workout_results_athlete_user_id_fkey' AND confdeltype='r')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workout_results_athlete_id_fkey' AND confdeltype='r')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workout_session_attempts_athlete_user_id_fkey' AND confdeltype='r')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workout_session_attempts_athlete_id_fkey' AND confdeltype='r')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workout_session_attempts_training_session_id_fkey' AND confdeltype='r') THEN
    RAISE EXCEPTION 'Historical result or attempt FK protection changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workout_results_training_session_id_key')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workout_session_attempts_workout_result_id_key') THEN
    RAISE EXCEPTION 'Canonical result uniqueness protection changed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.workout_results AS result
    JOIN public.training_sessions AS session ON session.id=result.training_session_id
    WHERE result.athlete_id IS NULL OR result.athlete_id IS DISTINCT FROM session.athlete_id
  ) THEN RAISE EXCEPTION 'Historical result durable ownership changed or disagrees with session'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.workout_results WHERE athlete_user_id IS DISTINCT FROM athlete_id
  ) THEN RAISE EXCEPTION 'Historical self-linked result compatibility identity changed unexpectedly'; END IF;

  INSERT INTO public.teams (id, name, created_by_user_id)
  VALUES (gen_random_uuid(), 'Result attempt ownership validation', v_coach)
  RETURNING id INTO v_team;
  INSERT INTO public.athletes (id, display_name, created_by_profile_id)
  VALUES (gen_random_uuid(), 'Result attempt child', v_guardian)
  RETURNING id INTO v_child;
  INSERT INTO public.athletes (id, display_name, created_by_profile_id)
  VALUES (gen_random_uuid(), 'Result attempt sibling', v_guardian)
  RETURNING id INTO v_sibling;
  INSERT INTO public.athlete_profile_relationships
    (athlete_id, profile_id, role, training_permission, manage_permission, created_by_profile_id)
  VALUES (v_child, v_guardian, 'guardian', true, true, v_guardian),
         (v_sibling, v_guardian, 'guardian', false, true, v_guardian);
  INSERT INTO public.team_staff_memberships (team_id, profile_id, role, created_by_profile_id)
  VALUES (v_team, v_coach, 'coach', v_coach), (v_team, v_assistant, 'assistant_coach', v_coach);

  -- Reuse valid existing immutable workout/plan-item references only for a
  -- session fixture; no result/attempt/event historical row is altered.
  INSERT INTO public.training_sessions
    (id, plan_item_id, athlete_id, athlete_user_id, coach_user_id, team_id, workout_id, scheduled_date, status)
  SELECT gen_random_uuid(), item.id, v_child, NULL, v_coach, v_team, item.workout_id, current_date, 'scheduled'
  FROM public.training_plan_items AS item
  LIMIT 1 RETURNING id INTO v_session;
  INSERT INTO public.training_sessions
    (id, plan_item_id, athlete_id, athlete_user_id, coach_user_id, team_id, workout_id, scheduled_date, status)
  SELECT gen_random_uuid(), item.id, v_sibling, NULL, v_coach, v_team, item.workout_id, current_date, 'scheduled'
  FROM public.training_plan_items AS item
  LIMIT 1 RETURNING id INTO v_other_session;
  INSERT INTO public.training_sessions
    (id, plan_item_id, athlete_id, athlete_user_id, coach_user_id, team_id, workout_id, scheduled_date, status)
  SELECT gen_random_uuid(), item.id, v_self, v_self, v_coach, v_team, item.workout_id, current_date, 'scheduled'
  FROM public.training_plan_items AS item
  LIMIT 1 RETURNING id INTO v_self_session;
  IF v_session IS NULL OR v_other_session IS NULL OR v_self_session IS NULL THEN
    RAISE EXCEPTION 'Validation requires a training plan item';
  END IF;

  -- The internal helper derives the actor. No authenticated execute grant is
  -- required, so evaluate as postgres while setting the same JWT subject.
  PERFORM set_config('request.jwt.claim.sub', v_guardian::text, true);
  IF NOT private.can_act_for_training_session(v_session) THEN RAISE EXCEPTION 'Guardian with training permission was denied session ACT'; END IF;
  IF private.can_act_for_training_session(v_other_session) THEN RAISE EXCEPTION 'Guardian was allowed to ACT for sibling without training permission'; END IF;
  FOREACH v_actor IN ARRAY ARRAY[v_coach, v_assistant, v_admin, v_unrelated] LOOP
    PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
    IF private.can_act_for_training_session(v_session) THEN RAISE EXCEPTION 'Non-guardian actor received session ACT authority'; END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub', v_guardian::text, true);
  IF private.can_act_for_training_session(gen_random_uuid()) THEN RAISE EXCEPTION 'Nonexistent session received ACT authority'; END IF;
  IF has_function_privilege('authenticated', 'private.can_act_for_training_session(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'private.can_act_for_training_session(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Internal session ACT helper is directly executable by a client role';
  END IF;

  -- Nullability alone must not activate child execution. Current result RLS
  -- still requires actor = legacy athlete_user_id, while the current register
  -- RPC still requires a legacy self-athlete session.
  FOREACH v_actor IN ARRAY ARRAY[v_guardian, v_coach, v_assistant, v_admin, v_unrelated] LOOP
    v_failed := false;
    BEGIN
      PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      INSERT INTO public.workout_results (training_session_id, athlete_id, athlete_user_id, started_at, completed_at)
      VALUES (v_session, v_child, NULL, clock_timestamp(), clock_timestamp());
      EXECUTE 'RESET ROLE';
    EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; v_failed := true;
    END;
    IF NOT v_failed THEN RAISE EXCEPTION 'Current result RLS allowed premature child execution'; END IF;
    v_failed := false;
    BEGIN
      PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      PERFORM public.register_my_workout_session_attempt(v_attempt, v_session);
      EXECUTE 'RESET ROLE';
    EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; v_failed := true;
    END;
    IF NOT v_failed THEN RAISE EXCEPTION 'Current registration RPC allowed premature child execution'; END IF;
  END LOOP;

  -- Existing self-athlete completion remains an actual legacy RLS write. The
  -- durable fields are deliberately omitted exactly as the current player does.
  PERFORM set_config('request.jwt.claim.sub', v_self::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO public.workout_results
    (training_session_id, athlete_user_id, started_at, completed_at)
  VALUES (v_self_session, v_self, clock_timestamp(), clock_timestamp())
  RETURNING id INTO v_result;
  EXECUTE 'RESET ROLE';
  IF v_result IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.training_sessions
    WHERE id=v_self_session AND status='completed'
  ) THEN RAISE EXCEPTION 'Current self-athlete result INSERT or completion synchronization failed'; END IF;

  -- Seed a server-side sequence-zero observation, then prove the existing
  -- self-athlete registration RPC remains callable under its legacy contract.
  INSERT INTO public.workout_session_events
    (id, session_id, attempt_id, sequence, event_type, phase, elapsed_ms, occurred_at)
  VALUES (gen_random_uuid(), v_self_session, v_attempt, 0, 'workout_started', 'ready', 0, clock_timestamp());
  PERFORM set_config('request.jwt.claim.sub', v_self::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.register_my_workout_session_attempt(v_attempt, v_self_session);
  EXECUTE 'RESET ROLE';
  IF NOT EXISTS (
    SELECT 1 FROM public.workout_session_attempts
    WHERE id=v_attempt AND training_session_id=v_self_session
      AND athlete_user_id=v_self AND athlete_id IS NULL
  ) THEN RAISE EXCEPTION 'Current self-athlete registration path unavailable'; END IF;
  IF NOT has_function_privilege('authenticated', 'public.finalize_my_workout_session_attempt(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Current finalization RPC unavailable';
  END IF;
  IF has_table_privilege('authenticated', 'public.workout_results', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.workout_results', 'DELETE')
     OR has_table_privilege('authenticated', 'public.workout_session_attempts', 'DELETE') THEN
    RAISE EXCEPTION 'Historical result or attempt immutability changed';
  END IF;
  IF (SELECT count(*) FROM public.workout_results) <> v_before_results + 1
     OR (SELECT count(*) FROM public.workout_session_attempts) <> v_before_attempts + 1
     OR (SELECT count(*) FROM public.workout_session_events) <> v_before_events + 1 THEN
    RAISE EXCEPTION 'Validation fixture count differs; existing completion or telemetry history may have changed';
  END IF;
END;
$validation$;

ROLLBACK;
