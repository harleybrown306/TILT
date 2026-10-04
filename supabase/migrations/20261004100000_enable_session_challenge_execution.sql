BEGIN;

-- Phase 18B: one immutable, session-scoped answer to the prescription being
-- executed.  This intentionally chooses between snapshots only; it never
-- consults mutable workout-library rows.
CREATE FUNCTION private.resolve_training_session_performed_prescription(p_session_id uuid)
RETURNS TABLE (selected_variant public.training_session_performed_variant, source_workout_id uuid, workout_name text, schema_version smallint, prescribed_work_ms bigint, prescribed_rest_ms bigint, prescribed_total_ms bigint, step_count integer, steps jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
  SELECT coalesce(variant.selected_variant,'assigned'::public.training_session_performed_variant),
         CASE WHEN coalesce(variant.selected_variant,'assigned'::public.training_session_performed_variant)='challenge' THEN challenge.source_workout_id ELSE assigned.workout_id END,
         CASE WHEN coalesce(variant.selected_variant,'assigned'::public.training_session_performed_variant)='challenge' THEN challenge.workout_name ELSE assigned.workout_name END,
         CASE WHEN coalesce(variant.selected_variant,'assigned'::public.training_session_performed_variant)='challenge' THEN challenge.schema_version ELSE assigned.schema_version END,
         CASE WHEN coalesce(variant.selected_variant,'assigned'::public.training_session_performed_variant)='challenge' THEN challenge.prescribed_work_ms ELSE assigned.prescribed_work_ms END,
         CASE WHEN coalesce(variant.selected_variant,'assigned'::public.training_session_performed_variant)='challenge' THEN challenge.prescribed_rest_ms ELSE assigned.prescribed_rest_ms END,
         CASE WHEN coalesce(variant.selected_variant,'assigned'::public.training_session_performed_variant)='challenge' THEN challenge.prescribed_total_ms ELSE assigned.prescribed_total_ms END,
         CASE WHEN coalesce(variant.selected_variant,'assigned'::public.training_session_performed_variant)='challenge' THEN challenge.step_count ELSE assigned.step_count END,
         CASE WHEN coalesce(variant.selected_variant,'assigned'::public.training_session_performed_variant)='challenge' THEN challenge.steps ELSE assigned.steps END
  FROM public.training_sessions AS session
  JOIN public.training_session_prescriptions AS assigned ON assigned.session_id=session.id
  LEFT JOIN public.training_session_performed_variants AS variant ON variant.session_id=session.id
  LEFT JOIN public.training_session_challenge_prescriptions AS challenge ON challenge.session_id=session.id
  WHERE session.id=p_session_id
    AND (coalesce(variant.selected_variant,'assigned'::public.training_session_performed_variant)='assigned' OR challenge.session_id IS NOT NULL);
$function$;
REVOKE ALL ON FUNCTION private.resolve_training_session_performed_prescription(uuid) FROM PUBLIC,anon,authenticated;

-- Event RLS needs a caller-safe entrypoint.  The resolver itself remains
-- private so SECURITY DEFINER readers can resolve historical performed state
-- after their own authorization checks without accidentally requiring ACT.
CREATE FUNCTION private.performed_training_session_prescription(p_session_id uuid)
RETURNS TABLE (selected_variant public.training_session_performed_variant, source_workout_id uuid, workout_name text, schema_version smallint, prescribed_work_ms bigint, prescribed_rest_ms bigint, prescribed_total_ms bigint, step_count integer, steps jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
  SELECT prescription.*
  FROM private.resolve_training_session_performed_prescription(p_session_id) AS prescription
  WHERE private.can_act_for_training_session(p_session_id);
$function$;
REVOKE ALL ON FUNCTION private.performed_training_session_prescription(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.performed_training_session_prescription(uuid) TO authenticated;

CREATE FUNCTION private.performed_training_session_step_matches(p_session_id uuid,p_step_id uuid,p_position integer,p_phase text,p_duration bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
  SELECT EXISTS (SELECT 1 FROM private.performed_training_session_prescription(p_session_id) AS prescription, LATERAL jsonb_array_elements(prescription.steps) AS step(value) WHERE step.value->>'workout_exercise_id'=p_step_id::text AND (step.value->>'position')::integer=p_position AND ((p_phase='work' AND (step.value->>'work_ms')::bigint=p_duration) OR (p_phase='rest' AND (step.value->>'rest_ms')::bigint=p_duration)));
$function$;
REVOKE ALL ON FUNCTION private.performed_training_session_step_matches(uuid,uuid,integer,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.performed_training_session_step_matches(uuid,uuid,integer,text,bigint) TO authenticated;

DROP TRIGGER workout_session_events_reject_challenge_execution ON public.workout_session_events;
DROP TRIGGER workout_results_reject_challenge_completion ON public.workout_results;
DROP TRIGGER training_sessions_reject_challenge_completion ON public.training_sessions;

-- An event is the first durable execution state.  Serialize its insert with
-- variant selection on the session row before the RLS performed-step check so
-- neither transaction can observe one variant and commit the other.
CREATE FUNCTION private.lock_workout_session_execution_variant() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
BEGIN
  PERFORM 1 FROM public.training_sessions WHERE id=NEW.session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Training session unavailable'; END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.lock_workout_session_execution_variant() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER workout_session_events_lock_execution_variant BEFORE INSERT ON public.workout_session_events FOR EACH ROW EXECUTE FUNCTION private.lock_workout_session_execution_variant();

-- A custom GUC is not a capability: any SQL caller can set it.  Instead the
-- reviewed completion RPC creates an uncallable, one-use permit.  The result
-- trigger consumes its result half and the existing result-sync session update
-- consumes/deletes its session half in the same transaction.  No permit
-- survives a successful completion, rollback, savepoint rollback, or pooled
-- connection reuse.
CREATE TABLE private.training_session_canonical_completion_permits (
  session_id uuid PRIMARY KEY REFERENCES public.training_sessions(id) ON DELETE RESTRICT,
  result_armed boolean NOT NULL DEFAULT true,
  session_armed boolean NOT NULL DEFAULT true,
  CHECK (result_armed OR session_armed)
);
ALTER TABLE private.training_session_canonical_completion_permits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.training_session_canonical_completion_permits FROM PUBLIC,anon,authenticated;

CREATE FUNCTION private.arm_canonical_challenge_completion(p_session_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
BEGIN
  INSERT INTO private.training_session_canonical_completion_permits(session_id)
  VALUES (p_session_id);
END;
$function$;
REVOKE ALL ON FUNCTION private.arm_canonical_challenge_completion(uuid) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION private.require_canonical_challenge_completion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_session_id uuid;
DECLARE v_challenge boolean;
BEGIN
  IF TG_TABLE_NAME='workout_results' THEN v_session_id:=NEW.training_session_id; ELSE v_session_id:=NEW.id; END IF;
  PERFORM 1 FROM public.training_sessions WHERE id=v_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Challenge completion requires canonical execution'; END IF;
  SELECT EXISTS(SELECT 1 FROM public.training_session_performed_variants WHERE session_id=v_session_id AND selected_variant='challenge') INTO v_challenge;
  IF NOT v_challenge THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='workout_results' THEN
    UPDATE private.training_session_canonical_completion_permits
    SET result_armed=false
    WHERE session_id=v_session_id AND result_armed AND session_armed;
    IF NOT FOUND THEN RAISE EXCEPTION 'Challenge completion requires canonical execution'; END IF;
  ELSE
    DELETE FROM private.training_session_canonical_completion_permits
    WHERE session_id=v_session_id AND NOT result_armed AND session_armed;
    IF NOT FOUND THEN RAISE EXCEPTION 'Challenge completion requires canonical execution'; END IF;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.require_canonical_challenge_completion() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER workout_results_require_canonical_challenge_completion BEFORE INSERT ON public.workout_results FOR EACH ROW EXECUTE FUNCTION private.require_canonical_challenge_completion();
CREATE TRIGGER training_sessions_require_canonical_challenge_completion BEFORE UPDATE OF status,completed_at ON public.training_sessions FOR EACH ROW WHEN ((OLD.status IS DISTINCT FROM 'completed'::public.training_session_status AND NEW.status='completed'::public.training_session_status) OR NEW.completed_at IS DISTINCT FROM OLD.completed_at) EXECUTE FUNCTION private.require_canonical_challenge_completion();

DROP POLICY workout_session_events_insert ON public.workout_session_events;
CREATE POLICY workout_session_events_insert ON public.workout_session_events FOR INSERT TO authenticated WITH CHECK (
 (SELECT private.can_act_for_training_session(workout_session_events.session_id))
 AND NOT EXISTS (SELECT 1 FROM public.workout_session_attempts AS attempt WHERE attempt.id=workout_session_events.attempt_id AND attempt.training_session_id IS DISTINCT FROM workout_session_events.session_id)
 AND (workout_session_events.workout_exercise_id IS NULL OR private.performed_training_session_step_matches(workout_session_events.session_id,workout_session_events.workout_exercise_id,workout_session_events.step_position,workout_session_events.phase::text,workout_session_events.phase_duration_ms))
 AND (workout_session_events.event_type<>'workout_completed' OR EXISTS(SELECT 1 FROM public.workout_results AS result WHERE result.training_session_id=workout_session_events.session_id))
);

CREATE OR REPLACE FUNCTION private.register_workout_session_attempt_from_event(p_attempt_id uuid,p_session_id uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_actor uuid:=(SELECT auth.uid()); v_started timestamptz; v_existing public.workout_session_attempts; v_session public.training_sessions; v_prescription record;
BEGIN
 SELECT * INTO v_session FROM public.training_sessions AS session WHERE session.id=p_session_id FOR UPDATE;
 IF v_actor IS NULL OR NOT FOUND OR v_session.athlete_id IS NULL OR NOT private.can_act_for_training_session(v_session.id) THEN RAISE EXCEPTION 'Attempt session unavailable'; END IF;
 SELECT occurred_at INTO v_started FROM public.workout_session_events WHERE session_id=p_session_id AND attempt_id=p_attempt_id AND event_type='workout_started' AND sequence=0 AND phase='ready' AND workout_exercise_id IS NULL AND step_position IS NULL AND phase_duration_ms IS NULL AND phase_elapsed_ms IS NULL;
 IF NOT FOUND OR (SELECT count(*) FROM public.workout_session_events WHERE session_id=p_session_id AND attempt_id=p_attempt_id AND event_type='workout_started')<>1 THEN RAISE EXCEPTION 'Attempt start event unavailable'; END IF;
 SELECT * INTO v_prescription FROM private.performed_training_session_prescription(p_session_id); IF NOT FOUND THEN RAISE EXCEPTION 'Attempt prescription unavailable'; END IF;
 SELECT * INTO v_existing FROM public.workout_session_attempts WHERE id=p_attempt_id;
 IF FOUND THEN
   IF v_existing.training_session_id IS DISTINCT FROM p_session_id OR v_existing.athlete_id IS DISTINCT FROM v_session.athlete_id OR v_existing.athlete_user_id IS DISTINCT FROM v_session.athlete_user_id OR v_existing.prescription_schema_version IS DISTINCT FROM v_prescription.schema_version OR v_existing.prescribed_work_ms IS DISTINCT FROM v_prescription.prescribed_work_ms OR v_existing.prescribed_rest_ms IS DISTINCT FROM v_prescription.prescribed_rest_ms OR v_existing.prescribed_total_ms IS DISTINCT FROM v_prescription.prescribed_total_ms OR v_existing.prescribed_step_count IS DISTINCT FROM v_prescription.step_count THEN RAISE EXCEPTION 'Attempt identity conflict'; END IF; RETURN p_attempt_id;
 END IF;
 INSERT INTO public.workout_session_attempts(id,training_session_id,athlete_id,athlete_user_id,started_at,prescription_schema_version,prescribed_work_ms,prescribed_rest_ms,prescribed_total_ms,prescribed_step_count) VALUES(p_attempt_id,p_session_id,v_session.athlete_id,v_session.athlete_user_id,v_started,v_prescription.schema_version,v_prescription.prescribed_work_ms,v_prescription.prescribed_rest_ms,v_prescription.prescribed_total_ms,v_prescription.step_count);
 RETURN p_attempt_id;
END;
$function$;
REVOKE ALL ON FUNCTION private.register_workout_session_attempt_from_event(uuid,uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.complete_my_training_session(p_session_id uuid) RETURNS TABLE(result_id uuid,already_completed boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_actor uuid:=(SELECT auth.uid()); v_session public.training_sessions; v_prescription record; v_result public.workout_results;
BEGIN
 IF v_actor IS NULL OR p_session_id IS NULL THEN RAISE EXCEPTION 'Authentication and session are required'; END IF;
 SELECT * INTO v_session FROM public.training_sessions AS session WHERE session.id=p_session_id FOR UPDATE;
 IF NOT FOUND OR v_session.athlete_id IS NULL OR NOT private.can_act_for_training_session(p_session_id) THEN RAISE EXCEPTION 'Training action unavailable'; END IF;
 SELECT * INTO v_prescription FROM private.performed_training_session_prescription(v_session.id); IF NOT FOUND THEN RAISE EXCEPTION 'Training prescription unavailable or inconsistent'; END IF;
 SELECT * INTO v_result FROM public.workout_results WHERE training_session_id=v_session.id;
 IF FOUND THEN IF v_result.athlete_id IS DISTINCT FROM v_session.athlete_id OR v_result.athlete_user_id IS DISTINCT FROM v_session.athlete_user_id OR v_session.status IS DISTINCT FROM 'completed'::public.training_session_status THEN RAISE EXCEPTION 'Canonical result and session are inconsistent'; END IF; RETURN QUERY SELECT v_result.id,true; RETURN; END IF;
 IF v_prescription.selected_variant='challenge' AND NOT EXISTS (SELECT 1 FROM public.workout_session_attempts AS attempt WHERE attempt.training_session_id=v_session.id AND attempt.athlete_id=v_session.athlete_id AND attempt.athlete_user_id IS NOT DISTINCT FROM v_session.athlete_user_id AND attempt.prescription_schema_version=v_prescription.schema_version AND attempt.prescribed_work_ms=v_prescription.prescribed_work_ms AND attempt.prescribed_rest_ms=v_prescription.prescribed_rest_ms AND attempt.prescribed_total_ms=v_prescription.prescribed_total_ms AND attempt.prescribed_step_count=v_prescription.step_count) THEN RAISE EXCEPTION 'Challenge completion requires a performed attempt'; END IF;
 IF v_prescription.selected_variant='challenge' THEN PERFORM private.arm_canonical_challenge_completion(v_session.id); END IF;
 INSERT INTO public.workout_results(training_session_id,athlete_id,athlete_user_id,completed_at,active_minutes,total_duration_minutes,exercises_completed,result_data) VALUES(v_session.id,v_session.athlete_id,v_session.athlete_user_id,clock_timestamp(),ceil(v_prescription.prescribed_work_ms/60000.0)::integer,ceil(v_prescription.prescribed_total_ms/60000.0)::integer,v_prescription.step_count,CASE WHEN v_prescription.selected_variant='challenge' THEN jsonb_build_object('workout_name',v_prescription.workout_name,'completed_steps',v_prescription.step_count,'performed_variant','challenge') ELSE jsonb_build_object('workout_name',v_prescription.workout_name,'completed_steps',v_prescription.step_count) END) RETURNING id INTO v_result.id;
 IF NOT EXISTS(SELECT 1 FROM public.training_sessions AS session WHERE session.id=v_session.id AND session.status='completed'::public.training_session_status) THEN RAISE EXCEPTION 'Canonical result synchronization failed'; END IF;
 RETURN QUERY SELECT v_result.id,false;
END;
$function$;
REVOKE ALL ON FUNCTION public.complete_my_training_session(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_my_training_session(uuid) TO authenticated;

-- Phase 17 maps validated completed event identities through the same resolver.
CREATE OR REPLACE FUNCTION private.materialize_athlete_exercise_familiarity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
BEGIN
 IF OLD.finalization_state IS DISTINCT FROM 'finalized_completed' AND NEW.finalization_state='finalized_completed' AND NEW.athlete_id IS NOT NULL AND NEW.workout_result_id IS NOT NULL AND NEW.finalized_at IS NOT NULL THEN
  INSERT INTO public.athlete_exercise_familiarity(athlete_id,exercise_id,first_completed_at)
  SELECT NEW.athlete_id,(step.value->>'exercise_id')::uuid,NEW.finalized_at FROM public.workout_session_events AS event CROSS JOIN LATERAL private.performed_training_session_prescription(NEW.training_session_id) AS prescription CROSS JOIN LATERAL jsonb_array_elements(prescription.steps) AS step(value)
  WHERE event.session_id=NEW.training_session_id AND event.attempt_id=NEW.id AND event.event_type='exercise_completed' AND event.phase='work' AND step.value->>'workout_exercise_id'=event.workout_exercise_id::text AND (step.value->>'position')::integer=event.step_position AND (step.value->>'work_ms')::bigint=event.phase_duration_ms AND jsonb_typeof(step.value->'exercise_id')='string' AND step.value->>'exercise_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ON CONFLICT(athlete_id,exercise_id) DO UPDATE SET first_completed_at=LEAST(public.athlete_exercise_familiarity.first_completed_at,EXCLUDED.first_completed_at);
 END IF; RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.materialize_athlete_exercise_familiarity() FROM PUBLIC,anon,authenticated;

-- Measurement V1 retains its existing structural checks, but its immutable
-- identity lookup is now the performed snapshot (and it verifies the attempt
-- aggregates were bound to that same snapshot at registration).
CREATE OR REPLACE FUNCTION private.materialize_workout_session_attempt(p_attempt_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE a public.workout_session_attempts; r public.workout_results; v_session public.training_sessions; v_prescription record; e record; v_count integer; v_first integer; v_last integer; v_start_count integer; v_terminal_count integer; v_terminal_seq integer; v_terminal_elapsed bigint; v_previous_seq integer; v_previous_elapsed bigint; v_pause_start bigint; v_hidden_start bigint; v_pause bigint:=0; v_hidden bigint:=0; v_bad boolean:=false; v_partial boolean:=false; v_completed_work integer; v_skipped_work integer; v_completed_rest integer; v_skipped_rest integer; v_expected_rest integer;
BEGIN
 SELECT * INTO a FROM public.workout_session_attempts WHERE id=p_attempt_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Attempt unavailable'; END IF;
 SELECT * INTO v_session FROM public.training_sessions AS session WHERE session.id=a.training_session_id FOR KEY SHARE;
 IF NOT FOUND OR v_session.athlete_id IS NULL OR a.athlete_id IS DISTINCT FROM v_session.athlete_id OR a.athlete_user_id IS DISTINCT FROM v_session.athlete_user_id OR NOT private.can_act_for_training_session(v_session.id) THEN RAISE EXCEPTION 'Attempt unavailable'; END IF;
 SELECT * INTO v_prescription FROM private.performed_training_session_prescription(a.training_session_id); IF NOT FOUND OR a.prescription_schema_version IS DISTINCT FROM v_prescription.schema_version OR a.prescribed_work_ms IS DISTINCT FROM v_prescription.prescribed_work_ms OR a.prescribed_rest_ms IS DISTINCT FROM v_prescription.prescribed_rest_ms OR a.prescribed_total_ms IS DISTINCT FROM v_prescription.prescribed_total_ms OR a.prescribed_step_count IS DISTINCT FROM v_prescription.step_count THEN RAISE EXCEPTION 'Attempt prescription is inconsistent'; END IF;
 IF (SELECT count(*) FROM public.workout_results WHERE training_session_id=a.training_session_id AND athlete_id=v_session.athlete_id AND athlete_user_id IS NOT DISTINCT FROM v_session.athlete_user_id)<>1 THEN RAISE EXCEPTION 'Canonical result unavailable'; END IF;
 SELECT * INTO r FROM public.workout_results WHERE training_session_id=a.training_session_id AND athlete_id=v_session.athlete_id AND athlete_user_id IS NOT DISTINCT FROM v_session.athlete_user_id;
 SELECT count(*),min(sequence),max(sequence),count(*) FILTER(WHERE event_type='workout_started'),count(*) FILTER(WHERE event_type='workout_completed'),max(sequence) FILTER(WHERE event_type='workout_completed'),max(elapsed_ms) FILTER(WHERE event_type='workout_completed') INTO v_count,v_first,v_last,v_start_count,v_terminal_count,v_terminal_seq,v_terminal_elapsed FROM public.workout_session_events WHERE session_id=a.training_session_id AND attempt_id=a.id;
 IF v_count=0 OR v_start_count<>1 OR v_terminal_count<>1 OR v_first<>0 OR v_count<>v_last+1 OR v_terminal_seq<>v_last THEN v_bad:=true; END IF;
 FOR e IN SELECT * FROM public.workout_session_events WHERE session_id=a.training_session_id AND attempt_id=a.id ORDER BY sequence LOOP
  IF v_previous_seq IS NOT NULL AND e.sequence<>v_previous_seq+1 THEN v_bad:=true; END IF; IF v_previous_elapsed IS NOT NULL AND e.elapsed_ms<v_previous_elapsed THEN v_bad:=true; END IF; v_previous_seq:=e.sequence; v_previous_elapsed:=e.elapsed_ms;
  IF e.event_type='workout_started' AND (e.sequence<>0 OR e.phase<>'ready' OR e.workout_exercise_id IS NOT NULL OR e.step_position IS NOT NULL OR e.phase_duration_ms IS NOT NULL OR e.phase_elapsed_ms IS NOT NULL) THEN v_bad:=true; END IF;
  IF e.event_type='workout_completed' AND (e.sequence<>v_last OR e.phase<>'finished' OR e.workout_exercise_id IS NOT NULL OR e.step_position IS NOT NULL OR e.phase_duration_ms IS NOT NULL OR e.phase_elapsed_ms IS NOT NULL) THEN v_bad:=true; END IF;
  IF (e.event_type IN('exercise_started','exercise_completed','exercise_skipped') AND e.phase<>'work') OR (e.event_type IN('rest_started','rest_completed','rest_skipped') AND e.phase<>'rest') OR (e.event_type IN('timer_paused','timer_resumed','page_hidden','page_visible') AND e.phase NOT IN('work','rest')) OR e.event_type NOT IN('workout_started','workout_completed','exercise_started','exercise_completed','exercise_skipped','rest_started','rest_completed','rest_skipped','timer_paused','timer_resumed','page_hidden','page_visible') THEN v_bad:=true; END IF;
  IF e.phase IN('work','rest') THEN IF e.workout_exercise_id IS NULL OR e.step_position IS NULL OR e.phase_duration_ms IS NULL OR e.phase_elapsed_ms IS NULL OR e.phase_elapsed_ms>e.phase_duration_ms OR (e.phase='rest' AND e.phase_duration_ms=0) OR NOT private.performed_training_session_step_matches(a.training_session_id,e.workout_exercise_id,e.step_position,e.phase::text,e.phase_duration_ms) THEN v_bad:=true; END IF; ELSIF e.workout_exercise_id IS NOT NULL OR e.step_position IS NOT NULL OR e.phase_duration_ms IS NOT NULL OR e.phase_elapsed_ms IS NOT NULL THEN v_bad:=true; END IF;
  IF e.event_type='timer_paused' THEN IF v_pause_start IS NOT NULL THEN v_partial:=true; ELSE v_pause_start:=e.elapsed_ms; END IF; END IF; IF e.event_type='timer_resumed' THEN IF v_pause_start IS NULL THEN v_partial:=true; ELSE v_pause:=v_pause+e.elapsed_ms-v_pause_start; v_pause_start:=NULL; END IF; END IF; IF e.event_type='page_hidden' THEN IF v_hidden_start IS NOT NULL THEN v_partial:=true; ELSE v_hidden_start:=e.elapsed_ms; END IF; END IF; IF e.event_type='page_visible' THEN IF v_hidden_start IS NULL THEN v_partial:=true; ELSE v_hidden:=v_hidden+e.elapsed_ms-v_hidden_start; v_hidden_start:=NULL; END IF; END IF;
 END LOOP;
 IF v_pause_start IS NOT NULL OR v_hidden_start IS NOT NULL THEN v_partial:=true; END IF;
 SELECT count(DISTINCT workout_exercise_id) FILTER(WHERE event_type='exercise_completed'),count(DISTINCT workout_exercise_id) FILTER(WHERE event_type='exercise_skipped'),count(DISTINCT workout_exercise_id) FILTER(WHERE event_type='rest_completed'),count(DISTINCT workout_exercise_id) FILTER(WHERE event_type='rest_skipped') INTO v_completed_work,v_skipped_work,v_completed_rest,v_skipped_rest FROM public.workout_session_events WHERE session_id=a.training_session_id AND attempt_id=a.id;
 SELECT count(*) INTO v_expected_rest FROM jsonb_array_elements(v_prescription.steps) AS step(value) WHERE (step.value->>'rest_ms')::bigint>0;
 IF v_terminal_elapsed-v_pause>a.prescribed_total_ms AND (v_completed_work+v_skipped_work<>a.prescribed_step_count OR v_completed_rest+v_skipped_rest<>v_expected_rest) THEN v_partial:=true; END IF;
 IF EXISTS(SELECT 1 FROM public.workout_session_events completed JOIN public.workout_session_events skipped ON skipped.session_id=completed.session_id AND skipped.attempt_id=completed.attempt_id AND skipped.workout_exercise_id=completed.workout_exercise_id WHERE completed.session_id=a.training_session_id AND completed.attempt_id=a.id AND ((completed.event_type='exercise_completed' AND skipped.event_type='exercise_skipped') OR (completed.event_type='rest_completed' AND skipped.event_type='rest_skipped'))) THEN v_bad:=true; END IF;
 IF a.finalization_state='finalized_completed' THEN IF NOT v_bad AND NOT v_partial AND a.workout_result_id=r.id AND a.first_sequence=v_first AND a.last_sequence=v_last AND a.event_count=v_count AND a.elapsed_attempt_ms=v_terminal_elapsed AND a.explicit_pause_ms=v_pause AND a.hidden_ms=v_hidden AND a.work_timer_progressed_ms IS NULL AND a.rest_timer_progressed_ms IS NULL AND a.completed_work_blocks=v_completed_work AND a.skipped_work_blocks=v_skipped_work AND a.completed_rest_blocks=v_completed_rest AND a.skipped_rest_blocks=v_skipped_rest AND a.measurement_version=1 AND a.measurement_quality='complete' THEN RETURN; END IF; RAISE EXCEPTION 'Finalized attempt cannot be rewritten'; END IF;
 IF v_bad THEN RAISE EXCEPTION 'Attempt telemetry is structurally invalid'; END IF; IF v_partial THEN RAISE EXCEPTION 'Attempt telemetry is incomplete'; END IF;
 UPDATE public.workout_session_attempts SET workout_result_id=r.id,finalized_at=clock_timestamp(),finalization_state='finalized_completed',first_sequence=v_first,last_sequence=v_last,event_count=v_count,elapsed_attempt_ms=v_terminal_elapsed,explicit_pause_ms=v_pause,work_timer_progressed_ms=NULL,rest_timer_progressed_ms=NULL,hidden_ms=v_hidden,completed_work_blocks=v_completed_work,skipped_work_blocks=v_skipped_work,completed_rest_blocks=v_completed_rest,skipped_rest_blocks=v_skipped_rest,measurement_version=1,measurement_quality='complete' WHERE id=a.id;
END;
$function$;
REVOKE ALL ON FUNCTION private.materialize_workout_session_attempt(uuid) FROM PUBLIC,anon,authenticated;

-- Result-attached feedback is historical execution data.  Preserve each
-- function's existing result and actor checks, then resolve membership and
-- labels from the immutable prescription that this result actually performed.
CREATE OR REPLACE FUNCTION public.submit_my_workout_feedback(p_workout_result_id uuid,p_q1_response_state text,p_selected_workout_exercise_id uuid DEFAULT NULL,p_coach_note text DEFAULT NULL)
RETURNS TABLE(feedback_id uuid,workout_result_id uuid,q1_response_state text,selected_workout_exercise_id uuid,selected_exercise_label text,coach_note text,created_at timestamptz,already_submitted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_actor uuid:=(SELECT auth.uid()); v_note text:=NULLIF(regexp_replace(p_coach_note,'^[[:space:]]+|[[:space:]]+$','','g'),''); v_result public.workout_results%ROWTYPE; v_session public.training_sessions%ROWTYPE; v_feedback public.workout_result_feedback%ROWTYPE; v_attempt_count integer; v_label text;
BEGIN
 IF v_actor IS NULL OR p_workout_result_id IS NULL THEN RAISE EXCEPTION 'Workout feedback is unavailable' USING ERRCODE='42501'; END IF;
 IF p_q1_response_state IS NULL OR p_q1_response_state NOT IN('selected','none','skipped') OR (p_q1_response_state='selected' AND p_selected_workout_exercise_id IS NULL) OR (p_q1_response_state IN('none','skipped') AND p_selected_workout_exercise_id IS NOT NULL) THEN RAISE EXCEPTION 'Workout feedback response is invalid'; END IF;
 IF v_note IS NOT NULL AND char_length(v_note)>500 THEN RAISE EXCEPTION 'Workout feedback note is too long'; END IF;
 SELECT result.* INTO v_result FROM public.workout_results AS result WHERE result.id=p_workout_result_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Workout feedback is unavailable'; END IF;
 SELECT session.* INTO v_session FROM public.training_sessions AS session WHERE session.id=v_result.training_session_id FOR KEY SHARE;
 IF NOT FOUND OR v_session.athlete_id IS NULL OR v_session.status IS DISTINCT FROM 'completed'::public.training_session_status OR v_result.athlete_id IS DISTINCT FROM v_session.athlete_id OR v_result.athlete_user_id IS DISTINCT FROM v_session.athlete_user_id OR EXISTS(SELECT 1 FROM public.workout_results AS other_result WHERE other_result.training_session_id=v_session.id AND other_result.id<>v_result.id) OR NOT private.can_act_for_training_session(v_session.id) THEN RAISE EXCEPTION 'Workout feedback is unavailable' USING ERRCODE='42501'; END IF;
 IF p_q1_response_state='selected' THEN
  SELECT count(*) INTO v_attempt_count FROM public.workout_session_attempts AS attempt WHERE attempt.workout_result_id=v_result.id AND attempt.training_session_id=v_session.id AND attempt.athlete_id=v_session.athlete_id AND attempt.athlete_user_id IS NOT DISTINCT FROM v_session.athlete_user_id AND attempt.finalization_state='finalized_completed';
  IF v_attempt_count<>1 OR NOT EXISTS(SELECT 1 FROM private.resolve_training_session_performed_prescription(v_session.id) AS prescription,LATERAL jsonb_array_elements(prescription.steps) AS step(value) WHERE step.value->>'workout_exercise_id'=p_selected_workout_exercise_id::text) OR NOT EXISTS(SELECT 1 FROM public.workout_session_attempts AS attempt JOIN public.workout_session_events AS event ON event.session_id=attempt.training_session_id AND event.attempt_id=attempt.id WHERE attempt.workout_result_id=v_result.id AND attempt.training_session_id=v_session.id AND attempt.athlete_id=v_session.athlete_id AND attempt.athlete_user_id IS NOT DISTINCT FROM v_session.athlete_user_id AND attempt.finalization_state='finalized_completed' AND event.event_type='exercise_completed' AND event.workout_exercise_id=p_selected_workout_exercise_id) THEN RAISE EXCEPTION 'Selected exercise is unavailable'; END IF;
  SELECT step.value->>'exercise_name' INTO v_label FROM private.resolve_training_session_performed_prescription(v_session.id) AS prescription,LATERAL jsonb_array_elements(prescription.steps) AS step(value) WHERE step.value->>'workout_exercise_id'=p_selected_workout_exercise_id::text;
 END IF;
 INSERT INTO public.workout_result_feedback(workout_result_id,submitted_by_profile_id,q1_response_state,selected_workout_exercise_id,coach_note) VALUES(v_result.id,v_actor,p_q1_response_state,p_selected_workout_exercise_id,v_note) ON CONFLICT ON CONSTRAINT workout_result_feedback_workout_result_id_key DO NOTHING RETURNING * INTO v_feedback;
 IF FOUND THEN RETURN QUERY SELECT v_feedback.id,v_feedback.workout_result_id,v_feedback.q1_response_state,v_feedback.selected_workout_exercise_id,v_label,v_feedback.coach_note,v_feedback.created_at,false; RETURN; END IF;
 SELECT feedback.* INTO v_feedback FROM public.workout_result_feedback AS feedback WHERE feedback.workout_result_id=v_result.id;
 IF NOT FOUND OR v_feedback.submitted_by_profile_id IS DISTINCT FROM v_actor OR v_feedback.q1_response_state IS DISTINCT FROM p_q1_response_state OR v_feedback.selected_workout_exercise_id IS DISTINCT FROM p_selected_workout_exercise_id OR v_feedback.coach_note IS DISTINCT FROM v_note THEN RAISE EXCEPTION 'Workout feedback has already been submitted' USING ERRCODE='23505'; END IF;
 IF v_feedback.selected_workout_exercise_id IS NOT NULL THEN SELECT step.value->>'exercise_name' INTO v_label FROM private.resolve_training_session_performed_prescription(v_session.id) AS prescription,LATERAL jsonb_array_elements(prescription.steps) AS step(value) WHERE step.value->>'workout_exercise_id'=v_feedback.selected_workout_exercise_id::text; END IF;
 RETURN QUERY SELECT v_feedback.id,v_feedback.workout_result_id,v_feedback.q1_response_state,v_feedback.selected_workout_exercise_id,v_label,v_feedback.coach_note,v_feedback.created_at,true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_my_workout_feedback(p_workout_result_id uuid)
RETURNS TABLE(feedback_id uuid,workout_result_id uuid,q1_response_state text,selected_workout_exercise_id uuid,selected_exercise_label text,coach_note text,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_actor uuid:=(SELECT auth.uid()); v_result public.workout_results%ROWTYPE; v_session public.training_sessions%ROWTYPE;
BEGIN
 IF v_actor IS NULL OR p_workout_result_id IS NULL THEN RAISE EXCEPTION 'Workout feedback is unavailable' USING ERRCODE='42501'; END IF;
 SELECT result.* INTO v_result FROM public.workout_results AS result WHERE result.id=p_workout_result_id; IF NOT FOUND THEN RAISE EXCEPTION 'Workout feedback is unavailable' USING ERRCODE='42501'; END IF;
 SELECT session.* INTO v_session FROM public.training_sessions AS session WHERE session.id=v_result.training_session_id;
 IF NOT FOUND OR v_session.athlete_id IS NULL OR v_result.athlete_id IS DISTINCT FROM v_session.athlete_id OR v_result.athlete_user_id IS DISTINCT FROM v_session.athlete_user_id OR EXISTS(SELECT 1 FROM public.workout_results AS other_result WHERE other_result.training_session_id=v_session.id AND other_result.id<>v_result.id) OR NOT private.can_view_athlete_workout_feedback(v_session.athlete_id) THEN RAISE EXCEPTION 'Workout feedback is unavailable' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT feedback.id,feedback.workout_result_id,feedback.q1_response_state,feedback.selected_workout_exercise_id,CASE WHEN feedback.selected_workout_exercise_id IS NULL THEN NULL ELSE (SELECT step.value->>'exercise_name' FROM private.resolve_training_session_performed_prescription(v_session.id) AS prescription,LATERAL jsonb_array_elements(prescription.steps) AS step(value) WHERE step.value->>'workout_exercise_id'=feedback.selected_workout_exercise_id::text) END,feedback.coach_note,feedback.created_at FROM public.workout_result_feedback AS feedback WHERE feedback.workout_result_id=v_result.id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.list_my_workout_feedback_exercise_options(p_workout_result_id uuid)
RETURNS TABLE(workout_exercise_id uuid,exercise_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_actor uuid:=(SELECT auth.uid()); v_result public.workout_results%ROWTYPE; v_session public.training_sessions%ROWTYPE; v_attempt_count integer;
BEGIN
 IF v_actor IS NULL OR p_workout_result_id IS NULL THEN RAISE EXCEPTION 'Workout feedback is unavailable' USING ERRCODE='42501'; END IF;
 SELECT result.* INTO v_result FROM public.workout_results AS result WHERE result.id=p_workout_result_id; IF NOT FOUND THEN RAISE EXCEPTION 'Workout feedback is unavailable' USING ERRCODE='42501'; END IF;
 SELECT session.* INTO v_session FROM public.training_sessions AS session WHERE session.id=v_result.training_session_id;
 IF NOT FOUND OR v_session.athlete_id IS NULL OR v_session.status IS DISTINCT FROM 'completed'::public.training_session_status OR v_result.athlete_id IS DISTINCT FROM v_session.athlete_id OR v_result.athlete_user_id IS DISTINCT FROM v_session.athlete_user_id OR EXISTS(SELECT 1 FROM public.workout_results AS other_result WHERE other_result.training_session_id=v_session.id AND other_result.id<>v_result.id) OR NOT private.can_act_for_training_session(v_session.id) THEN RAISE EXCEPTION 'Workout feedback is unavailable' USING ERRCODE='42501'; END IF;
 SELECT count(*) INTO v_attempt_count FROM public.workout_session_attempts AS attempt WHERE attempt.workout_result_id=v_result.id AND attempt.training_session_id=v_session.id AND attempt.athlete_id=v_session.athlete_id AND attempt.athlete_user_id IS NOT DISTINCT FROM v_session.athlete_user_id AND attempt.finalization_state='finalized_completed'; IF v_attempt_count<>1 THEN RAISE EXCEPTION 'Workout feedback is unavailable' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM private.resolve_training_session_performed_prescription(v_session.id) AS prescription,LATERAL jsonb_array_elements(prescription.steps) AS step(value) WHERE jsonb_typeof(step.value->'workout_exercise_id') IS DISTINCT FROM 'string' OR (step.value->>'workout_exercise_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR jsonb_typeof(step.value->'position') IS DISTINCT FROM 'number' OR (step.value->>'position') !~ '^(0|[1-9][0-9]*)$' OR char_length(step.value->>'position')>10 OR (char_length(step.value->>'position')=10 AND step.value->>'position'>'2147483647') OR jsonb_typeof(step.value->'exercise_name') IS DISTINCT FROM 'string' OR btrim(step.value->>'exercise_name')='') OR EXISTS(SELECT 1 FROM private.resolve_training_session_performed_prescription(v_session.id) AS prescription,LATERAL jsonb_array_elements(prescription.steps) AS step(value) GROUP BY step.value->>'workout_exercise_id' HAVING count(*)<>1) OR EXISTS(SELECT 1 FROM private.resolve_training_session_performed_prescription(v_session.id) AS prescription,LATERAL jsonb_array_elements(prescription.steps) AS step(value) GROUP BY step.value->>'position' HAVING count(*)<>1) THEN RAISE EXCEPTION 'Workout feedback is unavailable' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT (step.value->>'workout_exercise_id')::uuid,step.value->>'exercise_name' FROM private.resolve_training_session_performed_prescription(v_session.id) AS prescription,LATERAL jsonb_array_elements(prescription.steps) AS step(value) WHERE EXISTS(SELECT 1 FROM public.workout_session_attempts AS attempt JOIN public.workout_session_events AS event ON event.session_id=attempt.training_session_id AND event.attempt_id=attempt.id WHERE attempt.workout_result_id=v_result.id AND attempt.training_session_id=v_session.id AND attempt.athlete_id=v_session.athlete_id AND attempt.athlete_user_id IS NOT DISTINCT FROM v_session.athlete_user_id AND attempt.finalization_state='finalized_completed' AND event.event_type='exercise_completed' AND event.workout_exercise_id=(step.value->>'workout_exercise_id')::uuid) ORDER BY (step.value->>'position')::integer;
END;
$function$;

CREATE OR REPLACE FUNCTION public.list_my_team_athlete_workout_feedback(p_team_id uuid,p_athlete_id uuid)
RETURNS TABLE(scheduled_date date,workout_name text,q1_response_state text,selected_exercise_label text,coach_note text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_actor uuid:=(SELECT auth.uid());
BEGIN
 IF v_actor IS NULL OR p_team_id IS NULL OR p_athlete_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.team_staff_memberships AS staff JOIN public.team_athlete_memberships AS roster ON roster.team_id=staff.team_id WHERE staff.team_id=p_team_id AND staff.profile_id=v_actor AND roster.athlete_id=p_athlete_id) THEN RAISE EXCEPTION 'Athlete feedback is not available' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT session.scheduled_date,prescription.workout_name,feedback.q1_response_state,CASE WHEN feedback.selected_workout_exercise_id IS NULL THEN NULL ELSE (SELECT step.value->>'exercise_name' FROM jsonb_array_elements(prescription.steps) AS step(value) WHERE step.value->>'workout_exercise_id'=feedback.selected_workout_exercise_id::text) END,feedback.coach_note FROM public.workout_result_feedback AS feedback JOIN public.workout_results AS result ON result.id=feedback.workout_result_id JOIN public.training_sessions AS session ON session.id=result.training_session_id JOIN LATERAL private.resolve_training_session_performed_prescription(session.id) AS prescription ON true WHERE session.team_id=p_team_id AND session.athlete_id=p_athlete_id AND result.athlete_id=p_athlete_id AND result.athlete_user_id IS NOT DISTINCT FROM session.athlete_user_id AND NOT EXISTS(SELECT 1 FROM public.workout_results AS other_result WHERE other_result.training_session_id=session.id AND other_result.id<>result.id) ORDER BY session.scheduled_date DESC,feedback.created_at DESC;
END;
$function$;

ALTER FUNCTION public.submit_my_workout_feedback(uuid,text,uuid,text) OWNER TO postgres;
ALTER FUNCTION public.get_my_workout_feedback(uuid) OWNER TO postgres;
ALTER FUNCTION public.list_my_workout_feedback_exercise_options(uuid) OWNER TO postgres;
ALTER FUNCTION public.list_my_team_athlete_workout_feedback(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.submit_my_workout_feedback(uuid,text,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.get_my_workout_feedback(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.list_my_workout_feedback_exercise_options(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.list_my_team_athlete_workout_feedback(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.submit_my_workout_feedback(uuid,text,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_workout_feedback(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_my_workout_feedback_exercise_options(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_my_team_athlete_workout_feedback(uuid,uuid) TO authenticated;

COMMIT;
