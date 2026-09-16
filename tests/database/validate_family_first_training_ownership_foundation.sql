-- Execute only after create_family_first_training_ownership_foundation.sql is applied.
-- Read-only assertions run inside a rollback-only transaction.
BEGIN;

DO $validation$
DECLARE
  v_assignments_before bigint; v_sessions_before bigint; v_results_before bigint; v_attempts_before bigint;
  v_assignments_after bigint; v_sessions_after bigint; v_results_after bigint; v_attempts_after bigint;
  v_child uuid;
BEGIN
  SELECT count(*) INTO v_assignments_before FROM public.training_plan_assignments;
  SELECT count(*) INTO v_sessions_before FROM public.training_sessions;
  SELECT count(*) INTO v_results_before FROM public.workout_results;
  SELECT count(*) INTO v_attempts_before FROM public.workout_session_attempts;

  IF EXISTS (SELECT 1 FROM public.training_plan_assignments a LEFT JOIN public.athletes athlete ON athlete.id=a.athlete_user_id WHERE athlete.id IS NULL)
     OR EXISTS (SELECT 1 FROM public.training_sessions s LEFT JOIN public.athletes athlete ON athlete.id=s.athlete_user_id WHERE athlete.id IS NULL)
     OR EXISTS (SELECT 1 FROM public.workout_results r LEFT JOIN public.athletes athlete ON athlete.id=r.athlete_user_id WHERE athlete.id IS NULL)
     OR EXISTS (SELECT 1 FROM public.workout_session_attempts a LEFT JOIN public.athletes athlete ON athlete.id=a.athlete_user_id WHERE athlete.id IS NULL) THEN
    RAISE EXCEPTION 'A legacy athlete owner has no matching athlete';
  END IF;
  IF EXISTS (SELECT 1 FROM public.training_plan_assignments WHERE athlete_id IS NULL OR athlete_id<>athlete_user_id)
     OR EXISTS (SELECT 1 FROM public.training_sessions WHERE athlete_id IS NULL OR athlete_id<>athlete_user_id)
     OR EXISTS (SELECT 1 FROM public.workout_results WHERE athlete_id IS NULL OR athlete_id<>athlete_user_id)
     OR EXISTS (SELECT 1 FROM public.workout_session_attempts WHERE athlete_id IS NULL OR athlete_id<>athlete_user_id) THEN
    RAISE EXCEPTION 'Training ownership UUID parity failed';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='training_plan_assignments_athlete_id_fkey' AND confdeltype='r')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='training_sessions_athlete_id_fkey' AND confdeltype='r')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workout_results_athlete_id_fkey' AND confdeltype='r')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workout_session_attempts_athlete_id_fkey' AND confdeltype='r') THEN
    RAISE EXCEPTION 'New durable athlete FK is missing or does not RESTRICT deletion';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='training_sessions_athlete_user_id_fkey' AND confdeltype='r')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workout_results_athlete_user_id_fkey' AND confdeltype='r')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workout_results_training_session_id_fkey' AND confdeltype='r') THEN
    RAISE EXCEPTION 'Historical legacy FK protection changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid IN ('public.training_plan_assignments'::regclass,'public.training_sessions'::regclass,'public.workout_results'::regclass,'public.workout_session_attempts'::regclass) AND confdeltype='c' AND conname LIKE '%athlete_id_fkey') THEN
    RAISE EXCEPTION 'Historical athlete ownership cascades are not permitted';
  END IF;

  INSERT INTO public.athletes(id,display_name) VALUES (gen_random_uuid(),'Ownership validation child') RETURNING id INTO v_child;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id=v_child) THEN RAISE EXCEPTION 'Parent-managed athlete fixture unexpectedly has a profile'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.training_sessions'::regclass AND conname='training_sessions_athlete_id_fkey' AND confrelid='public.athletes'::regclass) THEN
    RAISE EXCEPTION 'Parent-managed athlete is not structurally referenceable by durable session ownership';
  END IF;
  -- The legacy athlete_user_id remains non-null in this phase, so this does not
  -- create a training row for the child. A later coordinated writer/RLS cutover
  -- is required before no-login athletes can receive training records.

  SELECT count(*) INTO v_assignments_after FROM public.training_plan_assignments;
  SELECT count(*) INTO v_sessions_after FROM public.training_sessions;
  SELECT count(*) INTO v_results_after FROM public.workout_results;
  SELECT count(*) INTO v_attempts_after FROM public.workout_session_attempts;
  IF (v_assignments_before,v_sessions_before,v_results_before,v_attempts_before)
     IS DISTINCT FROM (v_assignments_after,v_sessions_after,v_results_after,v_attempts_after) THEN
    RAISE EXCEPTION 'Validation changed historical training row counts';
  END IF;
END;
$validation$;

ROLLBACK;
