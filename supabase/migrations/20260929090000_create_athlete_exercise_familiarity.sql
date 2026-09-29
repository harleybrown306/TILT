BEGIN;

-- This is a deliberately small historical projection.  exercise_id is kept as
-- an immutable semantic UUID without a foreign key: exercises are currently
-- hard-deletable and history must not disappear (or attach to a replacement).
CREATE TABLE public.athlete_exercise_familiarity (
  athlete_id uuid NOT NULL
    REFERENCES public.athletes(id) ON DELETE RESTRICT,
  exercise_id uuid NOT NULL,
  first_completed_at timestamptz NOT NULL,
  PRIMARY KEY (athlete_id, exercise_id)
);

COMMENT ON TABLE public.athlete_exercise_familiarity IS
  'Deletion-safe projection: a durable athlete completed a semantic exercise in a validated finalized attempt.';
COMMENT ON COLUMN public.athlete_exercise_familiarity.exercise_id IS
  'Immutable exercise UUID captured from the session prescription; intentionally no FK so exercise deletion preserves history.';

ALTER TABLE public.athlete_exercise_familiarity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.athlete_exercise_familiarity FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.athlete_exercise_familiarity TO authenticated;

CREATE POLICY athlete_exercise_familiarity_select
ON public.athlete_exercise_familiarity
FOR SELECT TO authenticated
USING (private.can_view_athlete(athlete_id));

-- Materialization runs in the same transaction as the existing finalization
-- update.  The transition below is reached only after that function has
-- validated event structure, canonical result ownership, and the immutable
-- prescription; clients never submit an exercise UUID to this projection.
CREATE FUNCTION private.materialize_athlete_exercise_familiarity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF OLD.finalization_state IS DISTINCT FROM 'finalized_completed'
     AND NEW.finalization_state = 'finalized_completed'
     AND NEW.athlete_id IS NOT NULL
     AND NEW.workout_result_id IS NOT NULL
     AND NEW.finalized_at IS NOT NULL THEN
    INSERT INTO public.athlete_exercise_familiarity (
      athlete_id,
      exercise_id,
      first_completed_at
    )
    SELECT NEW.athlete_id,
           (step.value->>'exercise_id')::uuid,
           NEW.finalized_at
    FROM public.workout_session_events AS event
    JOIN public.training_session_prescriptions AS prescription
      ON prescription.session_id = NEW.training_session_id
    CROSS JOIN LATERAL jsonb_array_elements(prescription.steps) AS step(value)
    WHERE event.session_id = NEW.training_session_id
      AND event.attempt_id = NEW.id
      AND event.event_type = 'exercise_completed'
      AND event.phase = 'work'
      AND step.value->>'workout_exercise_id' = event.workout_exercise_id::text
      AND (step.value->>'position')::integer = event.step_position
      AND (step.value->>'work_ms')::bigint = event.phase_duration_ms
      AND jsonb_typeof(step.value->'exercise_id') = 'string'
      AND step.value->>'exercise_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ON CONFLICT (athlete_id, exercise_id) DO UPDATE
    SET first_completed_at = LEAST(
      public.athlete_exercise_familiarity.first_completed_at,
      EXCLUDED.first_completed_at
    );
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.materialize_athlete_exercise_familiarity()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER workout_session_attempts_materialize_athlete_exercise_familiarity
AFTER UPDATE OF finalization_state ON public.workout_session_attempts
FOR EACH ROW EXECUTE FUNCTION private.materialize_athlete_exercise_familiarity();

-- Backfill only the same durable evidence accepted above.  A historical row
-- with a missing/malformed prescription mapping is intentionally ignored.
INSERT INTO public.athlete_exercise_familiarity (
  athlete_id,
  exercise_id,
  first_completed_at
)
SELECT attempt.athlete_id,
       (step.value->>'exercise_id')::uuid,
       min(attempt.finalized_at) AS first_completed_at
FROM public.workout_session_attempts AS attempt
JOIN public.training_sessions AS session
  ON session.id = attempt.training_session_id
JOIN public.workout_results AS result
  ON result.id = attempt.workout_result_id
 AND result.training_session_id = session.id
 AND result.athlete_id = session.athlete_id
 AND result.athlete_user_id IS NOT DISTINCT FROM session.athlete_user_id
JOIN public.training_session_prescriptions AS prescription
  ON prescription.session_id = session.id
JOIN public.workout_session_events AS event
  ON event.session_id = attempt.training_session_id
 AND event.attempt_id = attempt.id
CROSS JOIN LATERAL jsonb_array_elements(prescription.steps) AS step(value)
WHERE attempt.finalization_state = 'finalized_completed'
  AND attempt.measurement_version = 1
  AND attempt.measurement_quality = 'complete'
  AND attempt.athlete_id IS NOT NULL
  AND attempt.athlete_id = session.athlete_id
  AND attempt.athlete_user_id IS NOT DISTINCT FROM session.athlete_user_id
  AND attempt.finalized_at IS NOT NULL
  AND event.event_type = 'exercise_completed'
  AND event.phase = 'work'
  AND step.value->>'workout_exercise_id' = event.workout_exercise_id::text
  AND (step.value->>'position')::integer = event.step_position
  AND (step.value->>'work_ms')::bigint = event.phase_duration_ms
  AND jsonb_typeof(step.value->'exercise_id') = 'string'
  AND step.value->>'exercise_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
GROUP BY attempt.athlete_id, step.value->>'exercise_id'
ON CONFLICT (athlete_id, exercise_id) DO UPDATE
SET first_completed_at = LEAST(
  public.athlete_exercise_familiarity.first_completed_at,
  EXCLUDED.first_completed_at
);

COMMIT;
