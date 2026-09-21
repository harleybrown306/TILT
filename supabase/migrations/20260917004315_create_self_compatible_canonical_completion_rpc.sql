BEGIN;

-- Phase 11B.6C.2A supplies the canonical completion writer without enabling
-- family execution. The temporary legacy-self gate is intentional and must be
-- removed only with the later player, attempt, telemetry, and recovery cutover.
CREATE OR REPLACE FUNCTION public.complete_my_training_session(p_session_id uuid)
RETURNS TABLE (result_id uuid, already_completed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_session public.training_sessions;
  v_prescription public.training_session_prescriptions;
  v_result public.workout_results;
BEGIN
  IF v_actor IS NULL OR p_session_id IS NULL THEN
    RAISE EXCEPTION 'Authentication and session are required';
  END IF;

  SELECT * INTO v_session
  FROM public.training_sessions AS session
  WHERE session.id = p_session_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Training session unavailable'; END IF;
  IF v_session.athlete_id IS NULL THEN RAISE EXCEPTION 'Training session has no durable athlete owner'; END IF;

  IF NOT private.can_act_for_training_session(p_session_id) THEN
    RAISE EXCEPTION 'Training action unavailable';
  END IF;

  -- Transitional gate: production completion remains the exact current
  -- self-athlete capability even though durable ownership is already derived.
  IF v_session.athlete_user_id IS NULL OR v_session.athlete_user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Family training completion is not enabled yet';
  END IF;

  SELECT * INTO v_prescription
  FROM public.training_session_prescriptions AS prescription
  WHERE prescription.session_id = v_session.id;
  IF NOT FOUND OR v_prescription.workout_id IS DISTINCT FROM v_session.workout_id THEN
    RAISE EXCEPTION 'Training prescription unavailable or inconsistent';
  END IF;

  SELECT * INTO v_result
  FROM public.workout_results AS result
  WHERE result.training_session_id = v_session.id;
  IF FOUND THEN
    IF v_result.athlete_id IS DISTINCT FROM v_session.athlete_id
       OR v_result.athlete_user_id IS DISTINCT FROM v_session.athlete_user_id
       OR v_session.status IS DISTINCT FROM 'completed'::public.training_session_status THEN
      RAISE EXCEPTION 'Canonical result and session are inconsistent';
    END IF;
    RETURN QUERY SELECT v_result.id, true;
    RETURN;
  END IF;

  -- Compatibility values describe the immutable prescription. They are not
  -- measured active or elapsed training time; Measurement V1 remains separate.
  INSERT INTO public.workout_results (
    training_session_id,
    athlete_id,
    athlete_user_id,
    completed_at,
    active_minutes,
    total_duration_minutes,
    exercises_completed,
    result_data
  ) VALUES (
    v_session.id,
    v_session.athlete_id,
    v_session.athlete_user_id,
    clock_timestamp(),
    ceil(v_prescription.prescribed_work_ms / 60000.0)::integer,
    ceil(v_prescription.prescribed_total_ms / 60000.0)::integer,
    v_prescription.step_count,
    jsonb_build_object(
      'workout_name', v_prescription.workout_name,
      'completed_steps', v_prescription.step_count
    )
  ) RETURNING id INTO v_result.id;

  -- The existing AFTER INSERT trigger remains the sole session-state writer.
  IF NOT EXISTS (
    SELECT 1 FROM public.training_sessions AS session
    WHERE session.id = v_session.id
      AND session.status = 'completed'::public.training_session_status
  ) THEN RAISE EXCEPTION 'Canonical result synchronization failed'; END IF;

  RETURN QUERY SELECT v_result.id, false;
EXCEPTION WHEN unique_violation THEN
  -- A concurrent legacy direct INSERT can win before 6C.2C retires that path.
  -- Only a fully consistent canonical row is a safe idempotent acknowledgement.
  SELECT * INTO v_result
  FROM public.workout_results AS result
  WHERE result.training_session_id = p_session_id;
  IF FOUND
     AND v_result.athlete_id IS NOT DISTINCT FROM v_session.athlete_id
     AND v_result.athlete_user_id IS NOT DISTINCT FROM v_session.athlete_user_id
     AND EXISTS (SELECT 1 FROM public.training_sessions AS session WHERE session.id=p_session_id AND session.status='completed'::public.training_session_status) THEN
    RETURN QUERY SELECT v_result.id, true;
    RETURN;
  END IF;
  RAISE EXCEPTION 'Canonical result and session are inconsistent';
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_my_training_session(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_my_training_session(uuid)
  TO authenticated;

COMMENT ON FUNCTION public.complete_my_training_session(uuid) IS
  'Canonical self-compatible workout completion. Ownership and prescription compatibility fields derive from the locked session; the temporary legacy-self gate blocks family execution until the complete execution pipeline is ready.';

COMMIT;
