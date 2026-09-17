-- Execute only after retire_direct_authenticated_workout_result_insert.sql.
-- All fixtures and role changes are transaction-local and end in ROLLBACK.
BEGIN;

DO $validation$
DECLARE
  v_self uuid;
  v_guardian uuid;
  v_guardian_without_training uuid;
  v_sibling_guardian uuid;
  v_coach uuid;
  v_assistant uuid;
  v_admin uuid;
  v_unrelated uuid;
  v_child uuid;
  v_team uuid;
  v_self_session uuid;
  v_child_session uuid;
  v_step_id uuid;
  v_step_position integer;
  v_work_ms bigint;
  v_attempt uuid := gen_random_uuid();
  v_child_attempt uuid := gen_random_uuid();
  v_result uuid;
  v_retry uuid;
  v_already boolean;
  v_before_results bigint;
  v_before_attempts bigint;
  v_before_events bigint;
  v_denied boolean;
  v_actor uuid;
BEGIN
  SELECT rel.athlete_id INTO v_self
  FROM public.athlete_profile_relationships AS rel
  WHERE rel.profile_id=rel.athlete_id
    AND rel.role='self'
    AND rel.revoked_at IS NULL
    AND rel.training_permission
  ORDER BY rel.created_at LIMIT 1;
  SELECT id INTO v_guardian FROM public.profiles
  WHERE platform_role <> 'admin' AND id IS DISTINCT FROM v_self ORDER BY id LIMIT 1;
  SELECT id INTO v_guardian_without_training FROM public.profiles
  WHERE platform_role <> 'admin' AND id NOT IN (v_self,v_guardian) ORDER BY id LIMIT 1;
  SELECT id INTO v_sibling_guardian FROM public.profiles
  WHERE platform_role <> 'admin' AND id NOT IN (v_self,v_guardian,v_guardian_without_training) ORDER BY id LIMIT 1;
  SELECT id INTO v_coach FROM public.profiles
  WHERE platform_role <> 'admin' AND id NOT IN (v_self,v_guardian,v_guardian_without_training,v_sibling_guardian) ORDER BY id LIMIT 1;
  SELECT id INTO v_assistant FROM public.profiles
  WHERE platform_role <> 'admin' AND id NOT IN (v_self,v_guardian,v_guardian_without_training,v_sibling_guardian,v_coach) ORDER BY id LIMIT 1;
  SELECT id INTO v_admin FROM public.profiles
  WHERE platform_role='admin' AND id NOT IN (v_self,v_guardian,v_guardian_without_training,v_sibling_guardian,v_coach,v_assistant) ORDER BY id LIMIT 1;
  SELECT id INTO v_unrelated FROM public.profiles
  WHERE platform_role <> 'admin' AND id NOT IN (v_self,v_guardian,v_guardian_without_training,v_sibling_guardian,v_coach,v_assistant) ORDER BY id LIMIT 1;
  IF v_self IS NULL OR v_guardian IS NULL OR v_guardian_without_training IS NULL
     OR v_sibling_guardian IS NULL OR v_coach IS NULL OR v_assistant IS NULL
     OR v_admin IS NULL OR v_unrelated IS NULL THEN
    RAISE EXCEPTION 'Validation requires self, guardian, coach, assistant, admin, and unrelated profiles';
  END IF;

  SELECT count(*) INTO v_before_results FROM public.workout_results;
  SELECT count(*) INTO v_before_attempts FROM public.workout_session_attempts;
  SELECT count(*) INTO v_before_events FROM public.workout_session_events;

  INSERT INTO public.teams (id,name,created_by_user_id)
  VALUES (gen_random_uuid(),'Result INSERT retirement validation',v_coach)
  RETURNING id INTO v_team;
  INSERT INTO public.athletes (id,display_name,created_by_profile_id)
  VALUES (gen_random_uuid(),'Result retirement child',v_guardian)
  RETURNING id INTO v_child;
  INSERT INTO public.athlete_profile_relationships (athlete_id,profile_id,role,training_permission,manage_permission,created_by_profile_id)
  VALUES (v_child,v_guardian,'guardian',true,true,v_guardian),
         (v_child,v_guardian_without_training,'guardian',false,true,v_guardian_without_training);
  INSERT INTO public.team_staff_memberships (team_id,profile_id,role,created_by_profile_id)
  VALUES (v_team,v_coach,'coach',v_coach),(v_team,v_assistant,'assistant_coach',v_coach);

  INSERT INTO public.training_sessions (id,plan_item_id,athlete_id,athlete_user_id,coach_user_id,team_id,workout_id,scheduled_date,status)
  SELECT gen_random_uuid(),item.id,v_self,v_self,v_coach,v_team,item.workout_id,current_date,'scheduled'
  FROM public.training_plan_items AS item LIMIT 1 RETURNING id INTO v_self_session;
  INSERT INTO public.training_sessions (id,plan_item_id,athlete_id,athlete_user_id,coach_user_id,team_id,workout_id,scheduled_date,status)
  SELECT gen_random_uuid(),item.id,v_child,NULL,v_coach,v_team,item.workout_id,current_date,'scheduled'
  FROM public.training_plan_items AS item LIMIT 1 RETURNING id INTO v_child_session;
  IF v_self_session IS NULL OR v_child_session IS NULL THEN
    RAISE EXCEPTION 'Validation requires a training plan item';
  END IF;
  SELECT (prescription.steps->0->>'workout_exercise_id')::uuid,
         (prescription.steps->0->>'position')::integer,
         (prescription.steps->0->>'work_ms')::bigint
    INTO v_step_id,v_step_position,v_work_ms
  FROM public.training_session_prescriptions AS prescription
  WHERE prescription.session_id=v_self_session;
  IF v_step_id IS NULL OR v_work_ms IS NULL THEN
    RAISE EXCEPTION 'Validation requires a captured self-session prescription';
  END IF;

  -- Direct INSERT is forbidden for every ordinary role, including its own
  -- self-athlete. Values are valid enough that failure must be authorization.
  FOREACH v_actor IN ARRAY ARRAY[v_self,v_guardian,v_guardian_without_training,v_sibling_guardian,v_coach,v_assistant,v_admin,v_unrelated] LOOP
    v_denied := false;
    BEGIN
      PERFORM set_config('request.jwt.claim.sub',v_actor::text,true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      INSERT INTO public.workout_results (training_session_id,athlete_id,athlete_user_id,completed_at,active_minutes,total_duration_minutes,exercises_completed,result_data)
      VALUES (v_self_session,v_self,v_self,clock_timestamp(),0,0,0,'{}'::jsonb);
    EXCEPTION WHEN insufficient_privilege THEN
      v_denied := true;
    END;
    EXECUTE 'RESET ROLE';
    IF NOT v_denied THEN RAISE EXCEPTION 'Authenticated direct workout result INSERT was allowed'; END IF;
  END LOOP;
  v_denied := false;
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    INSERT INTO public.workout_results (training_session_id,athlete_id,athlete_user_id,completed_at,active_minutes,total_duration_minutes,exercises_completed,result_data)
    VALUES (v_self_session,v_self,v_self,clock_timestamp(),0,0,0,'{}'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  EXECUTE 'RESET ROLE';
  IF NOT v_denied THEN RAISE EXCEPTION 'Anon direct workout result INSERT was allowed'; END IF;

  -- Current self path: append-only telemetry begins, the canonical RPC writes
  -- the result, terminal telemetry follows, and materialization finalizes it.
  PERFORM set_config('request.jwt.claim.sub',v_self::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO public.workout_session_events (id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at)
  VALUES (gen_random_uuid(),v_self_session,v_attempt,0,'workout_started','ready',0,clock_timestamp());
  INSERT INTO public.workout_session_events (id,session_id,attempt_id,sequence,event_type,workout_exercise_id,step_position,phase,phase_duration_ms,phase_elapsed_ms,elapsed_ms,occurred_at)
  VALUES (gen_random_uuid(),v_self_session,v_attempt,1,'exercise_started',v_step_id,v_step_position,'work',v_work_ms,0,0,clock_timestamp()),
         (gen_random_uuid(),v_self_session,v_attempt,2,'exercise_completed',v_step_id,v_step_position,'work',v_work_ms,v_work_ms,v_work_ms,clock_timestamp());
  PERFORM public.register_my_workout_session_attempt(v_attempt,v_self_session);
  SELECT result_id,already_completed INTO v_result,v_already
  FROM public.complete_my_training_session(v_self_session);
  IF v_result IS NULL OR v_already THEN RAISE EXCEPTION 'Canonical self completion failed after direct INSERT retirement'; END IF;
  INSERT INTO public.workout_session_events (id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at)
  VALUES (gen_random_uuid(),v_self_session,v_attempt,3,'workout_completed','finished',v_work_ms,clock_timestamp());
  PERFORM public.finalize_my_workout_session_attempt(v_attempt);
  EXECUTE 'RESET ROLE';

  IF NOT EXISTS (
    SELECT 1 FROM public.workout_results AS result
    JOIN public.training_sessions AS session ON session.id=result.training_session_id
    JOIN public.training_session_prescriptions AS prescription ON prescription.session_id=session.id
    JOIN public.workout_session_attempts AS attempt ON attempt.workout_result_id=result.id
    WHERE result.id=v_result
      AND result.athlete_id=session.athlete_id
      AND result.athlete_user_id=session.athlete_user_id
      AND result.started_at IS NULL
      AND result.completed_at IS NOT NULL
      AND session.status='completed'
      AND result.active_minutes=ceil(prescription.prescribed_work_ms/60000.0)::integer
      AND result.total_duration_minutes=ceil(prescription.prescribed_total_ms/60000.0)::integer
      AND result.exercises_completed=prescription.step_count
      AND attempt.athlete_id=session.athlete_id
      AND attempt.athlete_user_id=session.athlete_user_id
      AND attempt.finalization_state='finalized_completed'
      AND attempt.measurement_version=1
      AND attempt.measurement_quality='complete'
  ) THEN RAISE EXCEPTION 'Canonical result, session synchronization, or finalized attempt integrity failed'; END IF;

  PERFORM set_config('request.jwt.claim.sub',v_self::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT result_id,already_completed INTO v_retry,v_already
  FROM public.complete_my_training_session(v_self_session);
  EXECUTE 'RESET ROLE';
  IF v_retry IS DISTINCT FROM v_result OR NOT v_already
     OR (SELECT count(*) FROM public.workout_results WHERE training_session_id=v_self_session) <> 1 THEN
    RAISE EXCEPTION 'Canonical completion retry was not idempotent';
  END IF;

  -- A valid-looking child start event is seeded by the privileged fixture only
  -- so the public calls test the transitional authorization gate, not telemetry absence.
  INSERT INTO public.workout_session_events (id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at)
  VALUES (gen_random_uuid(),v_child_session,v_child_attempt,0,'workout_started','ready',0,clock_timestamp());
  PERFORM set_config('request.jwt.claim.sub',v_guardian::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_denied:=false;
  BEGIN PERFORM public.complete_my_training_session(v_child_session); EXCEPTION WHEN others THEN v_denied:=true; END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Guardian child completion was allowed before family cutover'; END IF;
  v_denied:=false;
  BEGIN PERFORM public.register_my_workout_session_attempt(v_child_attempt,v_child_session); EXCEPTION WHEN others THEN v_denied:=true; END;
  EXECUTE 'RESET ROLE';
  IF NOT v_denied THEN RAISE EXCEPTION 'Guardian child attempt registration was allowed before family cutover'; END IF;
  IF EXISTS (SELECT 1 FROM public.workout_results WHERE training_session_id=v_child_session)
     OR EXISTS (SELECT 1 FROM public.workout_session_attempts WHERE training_session_id=v_child_session) THEN
    RAISE EXCEPTION 'Family gate failure persisted child execution history';
  END IF;

  PERFORM set_config('request.jwt.claim.sub',v_self::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_denied:=false;
  BEGIN
    INSERT INTO public.workout_session_events (id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at)
    VALUES (gen_random_uuid(),v_self_session,v_attempt,4,'page_visible','work',v_work_ms,clock_timestamp());
  EXCEPTION WHEN others THEN v_denied:=true;
  END;
  EXECUTE 'RESET ROLE';
  IF NOT v_denied THEN RAISE EXCEPTION 'Late event was accepted after finalization'; END IF;

  IF has_table_privilege('authenticated','public.workout_results','INSERT')
     OR has_table_privilege('anon','public.workout_results','INSERT')
     OR has_table_privilege('public','public.workout_results','INSERT')
     OR has_table_privilege('authenticated','public.workout_results','UPDATE')
     OR has_table_privilege('authenticated','public.workout_results','DELETE')
     OR has_table_privilege('authenticated','public.workout_results','TRUNCATE') THEN
    RAISE EXCEPTION 'Ordinary result privilege hardening failed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.workout_results'::regclass AND conname='workout_results_training_session_id_key' AND contype='u')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.workout_results'::regclass AND conname='workout_results_training_session_id_fkey' AND confdeltype='r')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.workout_results'::regclass AND conname='workout_results_athlete_id_fkey' AND confdeltype='r')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.workout_results'::regclass AND conname='workout_results_athlete_user_id_fkey' AND confdeltype='r')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.workout_results'::regclass AND conname='workout_results_owner_present' AND convalidated) THEN
    RAISE EXCEPTION 'Historical result constraint protection changed';
  END IF;
  IF (SELECT count(*) FROM public.workout_results) <> v_before_results+1
     OR (SELECT count(*) FROM public.workout_session_attempts) <> v_before_attempts+1
     OR (SELECT count(*) FROM public.workout_session_events) <> v_before_events+5 THEN
    RAISE EXCEPTION 'Validation fixture count differs; historical results, attempts, or events may have changed';
  END IF;
END;
$validation$;

ROLLBACK;
