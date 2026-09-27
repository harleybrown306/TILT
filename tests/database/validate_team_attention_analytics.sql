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
  v_current_session uuid;
  v_current_result uuid;
  v_former_session uuid;
  v_marker text := '14b2-' || replace(gen_random_uuid()::text, '-', '');
  v_as_of date := (transaction_timestamp() AT TIME ZONE 'America/Chicago')::date;
  v_denied boolean := false;
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

  INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
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
  INSERT INTO public.teams(name,created_by_user_id) VALUES ('14B2 other',v_unrelated) RETURNING id INTO v_other_team;
  INSERT INTO public.teams(name,created_by_user_id) VALUES ('14B2 empty',v_manager) RETURNING id INTO v_empty_team;
  INSERT INTO public.team_staff_memberships(team_id,profile_id,role,created_by_profile_id) VALUES (v_team,v_manager,'coach',v_manager),(v_team,v_assistant,'assistant_coach',v_manager),(v_empty_team,v_manager,'coach',v_manager);
  INSERT INTO public.athletes(id,display_name,created_by_profile_id) VALUES (v_athlete,'Current 14B2',v_manager),(v_former,'Former 14B2',v_manager);
  INSERT INTO public.team_athlete_memberships(team_id,athlete_id,created_by_profile_id) VALUES (v_team,v_athlete,v_manager);
  INSERT INTO public.athlete_profile_relationships(athlete_id,profile_id,role,training_permission,manage_permission,created_by_profile_id)
  VALUES (v_athlete,v_guardian,'guardian',true,true,v_manager),(v_athlete,v_self,'self',true,true,v_manager);
  INSERT INTO public.exercises(name,owner_user_id) VALUES ('14B2 exercise',v_manager) RETURNING id INTO v_exercise;
  INSERT INTO public.workouts(name,owner_user_id) VALUES ('14B2 workout',v_manager) RETURNING id INTO v_workout;
  INSERT INTO public.workout_exercises(workout_id,exercise_id,position,duration_seconds,rest_seconds,exercise_snapshot)
  VALUES (v_workout,v_exercise,0,60,0,jsonb_build_object('exercise_name','14B2 exercise'));
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

  PERFORM set_config('request.jwt.claim.sub',v_manager::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  -- The base grant is intentionally present for ACT users; a coach with VIEW
  -- only must nevertheless receive no attempt rows through RLS.
  IF EXISTS (SELECT 1 FROM public.workout_session_attempts WHERE training_session_id=v_current_session) THEN
    RAISE EXCEPTION '14B2 VIEW actor read an ACT-only attempt row';
  END IF;
  IF (SELECT count(*) FROM public.list_my_team_attention_sessions(v_team)) <> 2
     OR EXISTS (SELECT 1 FROM public.list_my_team_attention_sessions(v_team) WHERE as_of_date<>v_as_of)
     OR NOT EXISTS (SELECT 1 FROM public.list_my_team_attention_sessions(v_team) WHERE session_id=v_current_session AND athlete_id=v_athlete AND has_canonical_completion)
     OR NOT EXISTS (SELECT 1 FROM public.list_my_team_attention_sessions(v_team) WHERE session_id=v_former_session AND athlete_id IS NULL AND is_cancelled AND has_canonical_completion)
     OR NOT EXISTS (SELECT 1 FROM public.list_my_team_attention_sessions(v_team) WHERE session_id=v_current_session AND adherence_completed_work_blocks=3 AND adherence_prescribed_work_blocks=5)
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
