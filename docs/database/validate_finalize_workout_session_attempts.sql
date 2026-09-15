-- Phase 8B rollback-only smoke validation. Run as a privileged database role.
-- It selects one athlete-owned, scheduled session with a V1 prescription and no
-- result/events, then creates all fixture rows inside this transaction.
BEGIN;

CREATE TEMP TABLE phase8b_validation_results (
  check_name text PRIMARY KEY,
  passed boolean NOT NULL
) ON COMMIT DROP;

DO $test$
DECLARE
  athlete uuid; other_user uuid; sid uuid; step_id uuid; step_position integer; work_ms bigint;
  clean_attempt uuid:=gen_random_uuid(); malformed_attempt uuid:=gen_random_uuid(); result_id uuid;
  finalized public.workout_session_attempts; denied boolean;
BEGIN
  SELECT ts.athlete_user_id,ts.id,(tsp.steps->0->>'workout_exercise_id')::uuid,
         (tsp.steps->0->>'position')::integer,(tsp.steps->0->>'work_ms')::bigint
    INTO athlete,sid,step_id,step_position,work_ms
  FROM public.training_sessions ts
  JOIN public.training_session_prescriptions tsp ON tsp.session_id=ts.id
  WHERE ts.status='scheduled'
    AND NOT EXISTS (SELECT 1 FROM public.workout_results wr WHERE wr.training_session_id=ts.id)
    AND NOT EXISTS (SELECT 1 FROM public.workout_session_events e WHERE e.session_id=ts.id)
    AND jsonb_array_length(tsp.steps)>0
  ORDER BY ts.scheduled_date,ts.id
  LIMIT 1;
  IF athlete IS NULL OR sid IS NULL OR step_id IS NULL OR work_ms IS NULL THEN
    RAISE EXCEPTION 'Phase 8B validation requires an unused scheduled athlete session with a V1 prescription';
  END IF;
  SELECT id INTO other_user FROM auth.users WHERE id<>athlete ORDER BY id LIMIT 1;
  IF other_user IS NULL THEN RAISE EXCEPTION 'Phase 8B validation requires a second auth user'; END IF;

  PERFORM set_config('request.jwt.claim.sub',athlete::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at)
  VALUES(gen_random_uuid(),sid,clean_attempt,0,'workout_started','ready',0,clock_timestamp());
  INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,workout_exercise_id,step_position,phase,phase_duration_ms,phase_elapsed_ms,elapsed_ms,occurred_at)
  VALUES(gen_random_uuid(),sid,clean_attempt,1,'exercise_started',step_id,step_position,'work',work_ms,0,0,clock_timestamp()),
        (gen_random_uuid(),sid,clean_attempt,2,'exercise_completed',step_id,step_position,'work',work_ms,work_ms,work_ms,clock_timestamp());
  PERFORM public.register_my_workout_session_attempt(clean_attempt,sid);
  EXECUTE 'RESET ROLE';

  INSERT INTO public.workout_results(training_session_id,athlete_user_id,started_at,completed_at,active_minutes,total_duration_minutes,exercises_completed,result_data)
  VALUES(sid,athlete,clock_timestamp(),clock_timestamp(),0,0,1,'{}'::jsonb)
  RETURNING id INTO result_id;

  PERFORM set_config('request.jwt.claim.sub',athlete::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at)
  VALUES(gen_random_uuid(),sid,clean_attempt,3,'workout_completed','finished',work_ms,clock_timestamp());
  PERFORM public.finalize_my_workout_session_attempt(clean_attempt);
  PERFORM public.finalize_my_workout_session_attempt(clean_attempt);
  EXECUTE 'RESET ROLE';

  SELECT * INTO finalized FROM public.workout_session_attempts WHERE id=clean_attempt;
  IF finalized.finalization_state<>'finalized_completed'
    OR finalized.workout_result_id<>result_id
    OR finalized.first_sequence<>0 OR finalized.last_sequence<>3 OR finalized.event_count<>4
    OR finalized.elapsed_attempt_ms<>work_ms OR finalized.explicit_pause_ms<>0 OR finalized.hidden_ms<>0
    OR finalized.work_timer_progressed_ms IS NOT NULL OR finalized.rest_timer_progressed_ms IS NOT NULL
    OR finalized.completed_work_blocks<>1 OR finalized.skipped_work_blocks<>0
    OR finalized.completed_rest_blocks<>0 OR finalized.skipped_rest_blocks<>0
    OR finalized.measurement_version<>1 OR finalized.measurement_quality<>'complete' THEN
    RAISE EXCEPTION 'Clean finalization materialized unexpected values';
  END IF;
  INSERT INTO phase8b_validation_results VALUES
    ('clean registration/finalization, values, known zeros, NULL progress, idempotent retry',true);

  PERFORM set_config('request.jwt.claim.sub',athlete::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  denied:=false;
  BEGIN
    INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,workout_exercise_id,step_position,phase,phase_duration_ms,phase_elapsed_ms,elapsed_ms,occurred_at)
    VALUES(gen_random_uuid(),sid,clean_attempt,4,'page_visible',step_id,step_position,'work',work_ms,work_ms,work_ms,clock_timestamp());
  EXCEPTION WHEN OTHERS THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Late logical event was accepted after finalization'; END IF;
  EXECUTE 'RESET ROLE';
  INSERT INTO phase8b_validation_results VALUES ('late logical event rejected after finalization',true);

  PERFORM set_config('request.jwt.claim.sub',athlete::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at)
  VALUES(gen_random_uuid(),sid,malformed_attempt,0,'workout_started','ready',0,clock_timestamp());
  PERFORM public.register_my_workout_session_attempt(malformed_attempt,sid);
  denied:=false;
  BEGIN PERFORM public.finalize_my_workout_session_attempt(malformed_attempt);
  EXCEPTION WHEN OTHERS THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Malformed incomplete attempt finalized'; END IF;
  EXECUTE 'RESET ROLE';
  INSERT INTO phase8b_validation_results VALUES ('malformed incomplete attempt rejected',true);

  PERFORM set_config('request.jwt.claim.sub',other_user::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  denied:=false;
  BEGIN PERFORM public.register_my_workout_session_attempt(malformed_attempt,sid);
  EXCEPTION WHEN OTHERS THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Foreign athlete registered another athlete attempt'; END IF;
  EXECUTE 'RESET ROLE';
  INSERT INTO phase8b_validation_results VALUES ('athlete identity isolation enforced',true);
END;
$test$;

SELECT check_name,passed FROM phase8b_validation_results ORDER BY check_name;
ROLLBACK;
