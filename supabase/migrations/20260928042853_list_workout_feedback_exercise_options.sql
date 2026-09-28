BEGIN;

CREATE FUNCTION public.list_my_workout_feedback_exercise_options(
  p_workout_result_id uuid
)
RETURNS TABLE (
  workout_exercise_id uuid,
  exercise_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_result public.workout_results%ROWTYPE;
  v_session public.training_sessions%ROWTYPE;
  v_attempt_count integer;
BEGIN
  IF v_actor IS NULL OR p_workout_result_id IS NULL THEN
    RAISE EXCEPTION 'Workout feedback is unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT result.* INTO v_result
  FROM public.workout_results AS result
  WHERE result.id = p_workout_result_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workout feedback is unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT session.* INTO v_session
  FROM public.training_sessions AS session
  WHERE session.id = v_result.training_session_id;
  IF NOT FOUND
     OR v_session.athlete_id IS NULL
     OR v_session.status IS DISTINCT FROM 'completed'::public.training_session_status
     OR v_result.athlete_id IS DISTINCT FROM v_session.athlete_id
     OR v_result.athlete_user_id IS DISTINCT FROM v_session.athlete_user_id
     OR EXISTS (
       SELECT 1 FROM public.workout_results AS other_result
       WHERE other_result.training_session_id = v_session.id
         AND other_result.id <> v_result.id
     )
     OR NOT private.can_act_for_training_session(v_session.id) THEN
    RAISE EXCEPTION 'Workout feedback is unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_attempt_count
  FROM public.workout_session_attempts AS attempt
  WHERE attempt.workout_result_id = v_result.id
    AND attempt.training_session_id = v_session.id
    AND attempt.athlete_id = v_session.athlete_id
    AND attempt.athlete_user_id IS NOT DISTINCT FROM v_session.athlete_user_id
    AND attempt.finalization_state = 'finalized_completed';
  IF v_attempt_count <> 1 THEN
    RAISE EXCEPTION 'Workout feedback is unavailable' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM public.training_session_prescriptions AS prescription,
            LATERAL jsonb_array_elements(prescription.steps) AS step(value)
       WHERE prescription.session_id = v_session.id
         AND (
           jsonb_typeof(step.value->'workout_exercise_id') IS DISTINCT FROM 'string'
           OR (step.value->>'workout_exercise_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           OR jsonb_typeof(step.value->'position') IS DISTINCT FROM 'number'
           OR (step.value->>'position') !~ '^(0|[1-9][0-9]*)$'
           OR char_length(step.value->>'position') > 10
           OR (
             char_length(step.value->>'position') = 10
             AND step.value->>'position' > '2147483647'
           )
           OR jsonb_typeof(step.value->'exercise_name') IS DISTINCT FROM 'string'
           OR btrim(step.value->>'exercise_name') = ''
         )
     )
     OR EXISTS (
       SELECT 1
       FROM public.training_session_prescriptions AS prescription,
            LATERAL jsonb_array_elements(prescription.steps) AS step(value)
       WHERE prescription.session_id = v_session.id
       GROUP BY step.value->>'workout_exercise_id'
       HAVING count(*) <> 1
     )
     OR EXISTS (
       SELECT 1
       FROM public.training_session_prescriptions AS prescription,
            LATERAL jsonb_array_elements(prescription.steps) AS step(value)
       WHERE prescription.session_id = v_session.id
       GROUP BY step.value->>'position'
       HAVING count(*) <> 1
     ) THEN
    RAISE EXCEPTION 'Workout feedback is unavailable' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    (step.value->>'workout_exercise_id')::uuid,
    step.value->>'exercise_name'
  FROM public.training_session_prescriptions AS prescription,
       LATERAL jsonb_array_elements(prescription.steps) AS step(value)
  WHERE prescription.session_id = v_session.id
    AND EXISTS (
      SELECT 1
      FROM public.workout_session_attempts AS attempt
      JOIN public.workout_session_events AS event
        ON event.session_id = attempt.training_session_id
       AND event.attempt_id = attempt.id
      WHERE attempt.workout_result_id = v_result.id
        AND attempt.training_session_id = v_session.id
        AND attempt.athlete_id = v_session.athlete_id
        AND attempt.athlete_user_id IS NOT DISTINCT FROM v_session.athlete_user_id
        AND attempt.finalization_state = 'finalized_completed'
        AND event.event_type = 'exercise_completed'
        AND event.workout_exercise_id = (step.value->>'workout_exercise_id')::uuid
    )
  ORDER BY (step.value->>'position')::integer;
END;
$function$;

ALTER FUNCTION public.list_my_workout_feedback_exercise_options(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_my_workout_feedback_exercise_options(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_my_workout_feedback_exercise_options(uuid)
  TO authenticated;

COMMENT ON FUNCTION public.list_my_workout_feedback_exercise_options(uuid) IS
  'Returns only immutable snapshot labels for actually completed exercises on one canonical result the current actor may ACT for.';

COMMIT;
