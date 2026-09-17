-- Execute only after repair_workout_session_attempt_ownership_materialization.sql.
-- This privileged, rollback-only validation leaves no fixture or historical change.
BEGIN;

DO $validation$
DECLARE
  v_self uuid;
  v_guardian uuid;
  v_guardian_without_training uuid;
  v_sibling_guardian uuid;
  v_coach uuid;
  v_assistant uuid;
  v_admin uuid;
  v_unrelated uuid;
  v_child uuid;
  v_sibling uuid;
  v_role_team uuid;
  v_session uuid;
  v_step_id uuid;
  v_step_position integer;
  v_work_ms bigint;
  v_attempt uuid := gen_random_uuid();
  v_result uuid;
  v_already boolean;
  v_before_results bigint;
  v_before_attempts bigint;
  v_before_events bigint;
  v_denied boolean := false;
  v_constraint_denied boolean := false;
  v_actor uuid;
BEGIN
  SELECT rel.athlete_id INTO v_self
  FROM public.athlete_profile_relationships AS rel
  WHERE rel.profile_id = rel.athlete_id
    AND rel.role = 'self'
    AND rel.revoked_at IS NULL
    AND rel.training_permission
  ORDER BY rel.created_at
  LIMIT 1;

  SELECT profile.id INTO v_guardian FROM public.profiles AS profile
  WHERE profile.platform_role <> 'admin' AND profile.id IS DISTINCT FROM v_self ORDER BY profile.id LIMIT 1;
  SELECT profile.id INTO v_guardian_without_training FROM public.profiles AS profile
  WHERE profile.platform_role <> 'admin' AND profile.id NOT IN (v_self,v_guardian) ORDER BY profile.id LIMIT 1;
  SELECT profile.id INTO v_sibling_guardian FROM public.profiles AS profile
  WHERE profile.platform_role <> 'admin' AND profile.id NOT IN (v_self,v_guardian,v_guardian_without_training) ORDER BY profile.id LIMIT 1;
  SELECT profile.id INTO v_coach FROM public.profiles AS profile
  WHERE profile.platform_role <> 'admin' AND profile.id NOT IN (v_self,v_guardian,v_guardian_without_training,v_sibling_guardian) ORDER BY profile.id LIMIT 1;
  SELECT profile.id INTO v_assistant FROM public.profiles AS profile
  WHERE profile.platform_role <> 'admin' AND profile.id NOT IN (v_self,v_guardian,v_guardian_without_training,v_sibling_guardian,v_coach) ORDER BY profile.id LIMIT 1;
  SELECT profile.id INTO v_admin FROM public.profiles AS profile
  WHERE profile.platform_role = 'admin' AND profile.id NOT IN (v_self,v_guardian,v_guardian_without_training,v_sibling_guardian,v_coach,v_assistant) ORDER BY profile.id LIMIT 1;
  SELECT profile.id INTO v_unrelated FROM public.profiles AS profile
  WHERE profile.platform_role <> 'admin' AND profile.id NOT IN (v_self,v_guardian,v_guardian_without_training,v_sibling_guardian,v_coach,v_assistant) ORDER BY profile.id LIMIT 1;

  SELECT session.id,
         (prescription.steps->0->>'workout_exercise_id')::uuid,
         (prescription.steps->0->>'position')::integer,
         (prescription.steps->0->>'work_ms')::bigint
    INTO v_session, v_step_id, v_step_position, v_work_ms
  FROM public.training_sessions AS session
  JOIN public.training_session_prescriptions AS prescription
    ON prescription.session_id = session.id
  WHERE session.status = 'scheduled'
    AND session.athlete_id = v_self
    AND session.athlete_user_id = v_self
    AND NOT EXISTS (
      SELECT 1 FROM public.workout_results AS result
      WHERE result.training_session_id = session.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.workout_session_events AS event
      WHERE event.session_id = session.id
    )
    AND jsonb_array_length(prescription.steps) > 0
  ORDER BY session.scheduled_date, session.id
  LIMIT 1;

  IF v_self IS NULL OR v_guardian IS NULL OR v_guardian_without_training IS NULL
     OR v_sibling_guardian IS NULL OR v_coach IS NULL OR v_assistant IS NULL
     OR v_admin IS NULL OR v_unrelated IS NULL OR v_session IS NULL
     OR v_step_id IS NULL OR v_work_ms IS NULL THEN
    RAISE EXCEPTION 'Validation requires self, two guardians, coach, assistant, admin, unrelated profiles, and an unused prescribed self session';
  END IF;

  SELECT count(*) INTO v_before_results FROM public.workout_results;
  SELECT count(*) INTO v_before_attempts FROM public.workout_session_attempts;
  SELECT count(*) INTO v_before_events FROM public.workout_session_events;

  INSERT INTO public.athletes (id, display_name, created_by_profile_id)
  VALUES (gen_random_uuid(), 'Attempt ownership child', v_guardian) RETURNING id INTO v_child;
  INSERT INTO public.athletes (id, display_name, created_by_profile_id)
  VALUES (gen_random_uuid(), 'Attempt ownership sibling', v_sibling_guardian) RETURNING id INTO v_sibling;
  INSERT INTO public.athlete_profile_relationships (athlete_id,profile_id,role,training_permission,manage_permission,created_by_profile_id)
  VALUES (v_child,v_guardian,'guardian',true,true,v_guardian),
         (v_child,v_guardian_without_training,'guardian',false,true,v_guardian_without_training),
         (v_sibling,v_sibling_guardian,'guardian',true,true,v_sibling_guardian);
  INSERT INTO public.teams (id,name,created_by_user_id)
  VALUES (gen_random_uuid(),'Attempt ownership role validation',v_coach) RETURNING id INTO v_role_team;
  INSERT INTO public.team_staff_memberships (team_id,profile_id,role,created_by_profile_id)
  VALUES (v_role_team,v_coach,'coach',v_coach),
         (v_role_team,v_assistant,'assistant_coach',v_coach);

  PERFORM set_config('request.jwt.claim.sub', v_self::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO public.workout_session_events (
    id, session_id, attempt_id, sequence, event_type, phase, elapsed_ms, occurred_at
  ) VALUES (
    gen_random_uuid(), v_session, v_attempt, 0, 'workout_started', 'ready', 0, clock_timestamp()
  );
  INSERT INTO public.workout_session_events (
    id, session_id, attempt_id, sequence, event_type, workout_exercise_id,
    step_position, phase, phase_duration_ms, phase_elapsed_ms, elapsed_ms, occurred_at
  ) VALUES
    (gen_random_uuid(), v_session, v_attempt, 1, 'exercise_started', v_step_id,
     v_step_position, 'work', v_work_ms, 0, 0, clock_timestamp()),
    (gen_random_uuid(), v_session, v_attempt, 2, 'exercise_completed', v_step_id,
     v_step_position, 'work', v_work_ms, v_work_ms, v_work_ms, clock_timestamp());
  PERFORM public.register_my_workout_session_attempt(v_attempt, v_session);
  EXECUTE 'RESET ROLE';

  IF NOT EXISTS (
    SELECT 1
    FROM public.workout_session_attempts AS attempt
    JOIN public.training_sessions AS session ON session.id = attempt.training_session_id
    WHERE attempt.id = v_attempt
      AND attempt.athlete_id = session.athlete_id
      AND attempt.athlete_user_id = session.athlete_user_id
      AND attempt.athlete_id IS NOT NULL
      AND attempt.athlete_user_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Attempt registration did not derive both ownership columns from its session';
  END IF;

  -- The public registration RPC remains self-only. The persisted valid start
  -- proves every denial below is actor authorization, not missing telemetry.
  FOREACH v_actor IN ARRAY ARRAY[v_guardian,v_guardian_without_training,v_sibling_guardian,v_coach,v_assistant,v_admin,v_unrelated] LOOP
    v_denied := false;
    BEGIN
      PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      PERFORM public.register_my_workout_session_attempt(v_attempt, v_session);
    EXCEPTION WHEN others THEN
      v_denied := true;
    END;
    EXECUTE 'RESET ROLE';
    IF NOT v_denied THEN RAISE EXCEPTION 'Guardian registration was allowed before family execution cutover'; END IF;
  END LOOP;

  PERFORM set_config('request.jwt.claim.sub', v_self::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT result_id, already_completed
    INTO v_result, v_already
  FROM public.complete_my_training_session(v_session);
  IF v_result IS NULL OR v_already THEN
    RAISE EXCEPTION 'Canonical self result was unavailable for attempt finalization';
  END IF;
  INSERT INTO public.workout_session_events (
    id, session_id, attempt_id, sequence, event_type, phase, elapsed_ms, occurred_at
  ) VALUES (
    gen_random_uuid(), v_session, v_attempt, 3, 'workout_completed', 'finished', v_work_ms, clock_timestamp()
  );
  PERFORM public.finalize_my_workout_session_attempt(v_attempt);
  EXECUTE 'RESET ROLE';

  IF NOT EXISTS (
    SELECT 1
    FROM public.workout_session_attempts AS attempt
    JOIN public.training_sessions AS session ON session.id = attempt.training_session_id
    WHERE attempt.id = v_attempt
      AND attempt.athlete_id = session.athlete_id
      AND attempt.athlete_user_id = session.athlete_user_id
      AND attempt.workout_result_id = v_result
      AND attempt.finalization_state = 'finalized_completed'
      AND attempt.measurement_version = 1
      AND attempt.measurement_quality = 'complete'
  ) THEN
    RAISE EXCEPTION 'Finalization changed or lost durable attempt ownership';
  END IF;

  -- Simulate the one historic defect. It remains legal only because the legacy
  -- compatibility owner is present; reconciliation must copy from the session.
  UPDATE public.workout_session_attempts
  SET athlete_id = NULL
  WHERE id = v_attempt;
  UPDATE public.workout_session_attempts AS attempt
  SET athlete_id = session.athlete_id,
      athlete_user_id = session.athlete_user_id
  FROM public.training_sessions AS session
  WHERE attempt.id = v_attempt
    AND attempt.training_session_id = session.id
    AND attempt.athlete_id IS NULL
    AND session.athlete_id IS NOT NULL
    AND attempt.athlete_user_id IS NOT DISTINCT FROM session.athlete_user_id
    AND EXISTS (
      SELECT 1
      FROM public.workout_results AS result
      WHERE result.id = attempt.workout_result_id
        AND result.training_session_id IS NOT DISTINCT FROM session.id
        AND result.athlete_id IS NOT DISTINCT FROM session.athlete_id
        AND result.athlete_user_id IS NOT DISTINCT FROM session.athlete_user_id
    );
  IF NOT EXISTS (
    SELECT 1
    FROM public.workout_session_attempts AS attempt
    JOIN public.training_sessions AS session ON session.id = attempt.training_session_id
    WHERE attempt.id = v_attempt AND attempt.athlete_id = session.athlete_id
  ) THEN
    RAISE EXCEPTION 'Reconciliation did not copy the durable owner from the session';
  END IF;

  -- Guard semantics are exercised against isolated candidate rows: no guard
  -- may permit a missing subject, a result from another session, or a durable
  --/compatibility mismatch.
  CREATE TEMP TABLE reconciliation_candidate (
    attempt_athlete_id uuid,
    attempt_athlete_user_id uuid,
    session_id uuid,
    session_athlete_id uuid,
    session_athlete_user_id uuid,
    result_session_id uuid,
    result_athlete_id uuid,
    result_athlete_user_id uuid
  ) ON COMMIT DROP;
  INSERT INTO reconciliation_candidate
  SELECT NULL, session.athlete_user_id, session.id, NULL, session.athlete_user_id,
         result.training_session_id, result.athlete_id, result.athlete_user_id
  FROM public.training_sessions AS session
  JOIN public.workout_results AS result ON result.id = v_result
  WHERE session.id = v_session;
  IF NOT EXISTS (SELECT 1 FROM reconciliation_candidate WHERE session_athlete_id IS NULL) THEN
    RAISE EXCEPTION 'Reconciliation guard test fixture unavailable';
  END IF;
  IF EXISTS (
    SELECT 1 FROM reconciliation_candidate
    WHERE session_athlete_id IS NOT NULL
      AND attempt_athlete_user_id IS NOT DISTINCT FROM session_athlete_user_id
      AND result_session_id IS NOT DISTINCT FROM session_id
      AND result_athlete_id IS NOT DISTINCT FROM session_athlete_id
      AND result_athlete_user_id IS NOT DISTINCT FROM session_athlete_user_id
  ) THEN RAISE EXCEPTION 'Reconciliation guard accepted a missing durable session owner'; END IF;

  UPDATE reconciliation_candidate SET session_athlete_id = v_self;
  UPDATE reconciliation_candidate SET result_athlete_id = gen_random_uuid();
  IF EXISTS (
    SELECT 1 FROM reconciliation_candidate
    WHERE session_athlete_id IS NOT NULL
      AND result_session_id IS NOT DISTINCT FROM session_id
      AND result_athlete_id IS NOT DISTINCT FROM session_athlete_id
  ) THEN RAISE EXCEPTION 'Reconciliation guard accepted a mismatched linked result'; END IF;

  UPDATE reconciliation_candidate SET result_athlete_id = v_self, result_session_id = gen_random_uuid();
  IF EXISTS (
    SELECT 1 FROM reconciliation_candidate
    WHERE result_session_id IS NOT DISTINCT FROM session_id
  ) THEN RAISE EXCEPTION 'Reconciliation guard accepted a result from another session'; END IF;

  v_constraint_denied := false;
  BEGIN
    UPDATE public.workout_session_attempts
    SET athlete_id = NULL, athlete_user_id = NULL
    WHERE id = v_attempt;
  EXCEPTION WHEN check_violation THEN
    v_constraint_denied := true;
  END;
  IF NOT v_constraint_denied THEN
    RAISE EXCEPTION 'Owner-presence constraint did not reject both owners as NULL';
  END IF;

  IF has_table_privilege('authenticated','public.workout_results','UPDATE')
     OR has_table_privilege('authenticated','public.workout_results','DELETE')
     OR has_table_privilege('authenticated','public.workout_results','TRUNCATE')
     OR NOT has_table_privilege('authenticated','public.workout_results','INSERT') THEN
    RAISE EXCEPTION 'Canonical result protections changed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.workout_session_attempts'::regclass
      AND conname IN ('workout_session_attempts_training_session_id_fkey','workout_session_attempts_athlete_id_fkey')
      AND confdeltype='r'
  ) THEN RAISE EXCEPTION 'Attempt RESTRICT foreign-key protection changed'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger AS trigger
    JOIN pg_proc AS function ON function.oid=trigger.tgfoid
    JOIN pg_namespace AS namespace ON namespace.oid=function.pronamespace
    WHERE trigger.tgrelid='public.workout_session_events'::regclass
      AND NOT trigger.tgisinternal
      AND namespace.nspname='private'
      AND function.proname='reject_late_workout_session_event'
  ) THEN RAISE EXCEPTION 'Event append-only late-event protection changed'; END IF;

  IF (SELECT count(*) FROM public.workout_results) <> v_before_results + 1
     OR (SELECT count(*) FROM public.workout_session_attempts) <> v_before_attempts + 1
     OR (SELECT count(*) FROM public.workout_session_events) <> v_before_events + 4 THEN
    RAISE EXCEPTION 'Validation fixture count differs; historical execution rows may have changed';
  END IF;
END;
$validation$;

ROLLBACK;
