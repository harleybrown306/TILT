-- Execute only against the disposable local database after all migrations.
-- Fixtures are transaction-local and removed by ROLLBACK.
BEGIN;

DO $validation$
DECLARE
  v_coach uuid; v_assistant uuid; v_former_staff uuid; v_guardian uuid;
  v_unrelated uuid; v_admin uuid; v_self_profile uuid; v_athlete uuid;
  v_team_a uuid := gen_random_uuid(); v_team_b uuid := gen_random_uuid();
  v_other_athlete uuid := gen_random_uuid(); v_workout uuid := gen_random_uuid();
  v_session uuid := gen_random_uuid(); v_result uuid := gen_random_uuid();
  v_cross_team_session uuid := gen_random_uuid(); v_cross_team_result uuid := gen_random_uuid();
  v_wrong_athlete_session uuid := gen_random_uuid(); v_wrong_athlete_result uuid := gen_random_uuid();
  v_exercise uuid := gen_random_uuid(); v_workout_exercise uuid := gen_random_uuid();
  v_actor uuid; v_requested_team uuid; v_requested_athlete uuid; v_denied boolean; v_rows integer;
BEGIN
  SELECT athlete_id, profile_id INTO v_athlete, v_self_profile
  FROM public.athlete_profile_relationships
  WHERE role = 'self' AND revoked_at IS NULL ORDER BY created_at LIMIT 1;
  SELECT id INTO v_coach FROM public.profiles WHERE platform_role <> 'admin' AND id IS DISTINCT FROM v_self_profile ORDER BY id LIMIT 1;
  SELECT id INTO v_assistant FROM public.profiles WHERE platform_role <> 'admin' AND id NOT IN (v_coach, v_self_profile) ORDER BY id LIMIT 1;
  SELECT id INTO v_former_staff FROM public.profiles WHERE platform_role <> 'admin' AND id NOT IN (v_coach, v_assistant, v_self_profile) ORDER BY id LIMIT 1;
  SELECT id INTO v_guardian FROM public.profiles WHERE platform_role <> 'admin' AND id NOT IN (v_coach, v_assistant, v_former_staff, v_self_profile) ORDER BY id LIMIT 1;
  SELECT id INTO v_unrelated FROM public.profiles WHERE platform_role <> 'admin' AND id NOT IN (v_coach, v_assistant, v_former_staff, v_guardian, v_self_profile) ORDER BY id LIMIT 1;
  SELECT id INTO v_admin FROM public.profiles WHERE platform_role = 'admin' ORDER BY id LIMIT 1;
  IF v_coach IS NULL OR v_assistant IS NULL OR v_former_staff IS NULL OR v_guardian IS NULL OR v_unrelated IS NULL OR v_admin IS NULL OR v_athlete IS NULL THEN
    RAISE EXCEPTION 'Validation requires five non-admin profiles, an admin, and a self athlete';
  END IF;

  INSERT INTO public.teams(id, name, created_by_user_id) VALUES (v_team_a, 'Feedback history A', v_coach), (v_team_b, 'Feedback history B', v_unrelated);
  INSERT INTO public.team_staff_memberships(team_id, profile_id, role, created_by_profile_id) VALUES
    (v_team_a, v_coach, 'coach', v_coach), (v_team_a, v_assistant, 'assistant_coach', v_coach),
    (v_team_a, v_former_staff, 'coach', v_coach), (v_team_b, v_unrelated, 'coach', v_unrelated);
  INSERT INTO public.athletes(id, display_name, graduation_year, created_by_profile_id) VALUES (v_other_athlete, 'Feedback history other athlete', 2030, v_coach);
  INSERT INTO public.team_athlete_memberships(team_id, athlete_id, created_by_profile_id) VALUES
    (v_team_a, v_athlete, v_coach), (v_team_b, v_other_athlete, v_unrelated);
  INSERT INTO public.exercises(id, name) VALUES (v_exercise, 'Feedback history exercise');
  INSERT INTO public.workouts(id, name) VALUES (v_workout, 'Feedback history workout');
  INSERT INTO public.workout_exercises(id, workout_id, exercise_id, position, duration_seconds, rest_seconds, exercise_snapshot)
  VALUES (v_workout_exercise, v_workout, v_exercise, 0, 10, 0, jsonb_build_object('exercise_name', 'Feedback history exercise'));
  INSERT INTO public.training_sessions(id, athlete_id, coach_user_id, team_id, workout_id, scheduled_date, status)
  VALUES (v_session, v_athlete, v_coach, v_team_a, v_workout, current_date, 'completed'),
         (v_cross_team_session, v_athlete, v_coach, v_team_b, v_workout, current_date, 'completed'),
         (v_wrong_athlete_session, v_other_athlete, v_coach, v_team_a, v_workout, current_date, 'completed');
  INSERT INTO public.workout_results(id, training_session_id, athlete_id, completed_at, result_data)
  VALUES (v_result, v_session, v_athlete, clock_timestamp(), '{}'::jsonb),
         (v_cross_team_result, v_cross_team_session, v_athlete, clock_timestamp(), '{}'::jsonb),
         (v_wrong_athlete_result, v_wrong_athlete_session, v_athlete, clock_timestamp(), '{}'::jsonb);
  INSERT INTO public.workout_result_feedback(workout_result_id, q1_response_state, selected_workout_exercise_id, coach_note)
  VALUES (v_result, 'selected', v_workout_exercise, 'factual note'),
         (v_cross_team_result, 'none', NULL, 'cross team'),
         (v_wrong_athlete_result, 'skipped', NULL, 'wrong athlete');

  FOR v_actor IN SELECT id FROM (VALUES (v_coach), (v_assistant)) AS allowed(id) LOOP
    PERFORM set_config('request.jwt.claim.sub', v_actor::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT count(*) INTO v_rows FROM public.list_my_team_athlete_workout_feedback(v_team_a, v_athlete)
    WHERE scheduled_date = current_date AND workout_name = 'Feedback history workout' AND q1_response_state = 'selected' AND selected_exercise_label = 'Feedback history exercise' AND coach_note = 'factual note';
    EXECUTE 'RESET ROLE';
    IF v_rows <> 1 THEN RAISE EXCEPTION 'current coach or assistant did not receive exactly the bounded feedback row'; END IF;
  END LOOP;

  -- The requested team and durable athlete are both authorization inputs, not
  -- interchangeable facts: neither cross-team combination is readable.
  FOR v_actor, v_requested_team, v_requested_athlete IN
    SELECT v_coach, v_team_a, v_other_athlete
    UNION ALL SELECT v_coach, v_team_b, v_athlete
  LOOP
    v_denied := false; BEGIN
      PERFORM set_config('request.jwt.claim.sub', v_actor::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
      PERFORM * FROM public.list_my_team_athlete_workout_feedback(v_requested_team, v_requested_athlete); EXECUTE 'RESET ROLE';
    EXCEPTION WHEN insufficient_privilege THEN EXECUTE 'RESET ROLE'; v_denied := true; END;
    IF NOT v_denied THEN RAISE EXCEPTION 'requested athlete/team mismatch received staff feedback'; END IF;
  END LOOP;

  DELETE FROM public.team_staff_memberships WHERE team_id = v_team_a AND profile_id = v_former_staff;
  FOR v_actor IN SELECT id FROM (VALUES (v_former_staff), (v_unrelated), (v_guardian), (v_admin), (v_self_profile)) AS denied(id) LOOP
    v_denied := false; BEGIN
      PERFORM set_config('request.jwt.claim.sub', v_actor::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
      PERFORM * FROM public.list_my_team_athlete_workout_feedback(v_team_a, v_athlete); EXECUTE 'RESET ROLE';
    EXCEPTION WHEN insufficient_privilege THEN EXECUTE 'RESET ROLE'; v_denied := true; END;
    IF NOT v_denied THEN RAISE EXCEPTION 'unauthorized actor received staff feedback'; END IF;
  END LOOP;

  PERFORM set_config('request.jwt.claim.sub', v_coach::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
  IF EXISTS (SELECT 1 FROM public.list_my_team_athlete_workout_feedback(v_team_a, v_athlete) WHERE coach_note IN ('cross team', 'wrong athlete')) THEN
    EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'projection crossed team or athlete ownership';
  END IF;
  EXECUTE 'RESET ROLE';
  DELETE FROM public.team_athlete_memberships WHERE team_id = v_team_a AND athlete_id = v_athlete;
  v_denied := false; BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_coach::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM * FROM public.list_my_team_athlete_workout_feedback(v_team_a, v_athlete); EXECUTE 'RESET ROLE';
  EXCEPTION WHEN insufficient_privilege THEN EXECUTE 'RESET ROLE'; v_denied := true; END;
  IF NOT v_denied OR NOT EXISTS (SELECT 1 FROM public.workout_result_feedback WHERE workout_result_id = v_result) THEN
    RAISE EXCEPTION 'roster removal did not revoke access while preserving historical feedback';
  END IF;

  EXECUTE 'SET LOCAL ROLE authenticated';
  v_denied := false; BEGIN PERFORM 1 FROM public.workout_result_feedback; EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  EXECUTE 'RESET ROLE';
  IF NOT v_denied OR has_function_privilege('anon', 'public.list_my_team_athlete_workout_feedback(uuid,uuid)', 'EXECUTE') OR has_function_privilege('public', 'public.list_my_team_athlete_workout_feedback(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'feedback history ACL contract failed';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  v_denied := false; BEGIN PERFORM * FROM public.list_my_team_athlete_workout_feedback(v_team_a, v_athlete); EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION 'anonymous caller received staff feedback'; END IF;
END;
$validation$;

ROLLBACK;
