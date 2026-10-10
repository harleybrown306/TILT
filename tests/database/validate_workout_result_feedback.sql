-- Execute only against the disposable local database. All fixtures roll back.
BEGIN;

DO $validator$
DECLARE
  v_marker text := '15b2-' || replace(gen_random_uuid()::text, '-', '');
  v_self uuid := gen_random_uuid();
  v_guardian uuid := gen_random_uuid();
  v_view_guardian uuid := gen_random_uuid();
  v_revoked uuid := gen_random_uuid();
  v_coach uuid := gen_random_uuid();
  v_assistant uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_sibling uuid := gen_random_uuid();
  v_unrelated uuid := gen_random_uuid();
  v_athlete uuid := gen_random_uuid();
  v_sibling_athlete uuid := gen_random_uuid();
  v_team uuid := gen_random_uuid();
  v_workout uuid := gen_random_uuid();
  v_exercise uuid := gen_random_uuid();
  v_workout_exercise uuid := gen_random_uuid();
  v_unperformed_workout_exercise uuid := gen_random_uuid();
  v_session uuid := gen_random_uuid();
  v_result uuid := gen_random_uuid();
  v_attempt uuid := gen_random_uuid();
  v_no_attempt_session uuid := gen_random_uuid();
  v_no_attempt_result uuid := gen_random_uuid();
  v_unfinalized_session uuid := gen_random_uuid();
  v_unfinalized_result uuid := gen_random_uuid();
  v_unfinalized_attempt uuid := gen_random_uuid();
  v_duplicate_result uuid := gen_random_uuid();
  v_noncompleted_session uuid := gen_random_uuid();
  v_noncompleted_result uuid := gen_random_uuid();
  v_mismatch_session uuid := gen_random_uuid();
  v_mismatch_result uuid := gen_random_uuid();
  v_note500_session uuid := gen_random_uuid();
  v_note500_result uuid := gen_random_uuid();
  v_note501_session uuid := gen_random_uuid();
  v_note501_result uuid := gen_random_uuid();
  v_profile_session uuid := gen_random_uuid();
  v_profile_result uuid := gen_random_uuid();
  v_feedback uuid;
  v_existing uuid;
  v_note text;
  v_denied boolean;
  v_before_count integer;
  v_option_ids uuid[];
  v_option_names text[];
BEGIN
  INSERT INTO auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT id, 'authenticated', 'authenticated', v_marker || '-' || suffix || '@example.test', clock_timestamp(), '{"provider":"email"}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp()
  FROM (VALUES
    (v_self, 'self'), (v_guardian, 'guardian'), (v_view_guardian, 'view'), (v_revoked, 'revoked'),
    (v_coach, 'coach'), (v_assistant, 'assistant'), (v_admin, 'admin'), (v_sibling, 'sibling'), (v_unrelated, 'unrelated')
  ) AS fixture(id, suffix);
  INSERT INTO public.profiles(id, full_name, platform_role)
  SELECT id, suffix, CASE WHEN id = v_admin THEN 'admin'::public.platform_role ELSE 'user'::public.platform_role END
  FROM (VALUES
    (v_self, 'self'), (v_guardian, 'guardian'), (v_view_guardian, 'view'), (v_revoked, 'revoked'),
    (v_coach, 'coach'), (v_assistant, 'assistant'), (v_admin, 'admin'), (v_sibling, 'sibling'), (v_unrelated, 'unrelated')
  ) AS fixture(id, suffix)
  ON CONFLICT (id) DO UPDATE
  SET full_name = EXCLUDED.full_name,
      platform_role = EXCLUDED.platform_role;
  INSERT INTO public.athletes(id, display_name) VALUES (v_athlete, v_marker || ' athlete'), (v_sibling_athlete, v_marker || ' sibling');
  INSERT INTO public.athlete_profile_relationships(athlete_id, profile_id, role, training_permission, manage_permission)
  VALUES
    (v_athlete, v_self, 'self', true, true),
    (v_athlete, v_guardian, 'guardian', true, false),
    (v_athlete, v_view_guardian, 'guardian', false, false),
    (v_athlete, v_revoked, 'guardian', true, false),
    (v_sibling_athlete, v_sibling, 'self', true, true);
  UPDATE public.athlete_profile_relationships SET revoked_at = clock_timestamp()
  WHERE athlete_id = v_athlete AND profile_id = v_revoked;
  INSERT INTO public.teams(id, name, created_by_user_id) VALUES (v_team, v_marker || ' team', v_coach);
  INSERT INTO public.team_memberships(team_id, user_id, role, created_by_user_id)
  VALUES (v_team, v_assistant, 'assistant_coach', v_coach);
  INSERT INTO public.team_athlete_memberships(team_id, athlete_id) VALUES (v_team, v_athlete);
  INSERT INTO public.exercises(id, name) VALUES (v_exercise, v_marker || ' exercise');
  INSERT INTO public.workouts(id, name) VALUES (v_workout, v_marker || ' workout');
  INSERT INTO public.workout_exercises(id, workout_id, exercise_id, position, duration_seconds, rest_seconds, exercise_snapshot)
  VALUES
    (v_workout_exercise, v_workout, v_exercise, 0, 10, 0, jsonb_build_object('exercise_name', v_marker || ' performed')),
    (v_unperformed_workout_exercise, v_workout, v_exercise, 1, 10, 0, jsonb_build_object('exercise_name', v_marker || ' unperformed'));

  INSERT INTO public.training_sessions(id, athlete_id, athlete_user_id, coach_user_id, team_id, workout_id, scheduled_date, status)
  VALUES (v_session, v_athlete, NULL, v_coach, v_team, v_workout, current_date, 'completed');
  INSERT INTO public.workout_results(id, training_session_id, athlete_id, athlete_user_id, completed_at, result_data)
  VALUES (v_result, v_session, v_athlete, NULL, clock_timestamp(), '{}'::jsonb);
  INSERT INTO public.workout_session_attempts(id, training_session_id, athlete_id, athlete_user_id, workout_result_id, started_at, finalization_state, prescription_schema_version, prescribed_work_ms, prescribed_rest_ms, prescribed_total_ms, prescribed_step_count)
  VALUES (v_attempt, v_session, v_athlete, NULL, v_result, clock_timestamp(), 'open', 1, 0, 0, 0, 2);
  INSERT INTO public.workout_session_events(id, session_id, attempt_id, sequence, event_type, workout_exercise_id, step_position, phase, phase_duration_ms, phase_elapsed_ms, elapsed_ms, occurred_at)
  VALUES
    (gen_random_uuid(), v_session, v_attempt, 0, 'exercise_completed', v_workout_exercise, 0, 'work', 10, 10, 10, clock_timestamp()),
    (gen_random_uuid(), v_session, v_attempt, 1, 'exercise_completed', v_workout_exercise, 0, 'work', 10, 10, 11, clock_timestamp());
  UPDATE public.workout_session_attempts
  SET finalization_state = 'finalized_completed',
      finalized_at = clock_timestamp(),
      measurement_version = 99,
      measurement_quality = 'unknown'
  WHERE id = v_attempt;

  INSERT INTO public.training_sessions(id, athlete_id, athlete_user_id, coach_user_id, team_id, workout_id, scheduled_date, status)
  VALUES
    (v_no_attempt_session, v_athlete, NULL, v_coach, v_team, v_workout, current_date, 'completed'),
    (v_unfinalized_session, v_athlete, NULL, v_coach, v_team, v_workout, current_date, 'completed');
  INSERT INTO public.workout_results(id, training_session_id, athlete_id, athlete_user_id, completed_at, result_data)
  VALUES
    (v_no_attempt_result, v_no_attempt_session, v_athlete, NULL, clock_timestamp(), '{}'::jsonb),
    (v_unfinalized_result, v_unfinalized_session, v_athlete, NULL, clock_timestamp(), '{}'::jsonb);
  INSERT INTO public.workout_session_attempts(id, training_session_id, athlete_id, athlete_user_id, workout_result_id, started_at, finalization_state, prescription_schema_version, prescribed_work_ms, prescribed_rest_ms, prescribed_total_ms, prescribed_step_count)
  VALUES (v_unfinalized_attempt, v_unfinalized_session, v_athlete, NULL, v_unfinalized_result, clock_timestamp(), 'open', 1, 0, 0, 0, 2);

  INSERT INTO public.training_sessions(id, athlete_id, athlete_user_id, coach_user_id, team_id, workout_id, scheduled_date, status)
  VALUES
    (v_noncompleted_session, v_athlete, NULL, v_coach, v_team, v_workout, current_date, 'scheduled'),
    (v_mismatch_session, v_athlete, NULL, v_coach, v_team, v_workout, current_date, 'completed'),
    (v_note500_session, v_athlete, NULL, v_coach, v_team, v_workout, current_date, 'completed'),
    (v_note501_session, v_athlete, NULL, v_coach, v_team, v_workout, current_date, 'completed'),
    (v_profile_session, v_athlete, NULL, v_coach, v_team, v_workout, current_date, 'completed');
  INSERT INTO public.workout_results(id, training_session_id, athlete_id, athlete_user_id, completed_at, result_data)
  VALUES
    (v_noncompleted_result, v_noncompleted_session, v_athlete, NULL, clock_timestamp(), '{}'::jsonb),
    (v_mismatch_result, v_mismatch_session, v_sibling_athlete, NULL, clock_timestamp(), '{}'::jsonb),
    (v_note500_result, v_note500_session, v_athlete, NULL, clock_timestamp(), '{}'::jsonb),
    (v_note501_result, v_note501_session, v_athlete, NULL, clock_timestamp(), '{}'::jsonb),
    (v_profile_result, v_profile_session, v_athlete, NULL, clock_timestamp(), '{}'::jsonb);
  UPDATE public.training_sessions SET status = 'cancelled'
  WHERE id = v_noncompleted_session;

  PERFORM set_config('request.jwt.claim.sub', v_self::text, true);
  SELECT feedback_id INTO v_feedback FROM public.submit_my_workout_feedback(v_result, 'selected', v_workout_exercise, E' \n coach note \t ');
  IF v_feedback IS NULL OR NOT EXISTS (SELECT 1 FROM public.workout_result_feedback WHERE id = v_feedback AND submitted_by_profile_id = v_self AND coach_note = 'coach note') THEN
    RAISE EXCEPTION '15B2 self selected submission failed';
  END IF;
  SELECT array_agg(workout_exercise_id), array_agg(exercise_name)
  INTO v_option_ids, v_option_names
  FROM public.list_my_workout_feedback_exercise_options(v_result);
  IF v_option_ids IS DISTINCT FROM ARRAY[v_workout_exercise] OR v_option_names IS NULL OR array_length(v_option_names, 1) <> 1 THEN
    RAISE EXCEPTION '15C1 performed exercise options did not match finalized immutable evidence';
  END IF;
  IF (SELECT already_submitted FROM public.submit_my_workout_feedback(v_result, 'selected', v_workout_exercise, 'coach note')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION '15B2 identical retry was not idempotent';
  END IF;
  v_denied := false; BEGIN PERFORM * FROM public.submit_my_workout_feedback(v_result, 'selected', v_unperformed_workout_exercise, NULL); EXCEPTION WHEN others THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15B2 unperformed exercise selection was allowed'; END IF;
  v_denied := false; BEGIN PERFORM * FROM public.submit_my_workout_feedback(v_result, 'selected', v_workout_exercise, 'changed'); EXCEPTION WHEN unique_violation THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15B2 conflicting retry was allowed'; END IF;

  SELECT feedback_id INTO v_existing FROM public.submit_my_workout_feedback(v_no_attempt_result, 'none', NULL, E' \t ');
  IF v_existing IS NULL OR (SELECT coach_note FROM public.workout_result_feedback WHERE id = v_existing) IS NOT NULL THEN RAISE EXCEPTION '15B2 no-attempt none feedback failed'; END IF;
  SELECT feedback_id INTO v_existing FROM public.submit_my_workout_feedback(v_unfinalized_result, 'skipped', NULL, 'note only');
  IF v_existing IS NULL THEN RAISE EXCEPTION '15B2 unfinalized non-selected feedback failed'; END IF;
  v_denied := false; BEGIN PERFORM * FROM public.submit_my_workout_feedback(v_no_attempt_result, 'selected', v_workout_exercise, NULL); EXCEPTION WHEN others THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15B2 selected no-attempt feedback was allowed'; END IF;
  v_denied := false; BEGIN PERFORM * FROM public.list_my_workout_feedback_exercise_options(v_unfinalized_result); EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15C1 unfinalized attempt options were allowed'; END IF;
  v_denied := false; BEGIN PERFORM * FROM public.submit_my_workout_feedback(v_noncompleted_result, 'none', NULL, NULL); EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15B2 non-completed session feedback was allowed'; END IF;
  v_denied := false; BEGIN PERFORM * FROM public.submit_my_workout_feedback(v_mismatch_result, 'none', NULL, NULL); EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15B2 ownership-mismatched result feedback was allowed'; END IF;
  v_denied := false; BEGIN PERFORM * FROM public.get_my_workout_feedback(v_mismatch_result); EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15B2 ownership-mismatched result read was allowed'; END IF;
  SELECT feedback_id INTO v_existing FROM public.submit_my_workout_feedback(v_note500_result, 'none', NULL, ' ' || repeat('a', 500) || E'\t');
  IF v_existing IS NULL OR (SELECT char_length(coach_note) FROM public.workout_result_feedback WHERE id = v_existing) <> 500 THEN RAISE EXCEPTION '15B2 500-character note was not accepted canonically'; END IF;
  v_denied := false; BEGIN PERFORM * FROM public.submit_my_workout_feedback(v_note501_result, 'none', NULL, repeat('a', 501)); EXCEPTION WHEN others THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15B2 501-character note was allowed'; END IF;
  v_denied := false; BEGIN INSERT INTO public.workout_result_feedback(workout_result_id, q1_response_state, coach_note) VALUES(v_note501_result, 'none', E' noncanonical '); EXCEPTION WHEN check_violation THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15B2 table accepted noncanonical note'; END IF;

  SELECT count(*) INTO v_before_count FROM public.workout_result_feedback;
  PERFORM set_config('request.jwt.claim.sub', v_guardian::text, true);
  v_denied := false; BEGIN PERFORM * FROM public.submit_my_workout_feedback(v_result, 'selected', v_workout_exercise, 'same'); EXCEPTION WHEN unique_violation THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15B2 different actor retry was allowed'; END IF;
  PERFORM set_config('request.jwt.claim.sub', v_view_guardian::text, true);
  v_denied := false; BEGIN PERFORM * FROM public.submit_my_workout_feedback(v_no_attempt_result, 'none', NULL, NULL); EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15B2 guardian without ACT wrote feedback'; END IF;
  v_denied := false; BEGIN PERFORM * FROM public.list_my_workout_feedback_exercise_options(v_result); EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15C1 guardian without ACT received options'; END IF;
  PERFORM set_config('request.jwt.claim.sub', v_revoked::text, true);
  v_denied := false; BEGIN PERFORM * FROM public.submit_my_workout_feedback(v_no_attempt_result, 'none', NULL, NULL); EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15B2 revoked guardian wrote feedback'; END IF;
  v_denied := false; BEGIN PERFORM * FROM public.list_my_workout_feedback_exercise_options(v_result); EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15C1 revoked guardian received options'; END IF;
  FOR v_existing IN SELECT id FROM (VALUES (v_coach), (v_assistant), (v_admin), (v_sibling), (v_unrelated)) AS actors(id) LOOP
    PERFORM set_config('request.jwt.claim.sub', v_existing::text, true);
    v_denied := false; BEGIN PERFORM * FROM public.submit_my_workout_feedback(v_no_attempt_result, 'none', NULL, NULL); EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
    IF NOT v_denied THEN RAISE EXCEPTION '15B2 non-ACT actor wrote feedback'; END IF;
    v_denied := false; BEGIN PERFORM * FROM public.list_my_workout_feedback_exercise_options(v_result); EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
    IF NOT v_denied THEN RAISE EXCEPTION '15C1 non-ACT actor received options'; END IF;
  END LOOP;

  PERFORM set_config('request.jwt.claim.sub', v_self::text, true);
  IF NOT EXISTS (SELECT 1 FROM public.get_my_workout_feedback(v_result) WHERE feedback_id = v_feedback) THEN RAISE EXCEPTION '15B2 self read failed'; END IF;
  PERFORM set_config('request.jwt.claim.sub', v_guardian::text, true);
  IF NOT EXISTS (SELECT 1 FROM public.get_my_workout_feedback(v_result) WHERE feedback_id = v_feedback) THEN RAISE EXCEPTION '15B2 guardian read failed'; END IF;
  PERFORM set_config('request.jwt.claim.sub', v_view_guardian::text, true);
  IF NOT EXISTS (SELECT 1 FROM public.get_my_workout_feedback(v_result) WHERE feedback_id = v_feedback) THEN RAISE EXCEPTION '15B2 guardian VIEW read failed'; END IF;
  FOR v_existing IN SELECT id FROM (VALUES (v_revoked), (v_coach), (v_assistant), (v_admin), (v_sibling), (v_unrelated)) AS actors(id) LOOP
    PERFORM set_config('request.jwt.claim.sub', v_existing::text, true);
    v_denied := false; BEGIN PERFORM * FROM public.get_my_workout_feedback(v_result); EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15B2 unauthorized actor read feedback'; END IF;
  END LOOP;

  PERFORM set_config('request.jwt.claim.sub', v_guardian::text, true);
  SELECT feedback_id INTO v_existing FROM public.submit_my_workout_feedback(v_profile_result, 'none', NULL, 'profile lifecycle');
  DELETE FROM public.athlete_profile_relationships WHERE athlete_id = v_athlete AND profile_id = v_guardian;
  DELETE FROM public.profiles WHERE id = v_guardian;
  IF NOT EXISTS (SELECT 1 FROM public.workout_result_feedback WHERE id = v_existing AND submitted_by_profile_id IS NULL) THEN RAISE EXCEPTION '15B2 profile deletion did not preserve feedback with null author'; END IF;
  PERFORM set_config('request.jwt.claim.sub', v_self::text, true);
  v_denied := false; BEGIN PERFORM * FROM public.submit_my_workout_feedback(v_profile_result, 'none', NULL, 'profile lifecycle'); EXCEPTION WHEN unique_violation THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15B2 null historical author was reclaimable'; END IF;

  PERFORM set_config('request.jwt.claim.sub', v_self::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_denied := false; BEGIN PERFORM 1 FROM public.workout_result_feedback; EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15B2 direct feedback select was allowed'; END IF;
  v_denied := false; BEGIN INSERT INTO public.workout_result_feedback(workout_result_id, q1_response_state) VALUES(gen_random_uuid(), 'none'); EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15B2 direct feedback insert was allowed'; END IF;
  v_denied := false; BEGIN UPDATE public.workout_result_feedback SET coach_note='x' WHERE id=v_feedback; EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15B2 direct feedback update was allowed'; END IF;
  v_denied := false; BEGIN DELETE FROM public.workout_result_feedback WHERE id=v_feedback; EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15B2 direct feedback delete was allowed'; END IF;
  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', '', true);
  v_denied := false; BEGIN PERFORM * FROM public.submit_my_workout_feedback(v_result, 'none', NULL, NULL); EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15B2 null auth wrote feedback'; END IF;
  v_denied := false; BEGIN PERFORM * FROM public.get_my_workout_feedback(v_result); EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15B2 null auth read feedback'; END IF;

  IF has_table_privilege('authenticated', 'public.workout_result_feedback', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('anon', 'public.workout_result_feedback', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('public', 'public.workout_result_feedback', 'SELECT,INSERT,UPDATE,DELETE')
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.workout_result_feedback'::regclass)
     OR has_function_privilege('public', 'public.submit_my_workout_feedback(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.submit_my_workout_feedback(uuid,text,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.submit_my_workout_feedback(uuid,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '15B2 feedback ACL contract failed';
  END IF;
  IF has_function_privilege('public', 'public.list_my_workout_feedback_exercise_options(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.list_my_workout_feedback_exercise_options(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.list_my_workout_feedback_exercise_options(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '15C1 options ACL contract failed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.submit_my_workout_feedback(uuid,text,uuid,text)'::regprocedure AND (NOT prosecdef OR NOT (coalesce(proconfig, ARRAY[]::text[]) @> ARRAY['search_path=""'])))
     OR EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.get_my_workout_feedback(uuid)'::regprocedure AND (NOT prosecdef OR NOT (coalesce(proconfig, ARRAY[]::text[]) @> ARRAY['search_path=""']))) THEN
    RAISE EXCEPTION '15B2 feedback function hardening failed';
  END IF;

  -- Simulate malformed historical state only inside this rollback fixture.
  ALTER TABLE public.workout_results DROP CONSTRAINT workout_results_training_session_id_key;
  INSERT INTO public.workout_results(id, training_session_id, athlete_id, athlete_user_id, completed_at, result_data)
  VALUES (v_duplicate_result, v_session, v_athlete, NULL, clock_timestamp(), '{}'::jsonb);

  PERFORM set_config('request.jwt.claim.sub', v_self::text, true);
  v_denied := false; BEGIN PERFORM * FROM public.submit_my_workout_feedback(v_result, 'selected', v_workout_exercise, 'coach note'); EXCEPTION WHEN others THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15B2 ambiguous formerly-valid result retry was allowed'; END IF;
  v_denied := false; BEGIN PERFORM * FROM public.submit_my_workout_feedback(v_duplicate_result, 'none', NULL, NULL); EXCEPTION WHEN others THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15B2 ambiguous duplicate result write was allowed'; END IF;
  v_denied := false; BEGIN PERFORM * FROM public.get_my_workout_feedback(v_result); EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15B2 ambiguous result A read was allowed'; END IF;
  v_denied := false; BEGIN PERFORM * FROM public.get_my_workout_feedback(v_duplicate_result); EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15B2 ambiguous result B read was allowed'; END IF;
  PERFORM set_config('request.jwt.claim.sub', v_guardian::text, true);
  v_denied := false; BEGIN PERFORM * FROM public.submit_my_workout_feedback(v_result, 'none', NULL, NULL); EXCEPTION WHEN others THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15B2 guardian ambiguous result write was allowed'; END IF;
  PERFORM set_config('request.jwt.claim.sub', v_self::text, true);
  v_denied := false; BEGIN PERFORM * FROM public.list_my_workout_feedback_exercise_options(v_result); EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15C1 ambiguous result A options were allowed'; END IF;
  v_denied := false; BEGIN PERFORM * FROM public.list_my_workout_feedback_exercise_options(v_duplicate_result); EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION '15C1 ambiguous result B options were allowed'; END IF;
END;
$validator$;

ROLLBACK;
