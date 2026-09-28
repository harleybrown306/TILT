BEGIN;

CREATE FUNCTION public.list_my_team_athlete_workout_feedback(
  p_team_id uuid,
  p_athlete_id uuid
)
RETURNS TABLE (
  scheduled_date date,
  workout_name text,
  q1_response_state text,
  selected_exercise_label text,
  coach_note text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
BEGIN
  IF v_actor IS NULL
     OR p_team_id IS NULL
     OR p_athlete_id IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM public.team_staff_memberships AS staff
       JOIN public.team_athlete_memberships AS roster
         ON roster.team_id = staff.team_id
       WHERE staff.team_id = p_team_id
         AND staff.profile_id = v_actor
         AND roster.athlete_id = p_athlete_id
     ) THEN
    RAISE EXCEPTION 'Athlete feedback is not available' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    session.scheduled_date,
    workout.name,
    feedback.q1_response_state,
    CASE WHEN feedback.selected_workout_exercise_id IS NULL THEN NULL ELSE (
      SELECT step.value->>'exercise_name'
      FROM public.training_session_prescriptions AS prescription,
           LATERAL jsonb_array_elements(prescription.steps) AS step(value)
      WHERE prescription.session_id = session.id
        AND step.value->>'workout_exercise_id' = feedback.selected_workout_exercise_id::text
    ) END,
    feedback.coach_note
  FROM public.workout_result_feedback AS feedback
  JOIN public.workout_results AS result
    ON result.id = feedback.workout_result_id
  JOIN public.training_sessions AS session
    ON session.id = result.training_session_id
  LEFT JOIN public.workouts AS workout
    ON workout.id = session.workout_id
  WHERE session.team_id = p_team_id
    AND session.athlete_id = p_athlete_id
    AND result.athlete_id = p_athlete_id
    AND result.athlete_user_id IS NOT DISTINCT FROM session.athlete_user_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.workout_results AS other_result
      WHERE other_result.training_session_id = session.id
        AND other_result.id <> result.id
    )
  ORDER BY session.scheduled_date DESC, feedback.created_at DESC;
END;
$function$;

ALTER FUNCTION public.list_my_team_athlete_workout_feedback(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_my_team_athlete_workout_feedback(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_my_team_athlete_workout_feedback(uuid, uuid)
  TO authenticated;

COMMENT ON FUNCTION public.list_my_team_athlete_workout_feedback(uuid, uuid) IS
  'Current-team staff-only athlete-detail feedback projection. It requires the caller staff membership, current athlete roster containment, and feedback result/session ownership to converge on the requested team and durable athlete; platform-admin status alone does not qualify.';

COMMIT;
