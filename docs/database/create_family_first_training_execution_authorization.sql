BEGIN;

-- Phase 11B.6C.3B: database foundation only. Application entry points remain
-- self-only until 6C.3C, so this migration must not be applied independently
-- to enable guardian UI execution.

-- This replaces only the completion RPC's legacy-self gate. Production UI
-- entry remains self-only until the later coordinated player/route cutover.
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
  'Canonical training completion. ACT authorization and all athlete ownership derive from the locked durable session; compatibility athlete_user_id may be NULL.';


CREATE OR REPLACE FUNCTION private.register_workout_session_attempt_from_event(
  p_attempt_id uuid,
  p_session_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_started timestamptz;
  v_existing public.workout_session_attempts;
  v_session public.training_sessions;
  v_prescription public.training_session_prescriptions;
BEGIN
  SELECT * INTO v_session
  FROM public.training_sessions AS session
  WHERE session.id = p_session_id
  FOR KEY SHARE;
  IF v_actor IS NULL
     OR NOT FOUND
     OR v_session.athlete_id IS NULL
     OR NOT private.can_act_for_training_session(v_session.id) THEN
    RAISE EXCEPTION 'Attempt session unavailable';
  END IF;

  SELECT occurred_at INTO v_started
  FROM public.workout_session_events
  WHERE session_id = p_session_id
    AND attempt_id = p_attempt_id
    AND event_type = 'workout_started'
    AND sequence = 0
    AND phase = 'ready'
    AND workout_exercise_id IS NULL
    AND step_position IS NULL
    AND phase_duration_ms IS NULL
    AND phase_elapsed_ms IS NULL;
  IF NOT FOUND OR (
    SELECT count(*)
    FROM public.workout_session_events
    WHERE session_id = p_session_id
      AND attempt_id = p_attempt_id
      AND event_type = 'workout_started'
  ) <> 1 THEN
    RAISE EXCEPTION 'Attempt start event unavailable';
  END IF;

  SELECT * INTO v_existing
  FROM public.workout_session_attempts
  WHERE id = p_attempt_id;
  IF FOUND THEN
    IF v_existing.training_session_id IS DISTINCT FROM p_session_id
       OR v_existing.athlete_id IS DISTINCT FROM v_session.athlete_id
       OR v_existing.athlete_user_id IS DISTINCT FROM v_session.athlete_user_id THEN
      RAISE EXCEPTION 'Attempt identity conflict';
    END IF;
    RETURN p_attempt_id;
  END IF;

  SELECT * INTO v_prescription
  FROM public.training_session_prescriptions
  WHERE session_id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Attempt prescription unavailable';
  END IF;

  INSERT INTO public.workout_session_attempts (
    id,
    training_session_id,
    athlete_id,
    athlete_user_id,
    started_at,
    prescription_schema_version,
    prescribed_work_ms,
    prescribed_rest_ms,
    prescribed_total_ms,
    prescribed_step_count
  ) VALUES (
    p_attempt_id,
    p_session_id,
    v_session.athlete_id,
    v_session.athlete_user_id,
    v_started,
    v_prescription.schema_version,
    v_prescription.prescribed_work_ms,
    v_prescription.prescribed_rest_ms,
    v_prescription.prescribed_total_ms,
    v_prescription.step_count
  );

  RETURN p_attempt_id;
END;
$function$;



REVOKE ALL ON FUNCTION private.register_workout_session_attempt_from_event(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.register_my_workout_session_attempt(p_attempt_id uuid, p_session_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
BEGIN
  RETURN private.register_workout_session_attempt_from_event(p_attempt_id, p_session_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.register_my_workout_session_attempt(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_my_workout_session_attempt(uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION private.materialize_workout_session_attempt(uuid)
  FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE FUNCTION public.finalize_my_workout_session_attempt(p_attempt_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
BEGIN
  PERFORM private.materialize_workout_session_attempt(p_attempt_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.finalize_my_workout_session_attempt(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_my_workout_session_attempt(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION private.materialize_workout_session_attempt(p_attempt_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  a public.workout_session_attempts;
  r public.workout_results;
  v_session public.training_sessions;
  e record;
  v_count integer;
  v_first integer;
  v_last integer;
  v_start_count integer;
  v_terminal_count integer;
  v_terminal_seq integer;
  v_terminal_elapsed bigint;
  v_previous_seq integer;
  v_previous_elapsed bigint;
  v_pause_start bigint;
  v_hidden_start bigint;
  v_pause bigint := 0;
  v_hidden bigint := 0;
  v_bad boolean := false;
  v_partial boolean := false;
  v_completed_work integer;
  v_skipped_work integer;
  v_completed_rest integer;
  v_skipped_rest integer;
BEGIN
  SELECT * INTO a
  FROM public.workout_session_attempts
  WHERE id = p_attempt_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Attempt unavailable'; END IF;

  SELECT * INTO v_session
  FROM public.training_sessions AS session
  WHERE session.id = a.training_session_id
  FOR KEY SHARE;
  IF NOT FOUND
     OR v_session.athlete_id IS NULL
     OR a.athlete_id IS DISTINCT FROM v_session.athlete_id
     OR a.athlete_user_id IS DISTINCT FROM v_session.athlete_user_id THEN
    RAISE EXCEPTION 'Attempt and session ownership are inconsistent';
  END IF;

  IF NOT private.can_act_for_training_session(v_session.id) THEN
    RAISE EXCEPTION 'Attempt unavailable';
  END IF;

  IF (
    SELECT count(*)
    FROM public.workout_results
    WHERE training_session_id = a.training_session_id
      AND athlete_id = v_session.athlete_id
      AND athlete_user_id IS NOT DISTINCT FROM v_session.athlete_user_id
  ) <> 1 THEN
    RAISE EXCEPTION 'Canonical result unavailable';
  END IF;

  SELECT * INTO r
  FROM public.workout_results
  WHERE training_session_id = a.training_session_id
    AND athlete_id = v_session.athlete_id
    AND athlete_user_id IS NOT DISTINCT FROM v_session.athlete_user_id;
  IF r.athlete_id IS DISTINCT FROM a.athlete_id
     OR r.athlete_user_id IS DISTINCT FROM a.athlete_user_id THEN
    RAISE EXCEPTION 'Attempt and canonical result ownership are inconsistent';
  END IF;

  SELECT count(*), min(sequence), max(sequence),
         count(*) FILTER (WHERE event_type = 'workout_started'),
         count(*) FILTER (WHERE event_type = 'workout_completed'),
         max(sequence) FILTER (WHERE event_type = 'workout_completed'),
         max(elapsed_ms) FILTER (WHERE event_type = 'workout_completed')
    INTO v_count, v_first, v_last, v_start_count, v_terminal_count,
         v_terminal_seq, v_terminal_elapsed
  FROM public.workout_session_events
  WHERE session_id = a.training_session_id
    AND attempt_id = a.id;
  IF v_count = 0 OR v_start_count <> 1 OR v_terminal_count <> 1
     OR v_first <> 0 OR v_count <> v_last + 1 OR v_terminal_seq <> v_last THEN
    v_bad := true;
  END IF;

  FOR e IN
    SELECT *
    FROM public.workout_session_events
    WHERE session_id = a.training_session_id
      AND attempt_id = a.id
    ORDER BY sequence
  LOOP
    IF v_previous_seq IS NOT NULL AND e.sequence <> v_previous_seq + 1 THEN v_bad := true; END IF;
    IF v_previous_elapsed IS NOT NULL AND e.elapsed_ms < v_previous_elapsed THEN v_bad := true; END IF;
    v_previous_seq := e.sequence;
    v_previous_elapsed := e.elapsed_ms;

    IF e.event_type = 'workout_started'
       AND (e.sequence <> 0 OR e.phase <> 'ready' OR e.workout_exercise_id IS NOT NULL
            OR e.step_position IS NOT NULL OR e.phase_duration_ms IS NOT NULL
            OR e.phase_elapsed_ms IS NOT NULL) THEN v_bad := true; END IF;
    IF e.event_type = 'workout_completed'
       AND (e.sequence <> v_last OR e.phase <> 'finished' OR e.workout_exercise_id IS NOT NULL
            OR e.step_position IS NOT NULL OR e.phase_duration_ms IS NOT NULL
            OR e.phase_elapsed_ms IS NOT NULL) THEN v_bad := true; END IF;
    IF (e.event_type IN ('exercise_started','exercise_completed','exercise_skipped') AND e.phase <> 'work')
       OR (e.event_type IN ('rest_started','rest_completed','rest_skipped') AND e.phase <> 'rest')
       OR (e.event_type IN ('timer_paused','timer_resumed','page_hidden','page_visible') AND e.phase NOT IN ('work','rest'))
       OR e.event_type NOT IN ('workout_started','workout_completed','exercise_started','exercise_completed','exercise_skipped','rest_started','rest_completed','rest_skipped','timer_paused','timer_resumed','page_hidden','page_visible') THEN v_bad := true; END IF;
    IF e.phase IN ('work','rest') THEN
      IF e.workout_exercise_id IS NULL OR e.step_position IS NULL
         OR e.phase_duration_ms IS NULL OR e.phase_elapsed_ms IS NULL
         OR e.phase_elapsed_ms > e.phase_duration_ms
         OR (e.phase = 'rest' AND e.phase_duration_ms = 0)
         OR NOT EXISTS (
           SELECT 1
           FROM public.training_session_prescriptions AS tsp,
                jsonb_array_elements(tsp.steps) AS step
           WHERE tsp.session_id = a.training_session_id
             AND step->>'workout_exercise_id' = e.workout_exercise_id::text
             AND (step->>'position')::integer = e.step_position
             AND ((e.phase = 'work' AND (step->>'work_ms')::bigint = e.phase_duration_ms)
               OR (e.phase = 'rest' AND (step->>'rest_ms')::bigint = e.phase_duration_ms))
         ) THEN v_bad := true; END IF;
    ELSIF e.workout_exercise_id IS NOT NULL OR e.step_position IS NOT NULL
       OR e.phase_duration_ms IS NOT NULL OR e.phase_elapsed_ms IS NOT NULL THEN
      v_bad := true;
    END IF;
    IF e.event_type = 'timer_paused' THEN
      IF v_pause_start IS NOT NULL THEN v_partial := true; ELSE v_pause_start := e.elapsed_ms; END IF;
    END IF;
    IF e.event_type = 'timer_resumed' THEN
      IF v_pause_start IS NULL THEN v_partial := true; ELSE v_pause := v_pause + e.elapsed_ms - v_pause_start; v_pause_start := NULL; END IF;
    END IF;
    IF e.event_type = 'page_hidden' THEN
      IF v_hidden_start IS NOT NULL THEN v_partial := true; ELSE v_hidden_start := e.elapsed_ms; END IF;
    END IF;
    IF e.event_type = 'page_visible' THEN
      IF v_hidden_start IS NULL THEN v_partial := true; ELSE v_hidden := v_hidden + e.elapsed_ms - v_hidden_start; v_hidden_start := NULL; END IF;
    END IF;
  END LOOP;

  IF v_pause_start IS NOT NULL OR v_hidden_start IS NOT NULL THEN v_partial := true; END IF;
  IF v_terminal_elapsed - v_pause > a.prescribed_total_ms THEN v_partial := true; END IF;

  SELECT count(DISTINCT workout_exercise_id) FILTER (WHERE event_type = 'exercise_completed'),
         count(DISTINCT workout_exercise_id) FILTER (WHERE event_type = 'exercise_skipped'),
         count(DISTINCT workout_exercise_id) FILTER (WHERE event_type = 'rest_completed'),
         count(DISTINCT workout_exercise_id) FILTER (WHERE event_type = 'rest_skipped')
    INTO v_completed_work, v_skipped_work, v_completed_rest, v_skipped_rest
  FROM public.workout_session_events
  WHERE session_id = a.training_session_id
    AND attempt_id = a.id;

  IF EXISTS (
    SELECT 1
    FROM public.workout_session_events AS completed
    JOIN public.workout_session_events AS skipped
      ON skipped.session_id = completed.session_id
     AND skipped.attempt_id = completed.attempt_id
     AND skipped.workout_exercise_id = completed.workout_exercise_id
    WHERE completed.session_id = a.training_session_id
      AND completed.attempt_id = a.id
      AND ((completed.event_type = 'exercise_completed' AND skipped.event_type = 'exercise_skipped')
        OR (completed.event_type = 'rest_completed' AND skipped.event_type = 'rest_skipped'))
  ) THEN v_bad := true; END IF;

  IF a.finalization_state = 'finalized_completed' THEN
    IF NOT v_bad AND NOT v_partial
       AND a.workout_result_id = r.id
       AND a.first_sequence = v_first
       AND a.last_sequence = v_last
       AND a.event_count = v_count
       AND a.elapsed_attempt_ms = v_terminal_elapsed
       AND a.explicit_pause_ms = v_pause
       AND a.hidden_ms = v_hidden
       AND a.work_timer_progressed_ms IS NULL
       AND a.rest_timer_progressed_ms IS NULL
       AND a.completed_work_blocks = v_completed_work
       AND a.skipped_work_blocks = v_skipped_work
       AND a.completed_rest_blocks = v_completed_rest
       AND a.skipped_rest_blocks = v_skipped_rest
       AND a.measurement_version = 1
       AND a.measurement_quality = 'complete' THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'Finalized attempt cannot be rewritten';
  END IF;

  IF v_bad THEN RAISE EXCEPTION 'Attempt telemetry is structurally invalid'; END IF;
  IF v_partial THEN RAISE EXCEPTION 'Attempt telemetry is incomplete'; END IF;

  UPDATE public.workout_session_attempts
  SET workout_result_id = r.id,
      finalized_at = clock_timestamp(),
      finalization_state = 'finalized_completed',
      first_sequence = v_first,
      last_sequence = v_last,
      event_count = v_count,
      elapsed_attempt_ms = v_terminal_elapsed,
      explicit_pause_ms = v_pause,
      work_timer_progressed_ms = NULL,
      rest_timer_progressed_ms = NULL,
      hidden_ms = v_hidden,
      completed_work_blocks = v_completed_work,
      skipped_work_blocks = v_skipped_work,
      completed_rest_blocks = v_completed_rest,
      skipped_rest_blocks = v_skipped_rest,
      measurement_version = 1,
      measurement_quality = 'complete'
  WHERE id = a.id;
END;
$function$;


REVOKE ALL ON FUNCTION private.materialize_workout_session_attempt(uuid) FROM PUBLIC, anon, authenticated;

-- Family VIEW exposes documented training only; staff/admin legacy support
-- visibility remains explicit and never grants ACT.
DROP POLICY training_sessions_select ON public.training_sessions;
CREATE POLICY training_sessions_select ON public.training_sessions
FOR SELECT TO authenticated
USING (
  athlete_user_id = (SELECT auth.uid())
  OR (athlete_id IS NOT NULL AND (SELECT private.can_view_athlete(athlete_id)))
  OR (SELECT private.is_team_coach(team_id, (SELECT auth.uid())))
  OR (SELECT private.is_admin((SELECT auth.uid())))
);

DROP POLICY training_session_prescriptions_select ON public.training_session_prescriptions;
CREATE POLICY training_session_prescriptions_select ON public.training_session_prescriptions
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.training_sessions AS session
    WHERE session.id = training_session_prescriptions.session_id
      AND (
        session.athlete_user_id = (SELECT auth.uid())
        OR (session.athlete_id IS NOT NULL AND (SELECT private.can_view_athlete(session.athlete_id)))
        OR (SELECT private.is_team_coach(session.team_id, (SELECT auth.uid())))
        OR (SELECT private.is_admin((SELECT auth.uid())))
      )
  )
);

DROP POLICY workout_results_select ON public.workout_results;
CREATE POLICY workout_results_select ON public.workout_results
FOR SELECT TO authenticated
USING (
  athlete_user_id = (SELECT auth.uid())
  OR (athlete_id IS NOT NULL AND (SELECT private.can_view_athlete(athlete_id)))
  OR EXISTS (
    SELECT 1 FROM public.training_sessions AS session
    WHERE session.id = workout_results.training_session_id
      AND (SELECT private.is_team_coach(session.team_id, (SELECT auth.uid())))
  )
  OR (SELECT private.is_admin((SELECT auth.uid())))
);

-- Attempts and raw events are operational recovery data. VIEW alone does not
-- expose them; an actor must retain session-scoped ACT authority.
DROP POLICY workout_session_attempts_select ON public.workout_session_attempts;
CREATE POLICY workout_session_attempts_select ON public.workout_session_attempts
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.training_sessions AS session
    WHERE session.id = workout_session_attempts.training_session_id
      AND (SELECT private.can_act_for_training_session(session.id))
  )
);

DROP POLICY workout_session_events_select ON public.workout_session_events;
CREATE POLICY workout_session_events_select ON public.workout_session_events
FOR SELECT TO authenticated
USING ((SELECT private.can_act_for_training_session(workout_session_events.session_id)));

DROP POLICY workout_session_events_insert ON public.workout_session_events;
CREATE POLICY workout_session_events_insert ON public.workout_session_events
FOR INSERT TO authenticated
WITH CHECK (
  (SELECT private.can_act_for_training_session(workout_session_events.session_id))
  AND NOT EXISTS (
    SELECT 1 FROM public.workout_session_attempts AS attempt
    WHERE attempt.id = workout_session_events.attempt_id
      AND attempt.training_session_id IS DISTINCT FROM workout_session_events.session_id
  )
  AND (
    workout_session_events.workout_exercise_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM public.training_session_prescriptions AS prescription,
           LATERAL jsonb_array_elements(prescription.steps) AS step(value)
      WHERE prescription.session_id = workout_session_events.session_id
        AND step.value->>'workout_exercise_id' = workout_session_events.workout_exercise_id::text
        AND (step.value->>'position')::integer = workout_session_events.step_position
        AND (
          (workout_session_events.phase = 'work' AND (step.value->>'work_ms')::bigint = workout_session_events.phase_duration_ms)
          OR (workout_session_events.phase = 'rest' AND (step.value->>'rest_ms')::bigint = workout_session_events.phase_duration_ms)
        )
    )
  )
  AND (
    workout_session_events.event_type <> 'workout_completed'
    OR EXISTS (
      SELECT 1
      FROM public.training_sessions AS session
      JOIN public.workout_results AS result
        ON result.training_session_id = session.id
      WHERE session.id = workout_session_events.session_id
        AND result.athlete_id IS NOT DISTINCT FROM session.athlete_id
        AND result.athlete_user_id IS NOT DISTINCT FROM session.athlete_user_id
    )
  )
);

-- Preserve the existing narrow public completion entrypoint.
REVOKE ALL ON FUNCTION public.complete_my_training_session(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_my_training_session(uuid) TO authenticated;

COMMIT;
