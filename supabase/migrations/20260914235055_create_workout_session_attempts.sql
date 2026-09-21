BEGIN;

CREATE TABLE public.workout_session_attempts (
  id uuid PRIMARY KEY,
  training_session_id uuid NOT NULL REFERENCES public.training_sessions(id) ON DELETE RESTRICT,
  athlete_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  workout_result_id uuid UNIQUE REFERENCES public.workout_results(id) ON DELETE RESTRICT,
  started_at timestamptz NOT NULL,
  finalized_at timestamptz,
  finalization_state text NOT NULL DEFAULT 'open' CHECK (finalization_state IN ('open','finalized_completed','finalized_incomplete')),
  prescription_schema_version smallint NOT NULL,
  prescribed_work_ms bigint NOT NULL CHECK (prescribed_work_ms >= 0),
  prescribed_rest_ms bigint NOT NULL CHECK (prescribed_rest_ms >= 0),
  prescribed_total_ms bigint NOT NULL CHECK (prescribed_total_ms = prescribed_work_ms + prescribed_rest_ms),
  prescribed_step_count integer NOT NULL CHECK (prescribed_step_count > 0),
  first_sequence integer, last_sequence integer, event_count integer NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  elapsed_attempt_ms bigint, explicit_pause_ms bigint, work_timer_progressed_ms bigint, rest_timer_progressed_ms bigint, hidden_ms bigint,
  completed_work_blocks integer NOT NULL DEFAULT 0, skipped_work_blocks integer NOT NULL DEFAULT 0,
  completed_rest_blocks integer NOT NULL DEFAULT 0, skipped_rest_blocks integer NOT NULL DEFAULT 0,
  measurement_version smallint NOT NULL DEFAULT 1,
  measurement_quality text NOT NULL DEFAULT 'unknown' CHECK (measurement_quality IN ('partial','complete','reconstructed','unknown')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((finalization_state = 'open') = (finalized_at IS NULL))
);
CREATE INDEX workout_session_attempts_session_idx ON public.workout_session_attempts(training_session_id);
CREATE INDEX workout_session_attempts_athlete_idx ON public.workout_session_attempts(athlete_user_id);

ALTER TABLE public.workout_session_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workout_session_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.workout_session_attempts TO authenticated;
CREATE POLICY workout_session_attempts_select ON public.workout_session_attempts FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.training_sessions ts WHERE ts.id = workout_session_attempts.training_session_id));

-- Replace mutable workout_exercises validation in the existing event INSERT policy with immutable prescription steps.
DROP POLICY workout_session_events_insert ON public.workout_session_events;
CREATE POLICY workout_session_events_insert ON public.workout_session_events FOR INSERT TO authenticated WITH CHECK (
  EXISTS (SELECT 1 FROM public.training_sessions ts WHERE ts.id = workout_session_events.session_id AND ts.athlete_user_id = (SELECT auth.uid()))
  AND (workout_session_events.workout_exercise_id IS NULL OR EXISTS (
    SELECT 1 FROM public.training_session_prescriptions tsp, jsonb_array_elements(tsp.steps) step
    WHERE tsp.session_id = workout_session_events.session_id
      AND step->>'workout_exercise_id' = workout_session_events.workout_exercise_id::text
      AND (step->>'position')::integer = workout_session_events.step_position
      AND (workout_session_events.phase = 'work' AND (step->>'work_ms')::bigint = workout_session_events.phase_duration_ms
        OR workout_session_events.phase = 'rest' AND (step->>'rest_ms')::bigint = workout_session_events.phase_duration_ms)
  ))
  AND (event_type <> 'workout_completed' OR EXISTS (SELECT 1 FROM public.workout_results wr WHERE wr.training_session_id = workout_session_events.session_id AND wr.athlete_user_id = (SELECT auth.uid())))
);

-- Called only by controlled server integration after accepting workout_started. It binds one client UUID to one athlete/session and copies immutable prescription aggregates.
CREATE FUNCTION private.register_workout_session_attempt(p_attempt_id uuid, p_session_id uuid, p_started_at timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE existing public.workout_session_attempts; session_row public.training_sessions; prescription public.training_session_prescriptions;
BEGIN
 SELECT * INTO session_row FROM public.training_sessions WHERE id=p_session_id AND athlete_user_id=(SELECT auth.uid());
 IF NOT FOUND THEN RAISE EXCEPTION 'Attempt session unavailable'; END IF;
 SELECT * INTO existing FROM public.workout_session_attempts WHERE id=p_attempt_id;
 IF FOUND THEN
   IF existing.training_session_id<>p_session_id OR existing.athlete_user_id<>(SELECT auth.uid()) THEN RAISE EXCEPTION 'Attempt identity conflict'; END IF;
   RETURN p_attempt_id;
 END IF;
 SELECT * INTO prescription FROM public.training_session_prescriptions WHERE session_id=p_session_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Attempt prescription unavailable'; END IF;
 INSERT INTO public.workout_session_attempts(id,training_session_id,athlete_user_id,started_at,prescription_schema_version,prescribed_work_ms,prescribed_rest_ms,prescribed_total_ms,prescribed_step_count)
 VALUES(p_attempt_id,p_session_id,(SELECT auth.uid()),p_started_at,prescription.schema_version,prescription.prescribed_work_ms,prescription.prescribed_rest_ms,prescription.prescribed_total_ms,prescription.step_count);
 RETURN p_attempt_id;
END $$;
REVOKE ALL ON FUNCTION private.register_workout_session_attempt(uuid,uuid,timestamptz) FROM PUBLIC,anon,authenticated;
COMMIT;
