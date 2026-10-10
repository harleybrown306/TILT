-- Disposable-local Phase 14B.2 validation. Every fixture is rolled back.
BEGIN;

DO $validation$
#variable_conflict error
DECLARE
  v_manager uuid;
  v_assistant uuid;
  v_unrelated uuid;
  v_admin uuid;
  v_guardian uuid;
  v_self uuid;
  v_team uuid;
  v_other_team uuid;
  v_empty_team uuid;
  v_athlete uuid := gen_random_uuid();
  v_former uuid := gen_random_uuid();
  v_workout uuid;
  v_exercise uuid;
  v_assigned_step uuid;
  v_challenge_workout uuid;
  v_challenge_exercise_one uuid;
  v_challenge_exercise_two uuid;
  v_challenge_step_one uuid;
  v_challenge_step_two uuid;
  v_challenge_plan uuid := gen_random_uuid();
  v_challenge_plan_item uuid := gen_random_uuid();
  v_challenge_session uuid := gen_random_uuid();
  v_challenge_attempt uuid := gen_random_uuid();
  v_unselected_challenge_session uuid := gen_random_uuid();
  v_unselected_challenge_attempt uuid := gen_random_uuid();
  v_current_session uuid;
  v_current_result uuid;
  v_former_session uuid;
  v_marker text := '14b2-' || replace(gen_random_uuid()::text, '-', '');
  v_as_of date := (transaction_timestamp() AT TIME ZONE 'America/Chicago')::date;
  v_denied boolean := false;
  v_case record;
  v_case_session uuid;
  v_case_result uuid;
BEGIN
  IF to_regprocedure('public.list_my_team_attention_sessions(uuid)') IS NULL THEN
    RAISE EXCEPTION '14B2 attention RPC is missing';
  END IF;
  IF to_regprocedure('public.get_team_attention_as_of_date(uuid)') IS NULL
     OR (SELECT pg_get_function_result('public.get_team_attention_as_of_date(uuid)'::regprocedure)) <> 'date'
     OR NOT (SELECT prosecdef AND provolatile='s' AND pg_get_userbyid(proowner)='postgres' AND coalesce(proconfig, ARRAY[]::text[]) @> ARRAY['search_path=""'] FROM pg_proc WHERE oid='public.get_team_attention_as_of_date(uuid)'::regprocedure)
     OR has_function_privilege('public','public.get_team_attention_as_of_date(uuid)','EXECUTE')
     OR has_function_privilege('anon','public.get_team_attention_as_of_date(uuid)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.get_team_attention_as_of_date(uuid)','EXECUTE') THEN
    RAISE EXCEPTION '14B2 anchor RPC catalog or ACL contract is incorrect';
  END IF;
  IF (SELECT pg_get_function_result('public.list_my_team_attention_sessions(uuid)'::regprocedure)) <>
     'TABLE(as_of_date date, session_id uuid, athlete_id uuid, scheduled_date date, is_cancelled boolean, has_canonical_completion boolean, prescribed_work_ms bigint, adherence_completed_work_blocks integer, adherence_prescribed_work_blocks integer)'
     OR NOT (SELECT prosecdef AND provolatile='s' AND coalesce(proconfig, ARRAY[]::text[]) @> ARRAY['search_path=""'] FROM pg_proc WHERE oid='public.list_my_team_attention_sessions(uuid)'::regprocedure)
     OR has_function_privilege('public','public.list_my_team_attention_sessions(uuid)','EXECUTE')
     OR has_function_privilege('anon','public.list_my_team_attention_sessions(uuid)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.list_my_team_attention_sessions(uuid)','EXECUTE') THEN
    RAISE EXCEPTION '14B2 attention RPC catalog or ACL contract is incorrect';
  END IF;

  INSERT INTO auth.users(id,aud,role,email,confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  SELECT gen_random_uuid(),'authenticated','authenticated',v_marker || '-' || n || '@example.test',clock_timestamp(),'{}','{}',clock_timestamp(),clock_timestamp()
  FROM generate_series(1,6) n;
  SELECT id INTO v_manager FROM public.profiles WHERE id IN (SELECT id FROM auth.users WHERE email=v_marker || '-1@example.test');
  SELECT id INTO v_assistant FROM public.profiles WHERE id IN (SELECT id FROM auth.users WHERE email=v_marker || '-2@example.test');
  SELECT id INTO v_unrelated FROM public.profiles WHERE id IN (SELECT id FROM auth.users WHERE email=v_marker || '-3@example.test');
  SELECT id INTO v_admin FROM public.profiles WHERE id IN (SELECT id FROM auth.users WHERE email=v_marker || '-4@example.test');
  SELECT id INTO v_guardian FROM public.profiles WHERE id IN (SELECT id FROM auth.users WHERE email=v_marker || '-5@example.test');
  SELECT id INTO v_self FROM public.profiles WHERE id IN (SELECT id FROM auth.users WHERE email=v_marker || '-6@example.test');
  UPDATE public.profiles SET platform_role='admin' WHERE id=v_admin;
  INSERT INTO public.teams(name,created_by_user_id) VALUES ('14B2 team',v_manager) RETURNING id INTO v_team;
  INSERT INTO public.teams(name,created_by_user_id) VALUES ('14B2 other',v_manager) RETURNING id INTO v_other_team;
  INSERT INTO public.teams(name,created_by_user_id) VALUES ('14B2 empty',v_manager) RETURNING id INTO v_empty_team;
  INSERT INTO public.team_memberships(team_id,user_id,role,created_by_user_id)
  VALUES (v_team,v_assistant,'assistant_coach',v_manager);
  INSERT INTO public.athletes(id,display_name,created_by_profile_id) VALUES (v_athlete,'Current 14B2',v_manager),(v_former,'Former 14B2',v_manager);
  INSERT INTO public.team_athlete_memberships(team_id,athlete_id,created_by_profile_id) VALUES (v_team,v_athlete,v_manager);
  INSERT INTO public.athlete_profile_relationships(athlete_id,profile_id,role,training_permission,manage_permission,created_by_profile_id)
  VALUES (v_athlete,v_guardian,'guardian',true,true,v_manager),(v_athlete,v_self,'self',true,true,v_manager);
  INSERT INTO public.exercises(name,owner_user_id) VALUES ('14B2 exercise',v_manager) RETURNING id INTO v_exercise;
  INSERT INTO public.workouts(name,owner_user_id) VALUES ('14B2 workout',v_manager) RETURNING id INTO v_workout;
  INSERT INTO public.workout_exercises(workout_id,exercise_id,position,duration_seconds,rest_seconds,exercise_snapshot)
  VALUES (v_workout,v_exercise,0,60,0,jsonb_build_object('exercise_name','14B2 exercise'))
  RETURNING id INTO v_assigned_step;
  INSERT INTO public.exercises(name,owner_user_id) VALUES ('14B2 Challenge one',v_manager)
  RETURNING id INTO v_challenge_exercise_one;
  INSERT INTO public.exercises(name,owner_user_id) VALUES ('14B2 Challenge two',v_manager)
  RETURNING id INTO v_challenge_exercise_two;
  INSERT INTO public.workouts(name,owner_user_id) VALUES ('14B2 Challenge workout',v_manager) RETURNING id INTO v_challenge_workout;
  INSERT INTO public.workout_exercises(workout_id,exercise_id,position,duration_seconds,rest_seconds,exercise_snapshot)
  VALUES (v_challenge_workout,v_challenge_exercise_one,0,90,0,jsonb_build_object('exercise_name','14B2 Challenge one'))
  RETURNING id INTO v_challenge_step_one;
  INSERT INTO public.workout_exercises(workout_id,exercise_id,position,duration_seconds,rest_seconds,exercise_snapshot)
  VALUES (v_challenge_workout,v_challenge_exercise_two,1,90,0,jsonb_build_object('exercise_name','14B2 Challenge two'))
  RETURNING id INTO v_challenge_step_two;
  INSERT INTO public.training_plans(id,name,team_id,owner_user_id,status,kind,visibility)
  VALUES (v_challenge_plan,'14B2 divergent Challenge plan',v_team,v_manager,'active','coach','private');
  PERFORM set_config('request.jwt.claim.sub',v_manager::text,true);
  INSERT INTO public.training_plan_items(id,training_plan_id,workout_id,challenge_workout_id,day_offset,position)
  VALUES (v_challenge_plan_item,v_challenge_plan,v_workout,v_challenge_workout,0,0);
  INSERT INTO public.training_sessions(athlete_id,coach_user_id,team_id,workout_id,scheduled_date,status)
  VALUES (v_athlete,v_manager,v_team,v_workout,v_as_of - 1,'scheduled') RETURNING id INTO v_current_session;
  INSERT INTO public.training_sessions(athlete_id,coach_user_id,team_id,workout_id,scheduled_date,status)
  VALUES (v_former,v_manager,v_team,v_workout,v_as_of - 2,'cancelled') RETURNING id INTO v_former_session;
  -- Use non-trivial Measurement V1 values. The generated snapshot is updated
  -- through its real CHECK constraints, never by disabling them.
  UPDATE public.training_session_prescriptions
  SET step_count=5, steps='[{"n":1},{"n":2},{"n":3},{"n":4},{"n":5}]'::jsonb
  WHERE session_id=v_current_session;
  INSERT INTO public.workout_results(training_session_id,athlete_id) VALUES (v_current_session,v_athlete) RETURNING id INTO v_current_result;
  INSERT INTO public.workout_results(training_session_id,athlete_id) VALUES (v_former_session,v_former);
  INSERT INTO public.workout_session_attempts(
    id,training_session_id,athlete_id,workout_result_id,started_at,finalized_at,
    finalization_state,prescription_schema_version,prescribed_work_ms,prescribed_rest_ms,
    prescribed_total_ms,prescribed_step_count,completed_work_blocks,skipped_work_blocks,
    measurement_version,measurement_quality
  ) VALUES (
    gen_random_uuid(),v_current_session,v_athlete,v_current_result,clock_timestamp(),clock_timestamp(),
    'finalized_completed',1,300000,0,300000,5,3,2,1,'complete'
  );
  -- An extra session/athlete attempt that is not result-linked is legitimate
  -- history and must not make the exact linked attempt ambiguous.
  INSERT INTO public.workout_session_attempts(
    id,training_session_id,athlete_id,workout_result_id,started_at,
    finalization_state,prescription_schema_version,prescribed_work_ms,prescribed_rest_ms,
    prescribed_total_ms,prescribed_step_count,completed_work_blocks,skipped_work_blocks,
    measurement_version,measurement_quality
  ) VALUES (
    gen_random_uuid(),v_current_session,v_athlete,NULL,clock_timestamp(),
    'open',1,300000,0,300000,5,0,0,1,'unknown'
  );
  -- Result synchronization records the factual completion; cancellation is the
  -- later operational lifecycle state tested by this validator.
  UPDATE public.training_sessions SET status='cancelled' WHERE id=v_former_session;

  -- A real divergent Challenge execution: Assigned is 60 seconds/one step;
  -- Challenge is 180 seconds/two steps. Both results are canonicalized and
  -- finalized through the normal Phase 18B execution boundary.
  INSERT INTO public.training_sessions(id,plan_item_id,athlete_id,coach_user_id,team_id,workout_id,scheduled_date,status)
  VALUES
    (v_challenge_session,v_challenge_plan_item,v_athlete,v_manager,v_team,v_workout,v_as_of - 4,'scheduled'),
    (v_unselected_challenge_session,v_challenge_plan_item,v_athlete,v_manager,v_team,v_workout,v_as_of - 5,'scheduled');
  IF NOT EXISTS(SELECT 1 FROM private.resolve_training_session_performed_prescription(v_unselected_challenge_session) AS prescription WHERE prescription.selected_variant='assigned' AND prescription.prescribed_work_ms=60000 AND prescription.step_count=1) THEN
    RAISE EXCEPTION '14B2 unselected Challenge fixture did not retain Assigned prescription';
  END IF;
  PERFORM set_config('request.jwt.claim.sub',v_self::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.select_my_training_session_variant(v_challenge_session,'challenge');
  INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at)
  VALUES (gen_random_uuid(),v_challenge_session,v_challenge_attempt,0,'workout_started','ready',0,clock_timestamp());
  PERFORM public.register_my_workout_session_attempt(v_challenge_attempt,v_challenge_session);
  PERFORM public.complete_my_training_session(v_challenge_session);
  INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,workout_exercise_id,step_position,phase,phase_duration_ms,phase_elapsed_ms,elapsed_ms,occurred_at)
  VALUES
    (gen_random_uuid(),v_challenge_session,v_challenge_attempt,1,'exercise_started',v_challenge_step_one,0,'work',90000,0,0,clock_timestamp()),
    (gen_random_uuid(),v_challenge_session,v_challenge_attempt,2,'exercise_completed',v_challenge_step_one,0,'work',90000,90000,90000,clock_timestamp()),
    (gen_random_uuid(),v_challenge_session,v_challenge_attempt,3,'exercise_started',v_challenge_step_two,1,'work',90000,0,90000,clock_timestamp()),
    (gen_random_uuid(),v_challenge_session,v_challenge_attempt,4,'exercise_completed',v_challenge_step_two,1,'work',90000,90000,180000,clock_timestamp()),
    (gen_random_uuid(),v_challenge_session,v_challenge_attempt,5,'workout_completed',NULL,NULL,'finished',NULL,NULL,180000,clock_timestamp());
  PERFORM public.finalize_my_workout_session_attempt(v_challenge_attempt);
  INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at)
  VALUES (gen_random_uuid(),v_unselected_challenge_session,v_unselected_challenge_attempt,0,'workout_started','ready',0,clock_timestamp());
  PERFORM public.register_my_workout_session_attempt(v_unselected_challenge_attempt,v_unselected_challenge_session);
  PERFORM public.complete_my_training_session(v_unselected_challenge_session);
  INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,workout_exercise_id,step_position,phase,phase_duration_ms,phase_elapsed_ms,elapsed_ms,occurred_at)
  VALUES
    (gen_random_uuid(),v_unselected_challenge_session,v_unselected_challenge_attempt,1,'exercise_started',v_assigned_step,0,'work',60000,0,0,clock_timestamp()),
    (gen_random_uuid(),v_unselected_challenge_session,v_unselected_challenge_attempt,2,'exercise_completed',v_assigned_step,0,'work',60000,60000,60000,clock_timestamp()),
    (gen_random_uuid(),v_unselected_challenge_session,v_unselected_challenge_attempt,3,'workout_completed',NULL,NULL,'finished',NULL,NULL,60000,clock_timestamp());
  PERFORM public.finalize_my_workout_session_attempt(v_unselected_challenge_attempt);
  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub',v_manager::text,true);

  -- Each case is a real bounded session with a valid canonical result and
  -- V1 prescription. Only the selected Measurement V1 predicate differs.
  FOR v_case IN
    SELECT * FROM (VALUES
      ('no_linked_attempt', 'none', 1, 'complete', 5, 3, 2),
      ('non_finalized', 'finalized_incomplete', 1, 'complete', 5, 3, 2),
      ('wrong_version', 'finalized_completed', 2, 'complete', 5, 3, 2),
      ('incomplete_quality', 'finalized_completed', 1, 'partial', 5, 3, 2),
      ('step_mismatch', 'finalized_completed', 1, 'complete', 4, 2, 2),
      ('bad_sum', 'finalized_completed', 1, 'complete', 5, 2, 2)
    ) AS cases(case_name,finalization_state,measurement_version,measurement_quality,prescribed_steps,completed_blocks,skipped_blocks)
  LOOP
    INSERT INTO public.training_sessions(athlete_id,coach_user_id,team_id,workout_id,scheduled_date,status)
    VALUES (v_athlete,v_manager,v_team,v_workout,v_as_of - 3,'scheduled') RETURNING id INTO v_case_session;
    UPDATE public.training_session_prescriptions
    SET step_count=5, steps='[{"n":1},{"n":2},{"n":3},{"n":4},{"n":5}]'::jsonb
    WHERE session_id=v_case_session;
    INSERT INTO public.workout_results(training_session_id,athlete_id)
    VALUES (v_case_session,v_athlete) RETURNING id INTO v_case_result;
    IF v_case.finalization_state <> 'none' THEN
      INSERT INTO public.workout_session_attempts(
        id,training_session_id,athlete_id,workout_result_id,started_at,finalized_at,
        finalization_state,prescription_schema_version,prescribed_work_ms,prescribed_rest_ms,
        prescribed_total_ms,prescribed_step_count,completed_work_blocks,skipped_work_blocks,
        measurement_version,measurement_quality
      ) VALUES (
        gen_random_uuid(),v_case_session,v_athlete,v_case_result,clock_timestamp(),
        CASE WHEN v_case.finalization_state='open' THEN NULL ELSE clock_timestamp() END,
        v_case.finalization_state,1,300000,0,300000,v_case.prescribed_steps,v_case.completed_blocks,v_case.skipped_blocks,
        v_case.measurement_version,v_case.measurement_quality
      );
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.list_my_team_attention_sessions(v_team)
      WHERE session_id=v_case_session AND has_canonical_completion
        AND adherence_completed_work_blocks IS NULL AND adherence_prescribed_work_blocks IS NULL
    ) OR (SELECT count(*) FROM public.list_my_team_attention_sessions(v_team) WHERE session_id=v_case_session) <> 1 THEN
      RAISE EXCEPTION '14B2 Measurement V1 rejection fixture % failed', v_case.case_name;
    END IF;
  END LOOP;
  -- Structural guarantees for malformed states the real schema refuses.
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid='public.workout_session_attempts'::regclass AND conname='workout_session_attempts_metrics_nonnegative' AND convalidated) <> 1
     OR (SELECT count(*) FROM pg_constraint WHERE conrelid='public.training_session_prescriptions'::regclass AND conname='training_session_prescriptions_schema_version_check' AND convalidated) <> 1
     OR (SELECT count(*) FROM pg_constraint WHERE conrelid='public.training_session_prescriptions'::regclass AND conname='training_session_prescriptions_step_count_check' AND convalidated) <> 1 THEN
    RAISE EXCEPTION '14B2 Measurement V1 structural protections are missing';
  END IF;

  PERFORM set_config('request.jwt.claim.sub',v_manager::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  -- The base grant is intentionally present for ACT users; a coach with VIEW
  -- only must nevertheless receive no attempt rows through RLS.
  IF EXISTS (SELECT 1 FROM public.workout_session_attempts WHERE training_session_id=v_current_session) THEN
    RAISE EXCEPTION '14B2 VIEW actor read an ACT-only attempt row';
  END IF;
  IF (SELECT count(*) FROM public.list_my_team_attention_sessions(v_team)) <> 10
     OR EXISTS (SELECT 1 FROM public.list_my_team_attention_sessions(v_team) WHERE as_of_date<>v_as_of)
     OR NOT EXISTS (SELECT 1 FROM public.list_my_team_attention_sessions(v_team) WHERE session_id=v_current_session AND athlete_id=v_athlete AND has_canonical_completion)
     OR NOT EXISTS (SELECT 1 FROM public.list_my_team_attention_sessions(v_team) WHERE session_id=v_former_session AND athlete_id IS NULL AND is_cancelled AND has_canonical_completion)
     OR NOT EXISTS (SELECT 1 FROM public.list_my_team_attention_sessions(v_team) WHERE session_id=v_current_session AND adherence_completed_work_blocks=3 AND adherence_prescribed_work_blocks=5)
     OR NOT EXISTS (SELECT 1 FROM public.list_my_team_attention_sessions(v_team) WHERE session_id=v_challenge_session AND has_canonical_completion AND prescribed_work_ms=180000 AND adherence_completed_work_blocks=2 AND adherence_prescribed_work_blocks=2)
     OR NOT EXISTS (SELECT 1 FROM public.list_my_team_attention_sessions(v_team) WHERE session_id=v_unselected_challenge_session AND has_canonical_completion AND prescribed_work_ms=60000 AND adherence_completed_work_blocks=1 AND adherence_prescribed_work_blocks=1)
     OR EXISTS (SELECT 1 FROM public.list_my_team_attention_sessions(v_team) WHERE (adherence_completed_work_blocks IS NULL) <> (adherence_prescribed_work_blocks IS NULL))
     OR (SELECT count(*) FROM public.list_my_team_attention_sessions(v_team) WHERE session_id=v_current_session) <> 1 THEN
    RAISE EXCEPTION '14B2 bounded identity, completion, cancellation, or N/A projection failed';
  END IF;
  IF (SELECT count(*) FROM public.list_my_team_attention_sessions(v_empty_team)) <> 0
     OR public.get_team_attention_as_of_date(v_empty_team) <> v_as_of THEN
    RAISE EXCEPTION '14B2 empty snapshot did not retain the authorized Chicago anchor';
  END IF;
  PERFORM count(*) FROM public.list_my_team_attention_sessions(v_team);
  PERFORM set_config('request.jwt.claim.sub',v_assistant::text,true);
  PERFORM count(*) FROM public.list_my_team_attention_sessions(v_team);
  PERFORM public.get_team_attention_as_of_date(v_team);
  PERFORM set_config('request.jwt.claim.sub',v_admin::text,true);
  PERFORM count(*) FROM public.list_my_team_attention_sessions(v_team);
  PERFORM public.get_team_attention_as_of_date(v_team);
  PERFORM set_config('request.jwt.claim.sub',v_unrelated::text,true);
  BEGIN
    PERFORM count(*) FROM public.list_my_team_attention_sessions(v_team);
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION '14B2 unrelated analytics actor was not denied'; END IF;
  v_denied:=false; BEGIN PERFORM public.get_team_attention_as_of_date(v_team); EXCEPTION WHEN insufficient_privilege THEN v_denied:=true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '14B2 unrelated actor read anchor'; END IF;
  v_denied:=false; BEGIN PERFORM public.get_team_attention_as_of_date(v_other_team); EXCEPTION WHEN insufficient_privilege THEN v_denied:=true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '14B2 guessed unauthorized team anchor was not denied'; END IF;
  PERFORM set_config('request.jwt.claim.sub',v_guardian::text,true);
  v_denied:=false; BEGIN PERFORM count(*) FROM public.list_my_team_attention_sessions(v_team); EXCEPTION WHEN insufficient_privilege THEN v_denied:=true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '14B2 guardian-only analytics actor was not denied'; END IF;
  PERFORM set_config('request.jwt.claim.sub',v_self::text,true);
  v_denied:=false; BEGIN PERFORM count(*) FROM public.list_my_team_attention_sessions(v_team); EXCEPTION WHEN insufficient_privilege THEN v_denied:=true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '14B2 self-only analytics actor was not denied'; END IF;
  v_denied:=false; BEGIN PERFORM count(*) FROM public.list_my_team_attention_sessions(NULL); EXCEPTION WHEN insufficient_privilege THEN v_denied:=true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '14B2 null team was not denied'; END IF;
  v_denied:=false; BEGIN PERFORM public.get_team_attention_as_of_date(NULL); EXCEPTION WHEN insufficient_privilege THEN v_denied:=true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '14B2 null team anchor was not denied'; END IF;
  EXECUTE 'RESET ROLE';
  RAISE NOTICE '14B2 VALIDATOR PASS';
END;
$validation$;

ROLLBACK;
