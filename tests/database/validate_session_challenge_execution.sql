-- Phase 18B validator. Execute only after the complete tracked migration chain
-- on a disposable local Supabase/Postgres database. All fixtures roll back.
BEGIN;

DO $validation$
DECLARE
  v_coach uuid := gen_random_uuid();
  v_self uuid := gen_random_uuid();
  v_guardian uuid := gen_random_uuid();
  v_revoked_guardian uuid := gen_random_uuid();
  v_unrelated_profile uuid := gen_random_uuid();
  v_assigned_self uuid := gen_random_uuid();
  v_athlete uuid := gen_random_uuid();
  v_assigned_athlete uuid := gen_random_uuid();
  v_team uuid := gen_random_uuid();
  v_plan uuid := gen_random_uuid();
  v_item uuid := gen_random_uuid();
  v_base uuid := gen_random_uuid();
  v_challenge uuid := gen_random_uuid();
  v_base_exercise uuid := gen_random_uuid();
  v_challenge_exercise uuid := gen_random_uuid();
  v_base_step uuid := gen_random_uuid();
  v_challenge_step uuid := gen_random_uuid();
  v_challenge_session uuid := gen_random_uuid();
  v_unselected_session uuid := gen_random_uuid();
  v_plain_session uuid := gen_random_uuid();
  v_assigned_session uuid := gen_random_uuid();
  v_bypass_session uuid := gen_random_uuid();
  v_challenge_attempt uuid := gen_random_uuid();
  v_assigned_attempt uuid := gen_random_uuid();
  v_unselected_attempt uuid := gen_random_uuid();
  v_plain_attempt uuid := gen_random_uuid();
  v_challenge_result uuid;
  v_assigned_result uuid;
  v_plain_result uuid;
  v_unselected_result uuid;
  v_denied boolean := false;
  v_assigned_snapshot jsonb;
  v_challenge_snapshot jsonb;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES
    (v_coach,'authenticated','authenticated','phase18b-coach@example.invalid','{}','{}',clock_timestamp(),clock_timestamp()),
    (v_self,'authenticated','authenticated','phase18b-self@example.invalid','{}','{}',clock_timestamp(),clock_timestamp()),
    (v_guardian,'authenticated','authenticated','phase18b-guardian@example.invalid','{}','{}',clock_timestamp(),clock_timestamp()),
    (v_revoked_guardian,'authenticated','authenticated','phase18b-revoked@example.invalid','{}','{}',clock_timestamp(),clock_timestamp()),
    (v_unrelated_profile,'authenticated','authenticated','phase18b-unrelated@example.invalid','{}','{}',clock_timestamp(),clock_timestamp()),
    (v_assigned_self,'authenticated','authenticated','phase18b-assigned@example.invalid','{}','{}',clock_timestamp(),clock_timestamp());
  INSERT INTO public.athletes(id,display_name,created_by_profile_id) VALUES
    (v_athlete,'Phase18B Challenge athlete',v_coach),
    (v_assigned_athlete,'Phase18B Assigned athlete',v_coach);
  INSERT INTO public.athlete_profile_relationships(athlete_id,profile_id,role,training_permission,manage_permission,created_by_profile_id) VALUES
    (v_athlete,v_self,'self',true,true,v_coach),
    (v_athlete,v_guardian,'guardian',true,false,v_coach),
    (v_assigned_athlete,v_assigned_self,'self',true,true,v_coach);
  INSERT INTO public.athlete_profile_relationships(athlete_id,profile_id,role,training_permission,manage_permission,revoked_at,created_by_profile_id) VALUES
    (v_athlete,v_revoked_guardian,'guardian',true,false,clock_timestamp() + interval '1 second',v_coach);
  INSERT INTO public.teams(id,name,created_by_user_id) VALUES(v_team,'Phase18B validator',v_coach);
  INSERT INTO public.team_staff_memberships(team_id,profile_id,role,created_by_profile_id) VALUES(v_team,v_coach,'coach',v_coach);
  INSERT INTO public.team_athlete_memberships(team_id,athlete_id,created_by_profile_id) VALUES(v_team,v_athlete,v_coach),(v_team,v_assigned_athlete,v_coach);
  INSERT INTO public.exercises(id,name) VALUES(v_base_exercise,'Assigned only'),(v_challenge_exercise,'Challenge only');
  INSERT INTO public.workouts(id,name,visibility,owner_user_id) VALUES
    (v_base,'Phase18B Assigned','private',v_coach),
    (v_challenge,'Phase18B Challenge','private',v_coach);
  INSERT INTO public.workout_exercises(id,workout_id,exercise_id,position,duration_seconds,rest_seconds,exercise_snapshot) VALUES
    (v_base_step,v_base,v_base_exercise,0,10,0,jsonb_build_object('exercise_name','Assigned only')),
    (v_challenge_step,v_challenge,v_challenge_exercise,0,20,0,jsonb_build_object('exercise_name','Challenge only'));
  INSERT INTO public.training_plans(id,name,team_id,owner_user_id,status,kind,visibility) VALUES(v_plan,'Phase18B plan',v_team,v_coach,'active','coach','private');
  PERFORM set_config('request.jwt.claim.sub',v_coach::text,true);
  INSERT INTO public.training_plan_items(id,training_plan_id,workout_id,challenge_workout_id,day_offset,position) VALUES(v_item,v_plan,v_base,v_challenge,0,0);
  INSERT INTO public.training_sessions(id,plan_item_id,athlete_id,coach_user_id,team_id,workout_id,scheduled_date,status) VALUES
    (v_challenge_session,v_item,v_athlete,v_coach,v_team,v_base,current_date,'scheduled'),
    (v_unselected_session,v_item,v_athlete,v_coach,v_team,v_base,current_date,'scheduled'),
    (v_bypass_session,v_item,v_athlete,v_coach,v_team,v_base,current_date,'scheduled'),
    (v_assigned_session,v_item,v_assigned_athlete,v_coach,v_team,v_base,current_date,'scheduled'),
    (v_plain_session,NULL,v_assigned_athlete,v_coach,v_team,v_base,current_date,'scheduled');
  SELECT steps INTO v_assigned_snapshot FROM public.training_session_prescriptions WHERE session_id=v_challenge_session;
  SELECT steps INTO v_challenge_snapshot FROM public.training_session_challenge_prescriptions WHERE session_id=v_challenge_session;
  IF v_assigned_snapshot IS NULL OR v_challenge_snapshot IS NULL THEN RAISE EXCEPTION 'Phase18B fixture snapshots missing'; END IF;
  UPDATE public.workout_exercises SET duration_seconds=99 WHERE id=v_challenge_step;
  IF (SELECT steps FROM public.training_session_prescriptions WHERE session_id=v_challenge_session) IS DISTINCT FROM v_assigned_snapshot OR (SELECT steps FROM public.training_session_challenge_prescriptions WHERE session_id=v_challenge_session) IS DISTINCT FROM v_challenge_snapshot THEN RAISE EXCEPTION 'source edit rewrote immutable snapshot'; END IF;

  PERFORM set_config('request.jwt.claim.sub',v_self::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.select_my_training_session_variant(v_challenge_session,'challenge');
  IF NOT EXISTS(SELECT 1 FROM private.performed_training_session_prescription(v_challenge_session) WHERE selected_variant='challenge' AND source_workout_id=v_challenge AND prescribed_work_ms=20000 AND step_count=1) THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'Challenge resolver did not select immutable Challenge snapshot'; END IF;
  v_denied:=false; BEGIN PERFORM public.complete_my_training_session(v_challenge_session); EXCEPTION WHEN others THEN v_denied:=true; END;
  IF NOT v_denied THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'Challenge completed without a performed attempt'; END IF;
  INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at) VALUES(gen_random_uuid(),v_challenge_session,v_challenge_attempt,0,'workout_started','ready',0,clock_timestamp());
  PERFORM public.register_my_workout_session_attempt(v_challenge_attempt,v_challenge_session);
  IF NOT EXISTS(SELECT 1 FROM public.workout_session_attempts WHERE id=v_challenge_attempt AND prescribed_work_ms=20000 AND prescribed_step_count=1) THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'Challenge attempt did not bind Challenge aggregates'; END IF;
  v_denied:=false; BEGIN INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,workout_exercise_id,step_position,phase,phase_duration_ms,phase_elapsed_ms,elapsed_ms,occurred_at) VALUES(gen_random_uuid(),v_challenge_session,v_challenge_attempt,1,'exercise_started',v_base_step,0,'work',10000,0,0,clock_timestamp()); EXCEPTION WHEN others THEN v_denied:=true; END;
  IF NOT v_denied THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'Assigned-only event was accepted for Challenge'; END IF;
  PERFORM public.complete_my_training_session(v_challenge_session);
  INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,workout_exercise_id,step_position,phase,phase_duration_ms,phase_elapsed_ms,elapsed_ms,occurred_at) VALUES
    (gen_random_uuid(),v_challenge_session,v_challenge_attempt,1,'exercise_started',v_challenge_step,0,'work',20000,0,0,clock_timestamp()),
    (gen_random_uuid(),v_challenge_session,v_challenge_attempt,2,'exercise_completed',v_challenge_step,0,'work',20000,20000,20000,clock_timestamp()),
    (gen_random_uuid(),v_challenge_session,v_challenge_attempt,3,'workout_completed',NULL,NULL,'finished',NULL,NULL,20000,clock_timestamp());
  PERFORM public.finalize_my_workout_session_attempt(v_challenge_attempt);
  IF NOT EXISTS(SELECT 1 FROM public.workout_session_attempts WHERE id=v_challenge_attempt AND finalization_state='finalized_completed' AND prescribed_work_ms=20000 AND completed_work_blocks=1 AND measurement_quality='complete') OR NOT EXISTS(SELECT 1 FROM public.workout_results WHERE training_session_id=v_challenge_session AND result_data->>'performed_variant'='challenge' AND result_data->>'workout_name'='Phase18B Challenge') OR NOT EXISTS(SELECT 1 FROM public.athlete_exercise_familiarity WHERE athlete_id=v_athlete AND exercise_id=v_challenge_exercise) OR EXISTS(SELECT 1 FROM public.athlete_exercise_familiarity WHERE athlete_id=v_athlete AND exercise_id=v_base_exercise) THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'Challenge finalization, result, Measurement, or familiarity is inconsistent'; END IF;
  SELECT id INTO v_challenge_result FROM public.workout_results WHERE training_session_id=v_challenge_session;
  IF NOT EXISTS(SELECT 1 FROM public.list_my_workout_feedback_exercise_options(v_challenge_result) AS option_row WHERE option_row.workout_exercise_id=v_challenge_step AND option_row.exercise_name='Challenge only') OR EXISTS(SELECT 1 FROM public.list_my_workout_feedback_exercise_options(v_challenge_result) AS option_row WHERE option_row.workout_exercise_id=v_base_step) THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'Challenge feedback options did not use the performed snapshot'; END IF;
  v_denied:=false; BEGIN PERFORM * FROM public.submit_my_workout_feedback(v_challenge_result,'selected',v_base_step,NULL); EXCEPTION WHEN others THEN v_denied:=true; END;
  IF NOT v_denied THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'Assigned-only feedback selection was accepted for Challenge'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.submit_my_workout_feedback(v_challenge_result,'selected',v_challenge_step,NULL) AS feedback_row WHERE feedback_row.selected_exercise_label='Challenge only' AND NOT feedback_row.already_submitted) OR NOT EXISTS(SELECT 1 FROM public.get_my_workout_feedback(v_challenge_result) AS feedback_row WHERE feedback_row.selected_workout_exercise_id=v_challenge_step AND feedback_row.selected_exercise_label='Challenge only') THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'Challenge feedback submission or label did not use the performed snapshot'; END IF;
  EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claim.sub',v_guardian::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  IF NOT EXISTS(SELECT 1 FROM public.get_my_workout_feedback(v_challenge_result) AS feedback_row WHERE feedback_row.selected_workout_exercise_id=v_challenge_step AND feedback_row.selected_exercise_label='Challenge only') THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'active guardian feedback read changed'; END IF;
  EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claim.sub',v_revoked_guardian::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  v_denied:=false; BEGIN PERFORM * FROM public.get_my_workout_feedback(v_challenge_result); EXCEPTION WHEN others THEN v_denied:=true; END;
  IF NOT v_denied THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'revoked guardian feedback read succeeded'; END IF;
  EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claim.sub',v_coach::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  IF NOT EXISTS(SELECT 1 FROM public.list_my_team_athlete_workout_feedback(v_team,v_athlete) AS feedback_row WHERE feedback_row.workout_name='Phase18B Challenge' AND feedback_row.selected_exercise_label='Challenge only') THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'same-team staff feedback history did not use performed snapshot'; END IF;
  EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claim.sub',v_unrelated_profile::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  v_denied:=false; BEGIN PERFORM * FROM public.list_my_team_athlete_workout_feedback(v_team,v_athlete); EXCEPTION WHEN others THEN v_denied:=true; END;
  IF NOT v_denied THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'unrelated profile read team feedback'; END IF;
  EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claim.sub',v_self::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  v_denied:=false; BEGIN PERFORM public.select_my_training_session_variant(v_challenge_session,'assigned'); EXCEPTION WHEN others THEN v_denied:=true; END;
  IF NOT v_denied THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'Challenge attempt did not lock selection'; END IF;
  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub',v_self::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.select_my_training_session_variant(v_bypass_session,'challenge');
  v_denied:=false; BEGIN INSERT INTO public.workout_results(training_session_id,athlete_id,completed_at,active_minutes,total_duration_minutes,exercises_completed,result_data) VALUES(v_bypass_session,v_athlete,clock_timestamp(),1,1,1,'{}'); EXCEPTION WHEN others THEN v_denied:=true; END;
  IF NOT v_denied THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'direct Challenge result insert succeeded'; END IF;
  EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claim.sub',v_coach::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  v_denied:=false; BEGIN UPDATE public.training_sessions SET status='completed' WHERE id=v_bypass_session; EXCEPTION WHEN others THEN v_denied:=true; END;
  IF NOT v_denied THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'direct Challenge status completion succeeded'; END IF;
  v_denied:=false; BEGIN UPDATE public.training_sessions SET completed_at=clock_timestamp() WHERE id=v_bypass_session; EXCEPTION WHEN others THEN v_denied:=true; END;
  IF NOT v_denied THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'direct Challenge timestamp completion succeeded'; END IF;
  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub',v_self::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  IF NOT EXISTS(SELECT 1 FROM private.performed_training_session_prescription(v_unselected_session) WHERE selected_variant='assigned' AND source_workout_id=v_base AND prescribed_work_ms=10000) THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'unselected Challenge session did not resolve Assigned'; END IF;
  INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at) VALUES(gen_random_uuid(),v_unselected_session,v_unselected_attempt,0,'workout_started','ready',0,clock_timestamp());
  PERFORM public.register_my_workout_session_attempt(v_unselected_attempt,v_unselected_session);
  IF NOT EXISTS(SELECT 1 FROM public.workout_session_attempts WHERE id=v_unselected_attempt AND prescribed_work_ms=10000) THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'unselected Challenge session did not execute Assigned'; END IF;
  PERFORM public.complete_my_training_session(v_unselected_session);
  INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,workout_exercise_id,step_position,phase,phase_duration_ms,phase_elapsed_ms,elapsed_ms,occurred_at) VALUES
    (gen_random_uuid(),v_unselected_session,v_unselected_attempt,1,'exercise_started',v_base_step,0,'work',10000,0,0,clock_timestamp()),
    (gen_random_uuid(),v_unselected_session,v_unselected_attempt,2,'exercise_completed',v_base_step,0,'work',10000,10000,10000,clock_timestamp()),
    (gen_random_uuid(),v_unselected_session,v_unselected_attempt,3,'workout_completed',NULL,NULL,'finished',NULL,NULL,10000,clock_timestamp());
  PERFORM public.finalize_my_workout_session_attempt(v_unselected_attempt);
  SELECT id INTO v_unselected_result FROM public.workout_results WHERE training_session_id=v_unselected_session;
  EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claim.sub',v_guardian::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  IF NOT EXISTS(SELECT 1 FROM public.submit_my_workout_feedback(v_unselected_result,'none',NULL,NULL) AS feedback_row WHERE feedback_row.q1_response_state='none' AND NOT feedback_row.already_submitted) THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'active guardian feedback submit changed'; END IF;
  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub',v_assigned_self::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  IF NOT EXISTS(SELECT 1 FROM private.performed_training_session_prescription(v_plain_session) WHERE selected_variant='assigned' AND source_workout_id=v_base) THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'plain legacy-style session did not resolve Assigned'; END IF;
  INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at) VALUES(gen_random_uuid(),v_plain_session,v_plain_attempt,0,'workout_started','ready',0,clock_timestamp());
  PERFORM public.register_my_workout_session_attempt(v_plain_attempt,v_plain_session);
  IF NOT EXISTS(SELECT 1 FROM public.workout_session_attempts WHERE id=v_plain_attempt AND prescribed_work_ms=10000) THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'plain legacy-style session did not execute Assigned'; END IF;
  PERFORM public.complete_my_training_session(v_plain_session);
  INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,workout_exercise_id,step_position,phase,phase_duration_ms,phase_elapsed_ms,elapsed_ms,occurred_at) VALUES
    (gen_random_uuid(),v_plain_session,v_plain_attempt,1,'exercise_started',v_base_step,0,'work',10000,0,0,clock_timestamp()),
    (gen_random_uuid(),v_plain_session,v_plain_attempt,2,'exercise_completed',v_base_step,0,'work',10000,10000,10000,clock_timestamp()),
    (gen_random_uuid(),v_plain_session,v_plain_attempt,3,'workout_completed',NULL,NULL,'finished',NULL,NULL,10000,clock_timestamp());
  PERFORM public.finalize_my_workout_session_attempt(v_plain_attempt);
  SELECT id INTO v_plain_result FROM public.workout_results WHERE training_session_id=v_plain_session;
  IF NOT EXISTS(SELECT 1 FROM public.submit_my_workout_feedback(v_plain_result,'none',NULL,NULL) AS feedback_row WHERE feedback_row.q1_response_state='none' AND feedback_row.selected_workout_exercise_id IS NULL) THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'Assigned none feedback submission changed'; END IF;
  INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at) VALUES(gen_random_uuid(),v_assigned_session,v_assigned_attempt,0,'workout_started','ready',0,clock_timestamp());
  PERFORM public.register_my_workout_session_attempt(v_assigned_attempt,v_assigned_session);
  PERFORM public.complete_my_training_session(v_assigned_session);
  INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,workout_exercise_id,step_position,phase,phase_duration_ms,phase_elapsed_ms,elapsed_ms,occurred_at) VALUES
    (gen_random_uuid(),v_assigned_session,v_assigned_attempt,1,'exercise_started',v_base_step,0,'work',10000,0,0,clock_timestamp()),
    (gen_random_uuid(),v_assigned_session,v_assigned_attempt,2,'exercise_completed',v_base_step,0,'work',10000,10000,10000,clock_timestamp()),
    (gen_random_uuid(),v_assigned_session,v_assigned_attempt,3,'workout_completed',NULL,NULL,'finished',NULL,NULL,10000,clock_timestamp());
  PERFORM public.finalize_my_workout_session_attempt(v_assigned_attempt);
  SELECT id INTO v_assigned_result FROM public.workout_results WHERE training_session_id=v_assigned_session;
  IF NOT EXISTS(SELECT 1 FROM public.list_my_workout_feedback_exercise_options(v_assigned_result) AS option_row WHERE option_row.workout_exercise_id=v_base_step AND option_row.exercise_name='Assigned only') OR EXISTS(SELECT 1 FROM public.list_my_workout_feedback_exercise_options(v_assigned_result) AS option_row WHERE option_row.workout_exercise_id=v_challenge_step) OR NOT EXISTS(SELECT 1 FROM public.submit_my_workout_feedback(v_assigned_result,'selected',v_base_step,NULL) AS feedback_row WHERE feedback_row.selected_exercise_label='Assigned only' AND NOT feedback_row.already_submitted) THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'Assigned feedback behavior changed'; END IF;
  EXECUTE 'RESET ROLE';
END;
$validation$;

ROLLBACK;
