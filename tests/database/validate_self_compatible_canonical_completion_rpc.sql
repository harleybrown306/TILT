-- Execute only after create_self_compatible_canonical_completion_rpc.sql.
-- All data and role fixtures are transaction-local and roll back.
BEGIN;

DO $validation$
DECLARE
  v_self uuid;
  v_guardian uuid;
  v_guardian_without_training uuid;
  v_coach uuid;
  v_assistant uuid;
  v_admin uuid;
  v_unrelated uuid;
  v_child uuid;
  v_sibling uuid;
  v_team uuid;
  v_self_session uuid;
  v_child_session uuid;
  v_sibling_session uuid;
  v_result uuid;
  v_retry uuid;
  v_already boolean;
  v_before_results bigint;
  v_before_attempts bigint;
  v_before_events bigint;
  v_failed boolean;
  v_actor uuid;
BEGIN
  SELECT relationship.athlete_id INTO v_self
  FROM public.athlete_profile_relationships AS relationship
  WHERE relationship.profile_id=relationship.athlete_id AND relationship.role='self'
    AND relationship.revoked_at IS NULL AND relationship.training_permission
  ORDER BY relationship.created_at LIMIT 1;
  SELECT id INTO v_guardian FROM public.profiles
  WHERE platform_role <> 'admin' AND id <> v_self ORDER BY id LIMIT 1;
  SELECT id INTO v_guardian_without_training FROM public.profiles
  WHERE platform_role <> 'admin' AND id NOT IN (v_self, v_guardian) ORDER BY id LIMIT 1;
  SELECT id INTO v_coach FROM public.profiles
  WHERE platform_role <> 'admin' AND id NOT IN (v_self,v_guardian,v_guardian_without_training) ORDER BY id LIMIT 1;
  SELECT id INTO v_assistant FROM public.profiles
  WHERE platform_role <> 'admin' AND id NOT IN (v_self,v_guardian,v_guardian_without_training,v_coach) ORDER BY id LIMIT 1;
  SELECT id INTO v_admin FROM public.profiles
  WHERE platform_role='admin' AND id NOT IN (v_self,v_guardian,v_guardian_without_training,v_coach,v_assistant) ORDER BY id LIMIT 1;
  SELECT id INTO v_unrelated FROM public.profiles
  WHERE platform_role <> 'admin' AND id NOT IN (v_self,v_guardian,v_guardian_without_training,v_coach,v_assistant) ORDER BY id LIMIT 1;
  IF v_self IS NULL OR v_guardian IS NULL OR v_guardian_without_training IS NULL OR v_coach IS NULL OR v_assistant IS NULL OR v_admin IS NULL OR v_unrelated IS NULL THEN
    RAISE EXCEPTION 'Validation requires self, two guardians, coach, assistant, admin, and unrelated profiles';
  END IF;
  SELECT count(*) INTO v_before_results FROM public.workout_results;
  SELECT count(*) INTO v_before_attempts FROM public.workout_session_attempts;
  SELECT count(*) INTO v_before_events FROM public.workout_session_events;

  INSERT INTO public.teams (id,name,created_by_user_id)
  VALUES (gen_random_uuid(),'Canonical completion validation',v_coach) RETURNING id INTO v_team;
  INSERT INTO public.athletes (id,display_name,created_by_profile_id)
  VALUES (gen_random_uuid(),'Completion child',v_guardian) RETURNING id INTO v_child;
  INSERT INTO public.athletes (id,display_name,created_by_profile_id)
  VALUES (gen_random_uuid(),'Completion sibling',v_guardian) RETURNING id INTO v_sibling;
  INSERT INTO public.athlete_profile_relationships (athlete_id,profile_id,role,training_permission,manage_permission,created_by_profile_id)
  VALUES (v_child,v_guardian,'guardian',true,true,v_guardian),
         (v_child,v_guardian_without_training,'guardian',false,true,v_guardian_without_training),
         (v_sibling,v_guardian,'guardian',true,true,v_guardian);
  INSERT INTO public.team_staff_memberships (team_id,profile_id,role,created_by_profile_id)
  VALUES (v_team,v_coach,'coach',v_coach),(v_team,v_assistant,'assistant_coach',v_coach);
  INSERT INTO public.training_sessions (id,plan_item_id,athlete_id,athlete_user_id,coach_user_id,team_id,workout_id,scheduled_date,status)
  SELECT gen_random_uuid(),item.id,v_self,v_self,v_coach,v_team,item.workout_id,current_date,'scheduled' FROM public.training_plan_items item LIMIT 1 RETURNING id INTO v_self_session;
  INSERT INTO public.training_sessions (id,plan_item_id,athlete_id,athlete_user_id,coach_user_id,team_id,workout_id,scheduled_date,status)
  SELECT gen_random_uuid(),item.id,v_child,NULL,v_coach,v_team,item.workout_id,current_date,'scheduled' FROM public.training_plan_items item LIMIT 1 RETURNING id INTO v_child_session;
  INSERT INTO public.training_sessions (id,plan_item_id,athlete_id,athlete_user_id,coach_user_id,team_id,workout_id,scheduled_date,status)
  SELECT gen_random_uuid(),item.id,v_sibling,NULL,v_coach,v_team,item.workout_id,current_date,'scheduled' FROM public.training_plan_items item LIMIT 1 RETURNING id INTO v_sibling_session;
  IF v_self_session IS NULL OR v_child_session IS NULL OR v_sibling_session IS NULL THEN RAISE EXCEPTION 'Validation requires a training plan item'; END IF;

  PERFORM set_config('request.jwt.claim.sub',v_self::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT result_id,already_completed INTO v_result,v_already FROM public.complete_my_training_session(v_self_session);
  EXECUTE 'RESET ROLE';
  IF v_result IS NULL OR v_already OR NOT EXISTS (
    SELECT 1 FROM public.workout_results r JOIN public.training_sessions s ON s.id=r.training_session_id
    JOIN public.training_session_prescriptions p ON p.session_id=s.id
    WHERE r.id=v_result AND r.athlete_id=s.athlete_id AND r.athlete_user_id=s.athlete_user_id
      AND r.started_at IS NULL AND r.completed_at IS NOT NULL AND s.status='completed'
      AND r.active_minutes=ceil(p.prescribed_work_ms/60000.0)::integer
      AND r.total_duration_minutes=ceil(p.prescribed_total_ms/60000.0)::integer
      AND r.exercises_completed=p.step_count
      AND r.result_data=jsonb_build_object('workout_name',p.workout_name,'completed_steps',p.step_count)
  ) THEN RAISE EXCEPTION 'Self canonical completion did not derive trusted result fields or synchronize session'; END IF;

  PERFORM set_config('request.jwt.claim.sub',v_self::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT result_id,already_completed INTO v_retry,v_already FROM public.complete_my_training_session(v_self_session);
  EXECUTE 'RESET ROLE';
  IF v_retry IS DISTINCT FROM v_result OR NOT v_already OR (SELECT count(*) FROM public.workout_results WHERE training_session_id=v_self_session) <> 1 THEN
    RAISE EXCEPTION 'Canonical completion retry was not idempotent';
  END IF;

  FOREACH v_actor IN ARRAY ARRAY[v_guardian,v_guardian_without_training,v_coach,v_assistant,v_admin,v_unrelated] LOOP
    v_failed:=false;
    BEGIN
      PERFORM set_config('request.jwt.claim.sub',v_actor::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
      PERFORM public.complete_my_training_session(v_child_session); EXECUTE 'RESET ROLE';
    EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; v_failed:=true;
    END;
    IF NOT v_failed THEN RAISE EXCEPTION 'Transitional completion gate allowed a non-self child execution'; END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub',v_guardian::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  v_failed:=false;
  BEGIN PERFORM public.complete_my_training_session(v_sibling_session); EXCEPTION WHEN others THEN v_failed:=true; END;
  EXECUTE 'RESET ROLE';
  IF NOT v_failed THEN RAISE EXCEPTION 'Sibling guardian completion was allowed'; END IF;
  IF EXISTS (SELECT 1 FROM public.workout_results WHERE training_session_id IN (v_child_session,v_sibling_session)) THEN
    RAISE EXCEPTION 'Transitional completion produced a child result';
  END IF;

  PERFORM set_config('request.jwt.claim.sub',v_self::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  v_failed:=false;
  BEGIN PERFORM public.complete_my_training_session(gen_random_uuid()); EXCEPTION WHEN others THEN v_failed:=true; END;
  EXECUTE 'RESET ROLE';
  IF NOT v_failed THEN RAISE EXCEPTION 'Missing session completion was allowed'; END IF;
  IF has_table_privilege('authenticated','public.workout_results','UPDATE') OR has_table_privilege('authenticated','public.workout_results','DELETE') THEN
    RAISE EXCEPTION 'Historical result immutability changed';
  END IF;
  IF (SELECT count(*) FROM public.workout_results) <> v_before_results+1 OR (SELECT count(*) FROM public.workout_session_attempts) <> v_before_attempts OR (SELECT count(*) FROM public.workout_session_events) <> v_before_events THEN
    RAISE EXCEPTION 'Validation fixture count differs; historical execution rows may have changed';
  END IF;
END;
$validation$;

ROLLBACK;
