-- Execute only after create_training_session_act_capability_rpc.sql.
-- Every fixture and assertion is transaction-local and removed by ROLLBACK.
BEGIN;

DO $validation$
DECLARE
  v_self_athlete uuid; v_self_profile uuid; v_guardian uuid; v_view_only uuid;
  v_sibling uuid; v_coach uuid; v_assistant uuid; v_admin uuid; v_unrelated uuid;
  v_child uuid; v_sibling_child uuid; v_distinct_self_athlete uuid;
  v_team uuid; v_exercise uuid; v_workout uuid;
  v_child_session uuid; v_sibling_session uuid; v_self_session uuid; v_distinct_self_session uuid;
  v_before_sessions bigint; v_before_prescriptions bigint; v_before_results bigint;
  v_before_attempts bigint; v_before_events bigint; v_public_execute boolean; v_actor uuid;
BEGIN
  SELECT athlete_id, profile_id INTO v_self_athlete, v_self_profile
  FROM public.athlete_profile_relationships
  WHERE role='self' AND revoked_at IS NULL AND training_permission
  ORDER BY created_at LIMIT 1;
  SELECT id INTO v_admin FROM public.profiles WHERE platform_role='admin' ORDER BY id LIMIT 1;
  SELECT id INTO v_guardian FROM public.profiles WHERE id NOT IN (v_self_profile,v_admin) ORDER BY id LIMIT 1;
  SELECT id INTO v_view_only FROM public.profiles WHERE id NOT IN (v_self_profile,v_admin,v_guardian) ORDER BY id LIMIT 1;
  SELECT id INTO v_sibling FROM public.profiles WHERE id NOT IN (v_self_profile,v_admin,v_guardian,v_view_only) ORDER BY id LIMIT 1;
  SELECT id INTO v_coach FROM public.profiles WHERE id NOT IN (v_self_profile,v_admin,v_guardian,v_view_only,v_sibling) ORDER BY id LIMIT 1;
  SELECT id INTO v_assistant FROM public.profiles WHERE id NOT IN (v_self_profile,v_admin,v_guardian,v_view_only,v_sibling,v_coach) ORDER BY id LIMIT 1;
  SELECT id INTO v_unrelated FROM public.profiles WHERE id NOT IN (v_self_profile,v_admin,v_guardian,v_view_only,v_sibling,v_coach,v_assistant) ORDER BY id LIMIT 1;
  IF v_self_athlete IS NULL OR v_self_profile IS NULL OR v_admin IS NULL OR v_guardian IS NULL
     OR v_view_only IS NULL OR v_sibling IS NULL OR v_coach IS NULL OR v_assistant IS NULL OR v_unrelated IS NULL THEN
    RAISE EXCEPTION 'ACT capability validation requires eight profiles and one active self athlete';
  END IF;

  SELECT count(*) INTO v_before_sessions FROM public.training_sessions;
  SELECT count(*) INTO v_before_prescriptions FROM public.training_session_prescriptions;
  SELECT count(*) INTO v_before_results FROM public.workout_results;
  SELECT count(*) INTO v_before_attempts FROM public.workout_session_attempts;
  SELECT count(*) INTO v_before_events FROM public.workout_session_events;

  INSERT INTO public.exercises(name,visibility) VALUES ('Rollback ACT capability exercise ' || gen_random_uuid()::text,'private') RETURNING id INTO v_exercise;
  INSERT INTO public.workouts(name,visibility) VALUES ('Rollback ACT capability workout ' || gen_random_uuid()::text,'private') RETURNING id INTO v_workout;
  INSERT INTO public.workout_exercises(workout_id,exercise_id,position,duration_seconds,rest_seconds,exercise_snapshot)
  VALUES (v_workout,v_exercise,0,60,0,jsonb_build_object('exercise_name','Rollback ACT capability exercise'));
  INSERT INTO public.teams(id,name,created_by_user_id) VALUES (gen_random_uuid(),'Rollback ACT capability team ' || gen_random_uuid()::text,v_guardian) RETURNING id INTO v_team;
  INSERT INTO public.athletes(id,display_name,created_by_profile_id) VALUES (gen_random_uuid(),'Rollback capability child',v_guardian) RETURNING id INTO v_child;
  INSERT INTO public.athletes(id,display_name,created_by_profile_id) VALUES (gen_random_uuid(),'Rollback capability sibling',v_sibling) RETURNING id INTO v_sibling_child;
  INSERT INTO public.athletes(id,display_name,created_by_profile_id) VALUES (gen_random_uuid(),'Rollback distinct-login self',v_unrelated) RETURNING id INTO v_distinct_self_athlete;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id IN (v_child,v_sibling_child)) THEN RAISE EXCEPTION 'No-auth fixture child unexpectedly has profile'; END IF;
  INSERT INTO public.athlete_profile_relationships(athlete_id,profile_id,role,training_permission,manage_permission,created_by_profile_id)
  VALUES (v_child,v_guardian,'guardian',true,true,v_guardian),
         (v_child,v_view_only,'guardian',false,true,v_guardian),
         (v_sibling_child,v_sibling,'guardian',true,true,v_sibling),
         (v_distinct_self_athlete,v_unrelated,'self',true,true,v_unrelated);
  INSERT INTO public.team_staff_memberships(team_id,profile_id,role,created_by_profile_id)
  VALUES (v_team,v_guardian,'coach',v_guardian),(v_team,v_coach,'coach',v_guardian),(v_team,v_assistant,'assistant_coach',v_guardian);
  INSERT INTO public.team_athlete_memberships(team_id,athlete_id,created_by_profile_id)
  VALUES (v_team,v_child,v_guardian);
  INSERT INTO public.training_sessions(athlete_id,athlete_user_id,coach_user_id,team_id,workout_id,scheduled_date,status)
  VALUES (v_child,NULL,v_guardian,v_team,v_workout,current_date,'scheduled') RETURNING id INTO v_child_session;
  INSERT INTO public.training_sessions(athlete_id,athlete_user_id,coach_user_id,team_id,workout_id,scheduled_date,status)
  VALUES (v_sibling_child,NULL,v_guardian,v_team,v_workout,current_date,'scheduled') RETURNING id INTO v_sibling_session;
  INSERT INTO public.training_sessions(athlete_id,athlete_user_id,coach_user_id,team_id,workout_id,scheduled_date,status)
  VALUES (v_self_athlete,v_self_profile,v_guardian,v_team,v_workout,current_date,'scheduled') RETURNING id INTO v_self_session;
  INSERT INTO public.training_sessions(athlete_id,athlete_user_id,coach_user_id,team_id,workout_id,scheduled_date,status)
  VALUES (v_distinct_self_athlete,NULL,v_guardian,v_team,v_workout,current_date,'scheduled') RETURNING id INTO v_distinct_self_session;

  -- Authenticated execution is the only public capability grant; private helper is unchanged.
  SELECT COALESCE(bool_or(x.privilege_type='EXECUTE') FILTER (WHERE x.grantee=0),false) INTO v_public_execute
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x
  WHERE n.nspname='public' AND p.proname='can_act_for_training_session' AND p.oid::regprocedure::text='can_act_for_training_session(uuid)';
  IF v_public_execute OR has_function_privilege('anon','public.can_act_for_training_session(uuid)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.can_act_for_training_session(uuid)','EXECUTE')
     OR NOT has_function_privilege('authenticated','private.can_act_for_training_session(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'ACT capability function privilege matrix is incorrect';
  END IF;

  PERFORM set_config('request.jwt.claim.sub',v_self_profile::text,true); SET LOCAL ROLE authenticated;
  IF NOT public.can_act_for_training_session(v_self_session) OR public.can_act_for_training_session(NULL) OR public.can_act_for_training_session(gen_random_uuid()) THEN RAISE EXCEPTION 'Self or null/nonexistent capability result incorrect'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub',v_guardian::text,true); SET LOCAL ROLE authenticated;
  IF NOT public.can_act_for_training_session(v_child_session) OR public.can_act_for_training_session(v_sibling_session) THEN RAISE EXCEPTION 'Guardian capability result incorrect'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub',v_view_only::text,true); SET LOCAL ROLE authenticated;
  PERFORM 1 FROM public.training_sessions WHERE id=v_child_session;
  IF NOT FOUND OR public.can_act_for_training_session(v_child_session) THEN RAISE EXCEPTION 'VIEW-only guardian did not remain VIEW-only'; END IF;
  RESET ROLE;
  FOREACH v_actor IN ARRAY ARRAY[v_sibling,v_coach,v_assistant,v_admin,v_unrelated] LOOP
    PERFORM set_config('request.jwt.claim.sub',v_actor::text,true); SET LOCAL ROLE authenticated;
    IF public.can_act_for_training_session(v_child_session) THEN RAISE EXCEPTION 'Non-family role received ACT capability'; END IF;
    RESET ROLE;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub',v_unrelated::text,true); SET LOCAL ROLE authenticated;
  IF NOT public.can_act_for_training_session(v_distinct_self_session) THEN RAISE EXCEPTION 'Distinct-login self relationship did not receive ACT'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub',v_guardian::text,true); SET LOCAL ROLE authenticated;
  IF NOT public.can_act_for_training_session(v_child_session) THEN RAISE EXCEPTION 'Coach+guardian did not receive ACT'; END IF;
  RESET ROLE;
  UPDATE public.athlete_profile_relationships SET revoked_at=clock_timestamp() WHERE athlete_id=v_child AND profile_id=v_guardian AND role='guardian';
  PERFORM set_config('request.jwt.claim.sub',v_guardian::text,true); SET LOCAL ROLE authenticated;
  IF public.can_act_for_training_session(v_child_session) THEN RAISE EXCEPTION 'Coach retained ACT after guardian relationship revocation'; END IF;
  RESET ROLE;
  SET LOCAL ROLE anon;
  BEGIN PERFORM public.can_act_for_training_session(v_child_session); RAISE EXCEPTION 'Anon executed ACT capability'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RESET ROLE;

  IF (SELECT count(*) FROM public.training_sessions)<>v_before_sessions+4
     OR (SELECT count(*) FROM public.training_session_prescriptions)<>v_before_prescriptions+4
     OR (SELECT count(*) FROM public.workout_results)<>v_before_results
     OR (SELECT count(*) FROM public.workout_session_attempts)<>v_before_attempts
     OR (SELECT count(*) FROM public.workout_session_events)<>v_before_events THEN
    RAISE EXCEPTION 'Capability calls changed execution or documented training rows';
  END IF;
END;
$validation$;

ROLLBACK;
