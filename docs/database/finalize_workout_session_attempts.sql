BEGIN;

ALTER TABLE public.workout_session_attempts
  ADD CONSTRAINT workout_session_attempts_sequences_valid CHECK (
    (first_sequence IS NULL OR first_sequence >= 0) AND
    (last_sequence IS NULL OR last_sequence >= 0) AND
    (first_sequence IS NULL OR last_sequence IS NULL OR last_sequence >= first_sequence)
  ),
  ADD CONSTRAINT workout_session_attempts_metrics_nonnegative CHECK (
    coalesce(elapsed_attempt_ms,0) >= 0 AND coalesce(explicit_pause_ms,0) >= 0 AND
    coalesce(work_timer_progressed_ms,0) >= 0 AND coalesce(rest_timer_progressed_ms,0) >= 0 AND
    coalesce(hidden_ms,0) >= 0 AND completed_work_blocks >= 0 AND skipped_work_blocks >= 0 AND
    completed_rest_blocks >= 0 AND skipped_rest_blocks >= 0 AND measurement_version > 0
  );

CREATE OR REPLACE FUNCTION private.register_workout_session_attempt_from_event(p_attempt_id uuid,p_session_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_started timestamptz; v_existing public.workout_session_attempts; v_prescription public.training_session_prescriptions;
BEGIN
  SELECT occurred_at INTO v_started FROM public.workout_session_events
  WHERE session_id=p_session_id AND attempt_id=p_attempt_id AND event_type='workout_started'
    AND sequence=0 AND phase='ready' AND workout_exercise_id IS NULL AND step_position IS NULL
    AND phase_duration_ms IS NULL AND phase_elapsed_ms IS NULL;
  IF NOT FOUND OR (SELECT count(*) FROM public.workout_session_events WHERE session_id=p_session_id AND attempt_id=p_attempt_id AND event_type='workout_started') <> 1 THEN RAISE EXCEPTION 'Attempt start event unavailable'; END IF;
  SELECT * INTO v_existing FROM public.workout_session_attempts WHERE id=p_attempt_id;
  IF FOUND THEN
    IF v_existing.training_session_id<>p_session_id OR v_existing.athlete_user_id<>(SELECT auth.uid()) THEN RAISE EXCEPTION 'Attempt identity conflict'; END IF;
    RETURN p_attempt_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.training_sessions WHERE id=p_session_id AND athlete_user_id=(SELECT auth.uid())) THEN RAISE EXCEPTION 'Attempt session unavailable'; END IF;
  SELECT * INTO v_prescription FROM public.training_session_prescriptions WHERE session_id=p_session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Attempt prescription unavailable'; END IF;
  INSERT INTO public.workout_session_attempts(id,training_session_id,athlete_user_id,started_at,prescription_schema_version,prescribed_work_ms,prescribed_rest_ms,prescribed_total_ms,prescribed_step_count)
  VALUES(p_attempt_id,p_session_id,(SELECT auth.uid()),v_started,v_prescription.schema_version,v_prescription.prescribed_work_ms,v_prescription.prescribed_rest_ms,v_prescription.prescribed_total_ms,v_prescription.step_count);
  RETURN p_attempt_id;
END $$;
REVOKE ALL ON FUNCTION private.register_workout_session_attempt_from_event(uuid,uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.register_my_workout_session_attempt(p_attempt_id uuid,p_session_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN RETURN private.register_workout_session_attempt_from_event(p_attempt_id,p_session_id); END $$;
REVOKE ALL ON FUNCTION public.register_my_workout_session_attempt(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.register_my_workout_session_attempt(uuid,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION private.materialize_workout_session_attempt(p_attempt_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE a public.workout_session_attempts; r public.workout_results; e record;
  v_count integer; v_first integer; v_last integer; v_start_count integer; v_terminal_count integer; v_terminal_seq integer; v_terminal_elapsed bigint;
  v_previous_seq integer; v_previous_elapsed bigint; v_pause_start bigint; v_hidden_start bigint; v_pause bigint:=0; v_hidden bigint:=0;
  v_bad boolean:=false; v_partial boolean:=false; v_completed_work integer; v_skipped_work integer; v_completed_rest integer; v_skipped_rest integer;
BEGIN
  SELECT * INTO a FROM public.workout_session_attempts WHERE id=p_attempt_id AND athlete_user_id=(SELECT auth.uid()) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Attempt unavailable'; END IF;
  IF (SELECT count(*) FROM public.workout_results WHERE training_session_id=a.training_session_id AND athlete_user_id=a.athlete_user_id) <> 1 THEN RAISE EXCEPTION 'Canonical result unavailable'; END IF;
  SELECT * INTO r FROM public.workout_results WHERE training_session_id=a.training_session_id AND athlete_user_id=a.athlete_user_id;
  SELECT count(*),min(sequence),max(sequence),count(*) FILTER (WHERE event_type='workout_started'),count(*) FILTER (WHERE event_type='workout_completed'),max(sequence) FILTER (WHERE event_type='workout_completed'),max(elapsed_ms) FILTER (WHERE event_type='workout_completed')
    INTO v_count,v_first,v_last,v_start_count,v_terminal_count,v_terminal_seq,v_terminal_elapsed
  FROM public.workout_session_events WHERE session_id=a.training_session_id AND attempt_id=a.id;
  IF v_count=0 OR v_start_count<>1 OR v_terminal_count<>1 OR v_first<>0 OR v_count<>v_last+1 OR v_terminal_seq<>v_last THEN v_bad:=true; END IF;
  FOR e IN SELECT * FROM public.workout_session_events WHERE session_id=a.training_session_id AND attempt_id=a.id ORDER BY sequence LOOP
    IF v_previous_seq IS NOT NULL AND e.sequence<>v_previous_seq+1 THEN v_bad:=true; END IF;
    IF v_previous_elapsed IS NOT NULL AND e.elapsed_ms<v_previous_elapsed THEN v_bad:=true; END IF;
    v_previous_seq:=e.sequence; v_previous_elapsed:=e.elapsed_ms;
    IF e.event_type='workout_started' AND (e.sequence<>0 OR e.phase<>'ready' OR e.workout_exercise_id IS NOT NULL OR e.step_position IS NOT NULL OR e.phase_duration_ms IS NOT NULL OR e.phase_elapsed_ms IS NOT NULL) THEN v_bad:=true; END IF;
    IF e.event_type='workout_completed' AND (e.sequence<>v_last OR e.phase<>'finished' OR e.workout_exercise_id IS NOT NULL OR e.step_position IS NOT NULL OR e.phase_duration_ms IS NOT NULL OR e.phase_elapsed_ms IS NOT NULL) THEN v_bad:=true; END IF;
    IF (e.event_type IN ('exercise_started','exercise_completed','exercise_skipped') AND e.phase<>'work')
      OR (e.event_type IN ('rest_started','rest_completed','rest_skipped') AND e.phase<>'rest')
      OR (e.event_type IN ('timer_paused','timer_resumed','page_hidden','page_visible') AND e.phase NOT IN ('work','rest'))
      OR e.event_type NOT IN ('workout_started','workout_completed','exercise_started','exercise_completed','exercise_skipped','rest_started','rest_completed','rest_skipped','timer_paused','timer_resumed','page_hidden','page_visible') THEN v_bad:=true; END IF;
    IF e.phase IN ('work','rest') THEN
      IF e.workout_exercise_id IS NULL OR e.step_position IS NULL OR e.phase_duration_ms IS NULL OR e.phase_elapsed_ms IS NULL OR e.phase_elapsed_ms>e.phase_duration_ms OR (e.phase='rest' AND e.phase_duration_ms=0) OR NOT EXISTS (
        SELECT 1 FROM public.training_session_prescriptions tsp, jsonb_array_elements(tsp.steps) step
        WHERE tsp.session_id=a.training_session_id AND step->>'workout_exercise_id'=e.workout_exercise_id::text
          AND (step->>'position')::integer=e.step_position
          AND ((e.phase='work' AND (step->>'work_ms')::bigint=e.phase_duration_ms) OR (e.phase='rest' AND (step->>'rest_ms')::bigint=e.phase_duration_ms))
      ) THEN v_bad:=true; END IF;
    ELSIF e.workout_exercise_id IS NOT NULL OR e.step_position IS NOT NULL OR e.phase_duration_ms IS NOT NULL OR e.phase_elapsed_ms IS NOT NULL THEN v_bad:=true;
    END IF;
    IF e.event_type='timer_paused' THEN IF v_pause_start IS NOT NULL THEN v_partial:=true; ELSE v_pause_start:=e.elapsed_ms; END IF; END IF;
    IF e.event_type='timer_resumed' THEN IF v_pause_start IS NULL THEN v_partial:=true; ELSE v_pause:=v_pause+e.elapsed_ms-v_pause_start; v_pause_start:=NULL; END IF; END IF;
    IF e.event_type='page_hidden' THEN IF v_hidden_start IS NOT NULL THEN v_partial:=true; ELSE v_hidden_start:=e.elapsed_ms; END IF; END IF;
    IF e.event_type='page_visible' THEN IF v_hidden_start IS NULL THEN v_partial:=true; ELSE v_hidden:=v_hidden+e.elapsed_ms-v_hidden_start; v_hidden_start:=NULL; END IF; END IF;
  END LOOP;
  IF v_pause_start IS NOT NULL OR v_hidden_start IS NOT NULL THEN v_partial:=true; END IF;
  IF v_terminal_elapsed-v_pause>a.prescribed_total_ms THEN v_partial:=true; END IF;
  SELECT count(DISTINCT workout_exercise_id) FILTER (WHERE event_type='exercise_completed'),count(DISTINCT workout_exercise_id) FILTER (WHERE event_type='exercise_skipped'),count(DISTINCT workout_exercise_id) FILTER (WHERE event_type='rest_completed'),count(DISTINCT workout_exercise_id) FILTER (WHERE event_type='rest_skipped')
    INTO v_completed_work,v_skipped_work,v_completed_rest,v_skipped_rest
  FROM public.workout_session_events WHERE session_id=a.training_session_id AND attempt_id=a.id;
  IF EXISTS (SELECT 1 FROM public.workout_session_events c JOIN public.workout_session_events s ON s.session_id=c.session_id AND s.attempt_id=c.attempt_id AND s.workout_exercise_id=c.workout_exercise_id WHERE c.session_id=a.training_session_id AND c.attempt_id=a.id AND ((c.event_type='exercise_completed' AND s.event_type='exercise_skipped') OR (c.event_type='rest_completed' AND s.event_type='rest_skipped'))) THEN v_bad:=true; END IF;
  IF a.finalization_state='finalized_completed' THEN
    IF NOT v_bad AND NOT v_partial AND a.workout_result_id=r.id AND a.first_sequence=v_first AND a.last_sequence=v_last AND a.event_count=v_count AND a.elapsed_attempt_ms=v_terminal_elapsed AND a.explicit_pause_ms=v_pause AND a.hidden_ms=v_hidden AND a.work_timer_progressed_ms IS NULL AND a.rest_timer_progressed_ms IS NULL AND a.completed_work_blocks=v_completed_work AND a.skipped_work_blocks=v_skipped_work AND a.completed_rest_blocks=v_completed_rest AND a.skipped_rest_blocks=v_skipped_rest AND a.measurement_version=1 AND a.measurement_quality='complete' THEN RETURN; END IF;
    RAISE EXCEPTION 'Finalized attempt cannot be rewritten';
  END IF;
  IF v_bad THEN RAISE EXCEPTION 'Attempt telemetry is structurally invalid'; END IF;
  IF v_partial THEN RAISE EXCEPTION 'Attempt telemetry is incomplete'; END IF;
  UPDATE public.workout_session_attempts SET workout_result_id=r.id,finalized_at=clock_timestamp(),finalization_state='finalized_completed',first_sequence=v_first,last_sequence=v_last,event_count=v_count,elapsed_attempt_ms=v_terminal_elapsed,explicit_pause_ms=v_pause,work_timer_progressed_ms=NULL,rest_timer_progressed_ms=NULL,hidden_ms=v_hidden,completed_work_blocks=v_completed_work,skipped_work_blocks=v_skipped_work,completed_rest_blocks=v_completed_rest,skipped_rest_blocks=v_skipped_rest,measurement_version=1,measurement_quality='complete' WHERE id=a.id;
END $$;
REVOKE ALL ON FUNCTION private.materialize_workout_session_attempt(uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.finalize_my_workout_session_attempt(p_attempt_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN PERFORM private.materialize_workout_session_attempt(p_attempt_id); END $$;
REVOKE ALL ON FUNCTION public.finalize_my_workout_session_attempt(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.finalize_my_workout_session_attempt(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION private.reject_late_workout_session_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.workout_session_attempts a WHERE a.id=NEW.attempt_id AND a.training_session_id=NEW.session_id AND a.finalization_state='finalized_completed') AND NOT EXISTS (SELECT 1 FROM public.workout_session_events e WHERE e.id=NEW.id OR (e.session_id=NEW.session_id AND e.attempt_id=NEW.attempt_id AND e.sequence=NEW.sequence)) THEN
    RAISE EXCEPTION 'Attempt history is finalized';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.reject_late_workout_session_event() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER workout_session_events_reject_late_attempt_event BEFORE INSERT ON public.workout_session_events FOR EACH ROW EXECUTE FUNCTION private.reject_late_workout_session_event();

COMMIT;
