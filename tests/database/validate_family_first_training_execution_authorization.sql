-- Execute only after create_family_first_training_execution_authorization.sql is applied.
-- Every fixture and execution write is transaction-local and is removed by ROLLBACK.
BEGIN;

DO $validation$
DECLARE
  v_guardian uuid; v_view_only uuid; v_sibling uuid; v_coach uuid; v_assistant uuid;
  v_admin uuid; v_unrelated uuid; v_self_profile uuid; v_self_athlete uuid;
  v_child uuid; v_other_child uuid; v_team uuid; v_exercise uuid; v_workout uuid;
  v_child_session uuid; v_self_session uuid; v_attempt uuid := gen_random_uuid();
  v_self_attempt uuid := gen_random_uuid(); v_result uuid; v_step jsonb;
  v_work_ms bigint; v_started timestamptz := clock_timestamp();
BEGIN
  SELECT athlete_id, profile_id INTO v_self_athlete, v_self_profile
  FROM public.athlete_profile_relationships
  WHERE role = 'self' AND revoked_at IS NULL
  ORDER BY created_at LIMIT 1;
  SELECT id INTO v_admin FROM public.profiles WHERE platform_role = 'admin' ORDER BY id LIMIT 1;
  SELECT id INTO v_guardian FROM public.profiles WHERE id NOT IN (v_self_profile, v_admin) ORDER BY id LIMIT 1;
  SELECT id INTO v_view_only FROM public.profiles WHERE id NOT IN (v_self_profile, v_admin, v_guardian) ORDER BY id LIMIT 1;
  SELECT id INTO v_sibling FROM public.profiles WHERE id NOT IN (v_self_profile, v_admin, v_guardian, v_view_only) ORDER BY id LIMIT 1;
  SELECT id INTO v_coach FROM public.profiles WHERE id NOT IN (v_self_profile, v_admin, v_guardian, v_view_only, v_sibling) ORDER BY id LIMIT 1;
  SELECT id INTO v_assistant FROM public.profiles WHERE id NOT IN (v_self_profile, v_admin, v_guardian, v_view_only, v_sibling, v_coach) ORDER BY id LIMIT 1;
  SELECT id INTO v_unrelated FROM public.profiles WHERE id NOT IN (v_self_profile, v_admin, v_guardian, v_view_only, v_sibling, v_coach, v_assistant) ORDER BY id LIMIT 1;
  IF v_self_profile IS NULL OR v_self_athlete IS NULL OR v_admin IS NULL OR v_guardian IS NULL
     OR v_view_only IS NULL OR v_sibling IS NULL OR v_coach IS NULL OR v_assistant IS NULL OR v_unrelated IS NULL THEN
    RAISE EXCEPTION 'Family execution validation requires eight distinct profiles and one active self athlete';
  END IF;

  -- Build the deterministic one-work-block/no-rest source inside this rollback
  -- transaction. No production workout fixture is required or retained.
  INSERT INTO public.exercises(name, visibility)
  VALUES ('Rollback-only family execution exercise ' || gen_random_uuid()::text, 'private')
  RETURNING id INTO v_exercise;
  INSERT INTO public.workouts(name, visibility)
  VALUES ('Rollback-only family execution workout ' || gen_random_uuid()::text, 'private')
  RETURNING id INTO v_workout;
  INSERT INTO public.workout_exercises(workout_id, exercise_id, position, duration_seconds, rest_seconds, exercise_snapshot)
  VALUES (v_workout, v_exercise, 0, 60, 0, jsonb_build_object('exercise_name', 'Rollback-only family execution exercise'));

  INSERT INTO public.teams(id,name,created_by_user_id)
  VALUES (gen_random_uuid(),'Family execution validation ' || gen_random_uuid()::text,v_guardian)
  RETURNING id INTO v_team;
  INSERT INTO public.athletes(id,display_name,created_by_profile_id)
  VALUES (gen_random_uuid(),'Rollback-only child',v_guardian)
  RETURNING id INTO v_child;
  INSERT INTO public.athletes(id,display_name,created_by_profile_id)
  VALUES (gen_random_uuid(),'Rollback-only sibling child',v_guardian)
  RETURNING id INTO v_other_child;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id IN (v_child,v_other_child)) THEN
    RAISE EXCEPTION 'Rollback child unexpectedly has an auth/profile identity';
  END IF;

  INSERT INTO public.athlete_profile_relationships(athlete_id,profile_id,role,training_permission,manage_permission,created_by_profile_id)
  VALUES (v_child,v_guardian,'guardian',true,true,v_guardian),
         (v_child,v_view_only,'guardian',false,true,v_guardian),
         (v_other_child,v_sibling,'guardian',true,true,v_guardian);
  INSERT INTO public.team_staff_memberships(team_id,profile_id,role,created_by_profile_id)
  VALUES (v_team,v_guardian,'coach',v_guardian),
         (v_team,v_coach,'coach',v_guardian),
         (v_team,v_assistant,'assistant_coach',v_guardian);
  INSERT INTO public.team_athlete_memberships(team_id,athlete_id,created_by_profile_id)
  VALUES (v_team,v_child,v_guardian);

  INSERT INTO public.training_sessions(athlete_id,athlete_user_id,coach_user_id,team_id,workout_id,scheduled_date,status,notes)
  VALUES (v_child,NULL,v_guardian,v_team,v_workout,current_date,'scheduled','rollback-only child')
  RETURNING id INTO v_child_session;
  INSERT INTO public.training_sessions(athlete_id,athlete_user_id,coach_user_id,team_id,workout_id,scheduled_date,status,notes)
  VALUES (v_self_athlete,v_self_profile,v_guardian,v_team,v_workout,current_date,'scheduled','rollback-only self')
  RETURNING id INTO v_self_session;
  SELECT steps->0, prescribed_work_ms INTO v_step, v_work_ms
  FROM public.training_session_prescriptions WHERE session_id=v_child_session;
  IF v_step IS NULL OR v_work_ms IS NULL THEN RAISE EXCEPTION 'Child immutable prescription was not captured'; END IF;

  -- Guardian positive: documented reads plus the complete append-only pipeline.
  PERFORM set_config('request.jwt.claim.sub',v_guardian::text,true); SET LOCAL ROLE authenticated;
  PERFORM 1 FROM public.training_sessions WHERE id=v_child_session;
  IF NOT FOUND THEN RAISE EXCEPTION 'Guardian training=true cannot read child session'; END IF;
  PERFORM 1 FROM public.training_session_prescriptions WHERE session_id=v_child_session;
  IF NOT FOUND THEN RAISE EXCEPTION 'Guardian training=true cannot read child prescription'; END IF;
  INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at)
  VALUES (gen_random_uuid(),v_child_session,v_attempt,0,'workout_started','ready',0,v_started);
  PERFORM public.register_my_workout_session_attempt(v_attempt,v_child_session);
  IF NOT EXISTS (SELECT 1 FROM public.workout_session_attempts WHERE id=v_attempt AND athlete_id=v_child AND athlete_user_id IS NULL) THEN
    RAISE EXCEPTION 'Guardian attempt did not derive child durable ownership with NULL compatibility owner';
  END IF;
  INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,workout_exercise_id,step_position,phase,phase_duration_ms,phase_elapsed_ms,elapsed_ms,occurred_at)
  VALUES (gen_random_uuid(),v_child_session,v_attempt,1,'exercise_started',(v_step->>'workout_exercise_id')::uuid,(v_step->>'position')::integer,'work',(v_step->>'work_ms')::bigint,0,0,v_started),
         (gen_random_uuid(),v_child_session,v_attempt,2,'exercise_completed',(v_step->>'workout_exercise_id')::uuid,(v_step->>'position')::integer,'work',(v_step->>'work_ms')::bigint,(v_step->>'work_ms')::bigint,v_work_ms,v_started + (v_work_ms || ' milliseconds')::interval);
  SELECT result_id INTO v_result FROM public.complete_my_training_session(v_child_session);
  INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at)
  VALUES (gen_random_uuid(),v_child_session,v_attempt,3,'workout_completed','finished',v_work_ms,v_started + (v_work_ms || ' milliseconds')::interval);
  PERFORM public.finalize_my_workout_session_attempt(v_attempt);
  IF NOT EXISTS (SELECT 1 FROM public.workout_results WHERE id=v_result AND athlete_id=v_child AND athlete_user_id IS NULL) THEN
    RAISE EXCEPTION 'Guardian canonical result did not retain child ownership with NULL compatibility owner';
  END IF;
  IF EXISTS (SELECT 1 FROM public.workout_results WHERE id=v_result AND athlete_user_id=v_guardian)
     OR EXISTS (SELECT 1 FROM public.workout_session_attempts WHERE id=v_attempt AND athlete_user_id=v_guardian) THEN
    RAISE EXCEPTION 'Guardian actor was stored as athlete owner';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workout_session_attempts WHERE id=v_attempt AND finalization_state='finalized_completed' AND measurement_version=1 AND measurement_quality='complete' AND work_timer_progressed_ms IS NULL AND rest_timer_progressed_ms IS NULL) THEN
    RAISE EXCEPTION 'Child Measurement V1 finalization failed';
  END IF;
  PERFORM 1 FROM public.workout_results WHERE id=v_result;
  IF NOT FOUND THEN RAISE EXCEPTION 'Guardian cannot read canonical child result'; END IF;

  RESET ROLE;
  -- View-only guardian sees documented records but cannot access operational state or ACT.
  PERFORM set_config('request.jwt.claim.sub',v_view_only::text,true); SET LOCAL ROLE authenticated;
  PERFORM 1 FROM public.training_sessions WHERE id=v_child_session;
  IF NOT FOUND OR private.can_act_for_training_session(v_child_session) THEN
    RAISE EXCEPTION 'Guardian training=false did not remain VIEW-only';
  END IF;
  PERFORM 1 FROM public.workout_session_attempts WHERE id=v_attempt;
  IF FOUND THEN RAISE EXCEPTION 'Guardian training=false received attempt recovery visibility'; END IF;
  BEGIN
    INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at)
    VALUES (gen_random_uuid(),v_child_session,gen_random_uuid(),0,'workout_started','ready',0,clock_timestamp());
    RAISE EXCEPTION 'Guardian training=false inserted telemetry';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.register_my_workout_session_attempt(gen_random_uuid(),v_child_session);
    RAISE EXCEPTION 'Guardian training=false registered attempt';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Attempt session unavailable' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.complete_my_training_session(v_child_session);
    RAISE EXCEPTION 'Guardian training=false completed session';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Training action unavailable' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.finalize_my_workout_session_attempt(v_attempt);
    RAISE EXCEPTION 'Guardian training=false finalized attempt';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Attempt unavailable' THEN RAISE; END IF;
  END;
  RESET ROLE;

  -- Every non-family role remains non-ACT. Staff may retain documented team VIEW.
  FOR v_result IN SELECT unnest(ARRAY[v_sibling,v_assistant,v_admin,v_unrelated,v_coach]) LOOP
    PERFORM set_config('request.jwt.claim.sub',v_result::text,true); SET LOCAL ROLE authenticated;
    IF private.can_act_for_training_session(v_child_session) THEN RAISE EXCEPTION 'Non-family actor unexpectedly received child ACT'; END IF;
    RESET ROLE;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub',v_coach::text,true); SET LOCAL ROLE authenticated;
  PERFORM 1 FROM public.training_sessions WHERE id=v_child_session;
  IF NOT FOUND THEN RAISE EXCEPTION 'Coach lost existing team VIEW'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub',v_assistant::text,true); SET LOCAL ROLE authenticated;
  PERFORM 1 FROM public.training_sessions WHERE id=v_child_session;
  IF NOT FOUND THEN RAISE EXCEPTION 'Assistant lost existing team VIEW'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub',v_admin::text,true); SET LOCAL ROLE authenticated;
  PERFORM 1 FROM public.training_sessions WHERE id=v_child_session;
  IF NOT FOUND THEN RAISE EXCEPTION 'Admin lost support VIEW'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub',v_unrelated::text,true); SET LOCAL ROLE authenticated;
  PERFORM 1 FROM public.training_sessions WHERE id=v_child_session;
  IF FOUND THEN RAISE EXCEPTION 'Unrelated actor received child VIEW'; END IF;
  RESET ROLE;
  SET LOCAL ROLE anon;
  PERFORM 1 FROM public.training_sessions WHERE id=v_child_session;
  IF FOUND THEN RAISE EXCEPTION 'Anon received child VIEW'; END IF;
  RESET ROLE;

  -- Guardian is also fixture staff: revoking the relationship proves staff alone cannot ACT.
  PERFORM set_config('request.jwt.claim.sub',v_guardian::text,true); SET LOCAL ROLE authenticated;
  IF NOT private.can_act_for_training_session(v_child_session) THEN RAISE EXCEPTION 'Coach+guardian did not receive ACT from explicit guardian relationship'; END IF;
  RESET ROLE;
  UPDATE public.athlete_profile_relationships SET revoked_at=clock_timestamp()
  WHERE athlete_id=v_child AND profile_id=v_guardian AND role='guardian';
  PERFORM set_config('request.jwt.claim.sub',v_guardian::text,true); SET LOCAL ROLE authenticated;
  IF private.can_act_for_training_session(v_child_session) THEN RAISE EXCEPTION 'Coach+guardian retained ACT after guardian relationship revocation'; END IF;
  RESET ROLE;

  -- Same-UUID self regression uses the same canonical writer/ownership shape.
  PERFORM set_config('request.jwt.claim.sub',v_self_profile::text,true); SET LOCAL ROLE authenticated;
  INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at)
  VALUES (gen_random_uuid(),v_self_session,v_self_attempt,0,'workout_started','ready',0,v_started);
  PERFORM public.register_my_workout_session_attempt(v_self_attempt,v_self_session);
  INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,workout_exercise_id,step_position,phase,phase_duration_ms,phase_elapsed_ms,elapsed_ms,occurred_at)
  VALUES (gen_random_uuid(),v_self_session,v_self_attempt,1,'exercise_started',(v_step->>'workout_exercise_id')::uuid,(v_step->>'position')::integer,'work',(v_step->>'work_ms')::bigint,0,0,v_started),
         (gen_random_uuid(),v_self_session,v_self_attempt,2,'exercise_completed',(v_step->>'workout_exercise_id')::uuid,(v_step->>'position')::integer,'work',(v_step->>'work_ms')::bigint,(v_step->>'work_ms')::bigint,v_work_ms,v_started + (v_work_ms || ' milliseconds')::interval);
  PERFORM public.complete_my_training_session(v_self_session);
  INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at)
  VALUES (gen_random_uuid(),v_self_session,v_self_attempt,3,'workout_completed','finished',v_work_ms,v_started + (v_work_ms || ' milliseconds')::interval);
  PERFORM public.finalize_my_workout_session_attempt(v_self_attempt);
  IF NOT EXISTS (SELECT 1 FROM public.workout_results WHERE training_session_id=v_self_session AND athlete_id=v_self_athlete AND athlete_user_id=v_self_profile)
     OR NOT EXISTS (SELECT 1 FROM public.workout_session_attempts WHERE id=v_self_attempt AND athlete_id=v_self_athlete AND athlete_user_id=v_self_profile AND finalization_state='finalized_completed') THEN
    RAISE EXCEPTION 'Same-UUID self execution regressed';
  END IF;
  RESET ROLE;
END;
$validation$;

ROLLBACK;
