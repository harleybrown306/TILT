BEGIN;

-- Phase 18B follow-on: Attention describes completed work, so its duration
-- and Measurement V1 denominator must come from the immutable prescription
-- actually performed. The original Assigned snapshot remains untouched.
CREATE OR REPLACE FUNCTION public.list_my_team_attention_sessions(
  p_team_id uuid
)
RETURNS TABLE (
  as_of_date date,
  session_id uuid,
  athlete_id uuid,
  scheduled_date date,
  is_cancelled boolean,
  has_canonical_completion boolean,
  prescribed_work_ms bigint,
  adherence_completed_work_blocks integer,
  adherence_prescribed_work_blocks integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_as_of_date date := (transaction_timestamp() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  IF v_actor IS NULL
     OR p_team_id IS NULL
     OR NOT private.can_view_team_analytics(p_team_id) THEN
    RAISE EXCEPTION 'Team attention data is not available' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    v_as_of_date,
    session.id,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.team_athlete_memberships AS current_roster
      WHERE current_roster.team_id = p_team_id
        AND current_roster.athlete_id = session.athlete_id
    ) THEN session.athlete_id ELSE NULL END,
    session.scheduled_date,
    session.status = 'cancelled'::public.training_session_status,
    canonical_result.is_valid,
    CASE
      WHEN canonical_result.is_valid
       AND prescription.selected_variant IS NOT NULL
       AND prescription.schema_version = 1
       AND prescription.prescribed_work_ms >= 0
      THEN prescription.prescribed_work_ms
      ELSE NULL
    END,
    CASE
      WHEN canonical_result.is_valid
       AND prescription.selected_variant IS NOT NULL
       AND prescription.schema_version = 1
       AND prescription.step_count > 0
       AND linked_attempt.id IS NOT NULL
       AND linked_attempt.training_session_id = session.id
       AND linked_attempt.athlete_id = session.athlete_id
       AND linked_attempt.finalization_state = 'finalized_completed'
       AND linked_attempt.measurement_version = 1
       AND linked_attempt.measurement_quality = 'complete'
       AND linked_attempt.prescribed_step_count = prescription.step_count
       AND linked_attempt.completed_work_blocks >= 0
       AND linked_attempt.skipped_work_blocks >= 0
       AND linked_attempt.completed_work_blocks + linked_attempt.skipped_work_blocks = prescription.step_count
      THEN linked_attempt.completed_work_blocks
      ELSE NULL
    END,
    CASE
      WHEN canonical_result.is_valid
       AND prescription.selected_variant IS NOT NULL
       AND prescription.schema_version = 1
       AND prescription.step_count > 0
       AND linked_attempt.id IS NOT NULL
       AND linked_attempt.training_session_id = session.id
       AND linked_attempt.athlete_id = session.athlete_id
       AND linked_attempt.finalization_state = 'finalized_completed'
       AND linked_attempt.measurement_version = 1
       AND linked_attempt.measurement_quality = 'complete'
       AND linked_attempt.prescribed_step_count = prescription.step_count
       AND linked_attempt.completed_work_blocks >= 0
       AND linked_attempt.skipped_work_blocks >= 0
       AND linked_attempt.completed_work_blocks + linked_attempt.skipped_work_blocks = prescription.step_count
      THEN prescription.step_count
      ELSE NULL
    END
  FROM public.training_sessions AS session
  LEFT JOIN LATERAL private.resolve_training_session_performed_prescription(session.id) AS prescription
    ON true
  LEFT JOIN LATERAL (
    SELECT EXISTS (
      SELECT 1
      FROM public.workout_results AS result
      WHERE result.training_session_id = session.id
        AND result.athlete_id = session.athlete_id
        AND NOT EXISTS (
          SELECT 1
          FROM public.workout_results AS other_result
          WHERE other_result.training_session_id = session.id
            AND other_result.id <> result.id
        )
    ) AS is_valid
  ) AS canonical_result ON true
  LEFT JOIN LATERAL (
    SELECT attempt.*
    FROM public.workout_session_attempts AS attempt
    WHERE canonical_result.is_valid
      AND attempt.training_session_id = session.id
      AND EXISTS (
        SELECT 1
        FROM public.workout_results AS result
        WHERE result.id = attempt.workout_result_id
          AND result.training_session_id = session.id
          AND result.athlete_id = session.athlete_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.workout_session_attempts AS other_attempt
        WHERE other_attempt.workout_result_id = attempt.workout_result_id
          AND other_attempt.id <> attempt.id
      )
  ) AS linked_attempt ON true
  WHERE session.team_id = p_team_id
    AND session.athlete_id IS NOT NULL
    AND session.scheduled_date >= v_as_of_date - 29
    AND session.scheduled_date < v_as_of_date + 1
  ORDER BY session.scheduled_date, session.id;
END;
$function$;

ALTER FUNCTION public.list_my_team_attention_sessions(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_my_team_attention_sessions(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_my_team_attention_sessions(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.list_my_team_attention_sessions(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.list_my_team_attention_sessions(uuid) TO authenticated;

COMMENT ON FUNCTION public.list_my_team_attention_sessions(uuid) IS
  'Bounded current-team analytics projection. It authorizes analytics VIEW, exposes no raw attempts or telemetry, and returns only qualified Measurement V1 block aggregates from the immutable performed prescription.';

COMMIT;
