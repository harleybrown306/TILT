BEGIN;

CREATE TABLE public.workout_result_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workout_result_id uuid NOT NULL UNIQUE
    REFERENCES public.workout_results(id) ON DELETE RESTRICT,
  submitted_by_profile_id uuid
    REFERENCES public.profiles(id) ON DELETE SET NULL,
  q1_response_state text NOT NULL,
  selected_workout_exercise_id uuid,
  coach_note text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workout_result_feedback_q1_response_check CHECK (
    (q1_response_state = 'selected' AND selected_workout_exercise_id IS NOT NULL)
    OR (q1_response_state IN ('none', 'skipped') AND selected_workout_exercise_id IS NULL)
  ),
  CONSTRAINT workout_result_feedback_coach_note_canonical_check CHECK (
    coach_note IS NULL OR (
      coach_note = regexp_replace(coach_note, '^[[:space:]]+|[[:space:]]+$', '', 'g')
      AND coach_note <> ''
      AND char_length(coach_note) <= 500
    )
  )
);

ALTER TABLE public.workout_result_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workout_result_feedback FROM PUBLIC, anon, authenticated;

CREATE FUNCTION private.can_view_athlete_workout_feedback(
  p_athlete_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT (SELECT auth.uid()) IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.athlete_profile_relationships AS relationship
      WHERE relationship.athlete_id = p_athlete_id
        AND relationship.profile_id = (SELECT auth.uid())
        AND relationship.role IN ('self', 'guardian')
        AND relationship.revoked_at IS NULL
    );
$function$;

CREATE FUNCTION public.submit_my_workout_feedback(
  p_workout_result_id uuid,
  p_q1_response_state text,
  p_selected_workout_exercise_id uuid DEFAULT NULL,
  p_coach_note text DEFAULT NULL
)
RETURNS TABLE (
  feedback_id uuid,
  workout_result_id uuid,
  q1_response_state text,
  selected_workout_exercise_id uuid,
  selected_exercise_label text,
  coach_note text,
  created_at timestamptz,
  already_submitted boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_note text := NULLIF(regexp_replace(p_coach_note, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  v_result public.workout_results%ROWTYPE;
  v_session public.training_sessions%ROWTYPE;
  v_feedback public.workout_result_feedback%ROWTYPE;
  v_attempt_count integer;
  v_label text;
BEGIN
  IF v_actor IS NULL OR p_workout_result_id IS NULL THEN
    RAISE EXCEPTION 'Workout feedback is unavailable' USING ERRCODE = '42501';
  END IF;

  IF p_q1_response_state IS NULL
     OR p_q1_response_state NOT IN ('selected', 'none', 'skipped')
     OR (p_q1_response_state = 'selected' AND p_selected_workout_exercise_id IS NULL)
     OR (p_q1_response_state IN ('none', 'skipped') AND p_selected_workout_exercise_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Workout feedback response is invalid';
  END IF;

  IF v_note IS NOT NULL AND char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'Workout feedback note is too long';
  END IF;

  SELECT result.* INTO v_result
  FROM public.workout_results AS result
  WHERE result.id = p_workout_result_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workout feedback is unavailable';
  END IF;

  SELECT session.* INTO v_session
  FROM public.training_sessions AS session
  WHERE session.id = v_result.training_session_id
  FOR KEY SHARE;
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

  IF p_q1_response_state = 'selected' THEN
    SELECT count(*) INTO v_attempt_count
    FROM public.workout_session_attempts AS attempt
    WHERE attempt.workout_result_id = v_result.id
      AND attempt.training_session_id = v_session.id
      AND attempt.athlete_id = v_session.athlete_id
      AND attempt.athlete_user_id IS NOT DISTINCT FROM v_session.athlete_user_id
      AND attempt.finalization_state = 'finalized_completed';

    IF v_attempt_count <> 1
       OR NOT EXISTS (
         SELECT 1
         FROM public.training_session_prescriptions AS prescription,
              LATERAL jsonb_array_elements(prescription.steps) AS step(value)
         WHERE prescription.session_id = v_session.id
           AND step.value->>'workout_exercise_id' = p_selected_workout_exercise_id::text
       )
       OR NOT EXISTS (
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
           AND event.workout_exercise_id = p_selected_workout_exercise_id
       ) THEN
      RAISE EXCEPTION 'Selected exercise is unavailable';
    END IF;

    SELECT step.value->>'exercise_name' INTO v_label
    FROM public.training_session_prescriptions AS prescription,
         LATERAL jsonb_array_elements(prescription.steps) AS step(value)
    WHERE prescription.session_id = v_session.id
      AND step.value->>'workout_exercise_id' = p_selected_workout_exercise_id::text;
  END IF;

  INSERT INTO public.workout_result_feedback (
    workout_result_id,
    submitted_by_profile_id,
    q1_response_state,
    selected_workout_exercise_id,
    coach_note
  ) VALUES (
    v_result.id,
    v_actor,
    p_q1_response_state,
    p_selected_workout_exercise_id,
    v_note
  )
  ON CONFLICT ON CONSTRAINT workout_result_feedback_workout_result_id_key DO NOTHING
  RETURNING * INTO v_feedback;

  IF FOUND THEN
    RETURN QUERY SELECT
      v_feedback.id,
      v_feedback.workout_result_id,
      v_feedback.q1_response_state,
      v_feedback.selected_workout_exercise_id,
      v_label,
      v_feedback.coach_note,
      v_feedback.created_at,
      false;
    RETURN;
  END IF;

  SELECT feedback.* INTO v_feedback
  FROM public.workout_result_feedback AS feedback
  WHERE feedback.workout_result_id = v_result.id;
  IF NOT FOUND
     OR v_feedback.submitted_by_profile_id IS DISTINCT FROM v_actor
     OR v_feedback.q1_response_state IS DISTINCT FROM p_q1_response_state
     OR v_feedback.selected_workout_exercise_id IS DISTINCT FROM p_selected_workout_exercise_id
     OR v_feedback.coach_note IS DISTINCT FROM v_note THEN
    RAISE EXCEPTION 'Workout feedback has already been submitted' USING ERRCODE = '23505';
  END IF;

  IF v_feedback.selected_workout_exercise_id IS NOT NULL THEN
    SELECT step.value->>'exercise_name' INTO v_label
    FROM public.training_session_prescriptions AS prescription,
         LATERAL jsonb_array_elements(prescription.steps) AS step(value)
    WHERE prescription.session_id = v_session.id
      AND step.value->>'workout_exercise_id' = v_feedback.selected_workout_exercise_id::text;
  END IF;

  RETURN QUERY SELECT
    v_feedback.id,
    v_feedback.workout_result_id,
    v_feedback.q1_response_state,
    v_feedback.selected_workout_exercise_id,
    v_label,
    v_feedback.coach_note,
    v_feedback.created_at,
    true;
END;
$function$;

CREATE FUNCTION public.get_my_workout_feedback(
  p_workout_result_id uuid
)
RETURNS TABLE (
  feedback_id uuid,
  workout_result_id uuid,
  q1_response_state text,
  selected_workout_exercise_id uuid,
  selected_exercise_label text,
  coach_note text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_result public.workout_results%ROWTYPE;
  v_session public.training_sessions%ROWTYPE;
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
     OR v_result.athlete_id IS DISTINCT FROM v_session.athlete_id
     OR v_result.athlete_user_id IS DISTINCT FROM v_session.athlete_user_id
     OR EXISTS (
       SELECT 1 FROM public.workout_results AS other_result
       WHERE other_result.training_session_id = v_session.id
         AND other_result.id <> v_result.id
     )
     OR NOT private.can_view_athlete_workout_feedback(v_session.athlete_id) THEN
    RAISE EXCEPTION 'Workout feedback is unavailable' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    feedback.id,
    feedback.workout_result_id,
    feedback.q1_response_state,
    feedback.selected_workout_exercise_id,
    CASE WHEN feedback.selected_workout_exercise_id IS NULL THEN NULL ELSE (
      SELECT step.value->>'exercise_name'
      FROM public.training_session_prescriptions AS prescription,
           LATERAL jsonb_array_elements(prescription.steps) AS step(value)
      WHERE prescription.session_id = v_session.id
        AND step.value->>'workout_exercise_id' = feedback.selected_workout_exercise_id::text
    ) END,
    feedback.coach_note,
    feedback.created_at
  FROM public.workout_result_feedback AS feedback
  WHERE feedback.workout_result_id = v_result.id;
END;
$function$;

ALTER FUNCTION private.can_view_athlete_workout_feedback(uuid) OWNER TO postgres;
ALTER FUNCTION public.submit_my_workout_feedback(uuid, text, uuid, text) OWNER TO postgres;
ALTER FUNCTION public.get_my_workout_feedback(uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION private.can_view_athlete_workout_feedback(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_my_workout_feedback(uuid, text, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_my_workout_feedback(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_my_workout_feedback(uuid, text, uuid, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_workout_feedback(uuid)
  TO authenticated;

COMMENT ON TABLE public.workout_result_feedback IS
  'Immutable optional athlete feedback attached to one canonical completed workout result. Free text is intentionally not exposed through analytics or raw execution records.';
COMMENT ON FUNCTION public.submit_my_workout_feedback(uuid, text, uuid, text) IS
  'Creates or idempotently returns immutable feedback for the canonical result of a session the current actor may ACT for.';
COMMENT ON FUNCTION public.get_my_workout_feedback(uuid) IS
  'Returns result-scoped feedback only to active self or guardian relationships; it intentionally excludes staff and platform-admin access.';

COMMIT;
