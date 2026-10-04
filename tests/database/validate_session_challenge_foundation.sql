-- Execute after all migrations against a disposable PostgreSQL/Supabase test
-- database only. Fixtures are synthetic and are discarded by ROLLBACK.
BEGIN;

DO $validation$
DECLARE
  v_self uuid; v_guardian uuid; v_coach uuid; v_assistant uuid; v_sibling_profile uuid; v_unrelated uuid;
  v_athlete uuid := gen_random_uuid(); v_sibling uuid := gen_random_uuid(); v_team uuid := gen_random_uuid();
  v_base uuid := gen_random_uuid(); v_challenge uuid := gen_random_uuid(); v_hidden uuid := gen_random_uuid(); v_assistant_challenge uuid := gen_random_uuid();
  v_base_step uuid := gen_random_uuid(); v_challenge_step uuid := gen_random_uuid(); v_plan uuid := gen_random_uuid(); v_item uuid := gen_random_uuid(); v_session uuid := gen_random_uuid(); v_plain_session uuid := gen_random_uuid(); v_completion_challenge_session uuid := gen_random_uuid(); v_completion_assigned_session uuid := gen_random_uuid(); v_direct_challenge_session uuid := gen_random_uuid(); v_direct_assigned_session uuid := gen_random_uuid(); v_direct_timestamp_session uuid := gen_random_uuid(); v_attempt uuid := gen_random_uuid();
  v_snapshot jsonb; v_assigned_snapshot jsonb; v_audit_count integer; v_rows integer; v_denied boolean; v_actor uuid;
BEGIN
  -- The validator is self-contained: auth-user creation invokes the repository
  -- profile trigger, and the surrounding transaction rolls all fixtures back.
  v_coach:=gen_random_uuid(); v_assistant:=gen_random_uuid(); v_guardian:=gen_random_uuid(); v_sibling_profile:=gen_random_uuid(); v_unrelated:=gen_random_uuid(); v_self:=gen_random_uuid();
  INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES
    (v_coach,'authenticated','authenticated','challenge-coach@example.invalid','{}','{}',clock_timestamp(),clock_timestamp()),
    (v_assistant,'authenticated','authenticated','challenge-assistant@example.invalid','{}','{}',clock_timestamp(),clock_timestamp()),
    (v_guardian,'authenticated','authenticated','challenge-guardian@example.invalid','{}','{}',clock_timestamp(),clock_timestamp()),
    (v_sibling_profile,'authenticated','authenticated','challenge-sibling@example.invalid','{}','{}',clock_timestamp(),clock_timestamp()),
    (v_unrelated,'authenticated','authenticated','challenge-unrelated@example.invalid','{}','{}',clock_timestamp(),clock_timestamp()),
    (v_self,'authenticated','authenticated','challenge-self@example.invalid','{}','{}',clock_timestamp(),clock_timestamp());
  INSERT INTO public.athletes(id,display_name,created_by_profile_id) VALUES(v_athlete,'Challenge self split',v_coach),(v_sibling,'Challenge sibling',v_coach);
  INSERT INTO public.athlete_profile_relationships(athlete_id,profile_id,role,training_permission,manage_permission,created_by_profile_id) VALUES
    (v_athlete,v_self,'self',true,true,v_coach),(v_athlete,v_guardian,'guardian',true,true,v_coach),(v_sibling,v_sibling_profile,'self',true,true,v_coach);
  IF v_self IS NULL OR v_self=v_athlete THEN RAISE EXCEPTION 'profile/athlete split fixture failed'; END IF;
  INSERT INTO public.teams(id,name,created_by_user_id) VALUES(v_team,'Challenge validator',v_coach);
  -- Legacy team_memberships remains the authorization source for plan-item
  -- RLS. The assistant is therefore genuinely able to target this item.
  INSERT INTO public.team_memberships(team_id,user_id,role,created_by_user_id) VALUES(v_team,v_assistant,'assistant_coach',v_coach);
  INSERT INTO public.team_staff_memberships(team_id,profile_id,role,created_by_profile_id) VALUES(v_team,v_coach,'coach',v_coach),(v_team,v_assistant,'coach',v_coach);
  INSERT INTO public.exercises(id,name) VALUES(gen_random_uuid(),'Base exercise'),(gen_random_uuid(),'Challenge exercise');
  INSERT INTO public.workouts(id,name,visibility,owner_user_id) VALUES(v_base,'Assigned validator','private',v_coach),(v_challenge,'Challenge validator','private',v_coach),(v_hidden,'Hidden validator','private',v_coach);
  INSERT INTO public.workout_exercises(id,workout_id,exercise_id,position,duration_seconds,rest_seconds,exercise_snapshot) VALUES
   (v_base_step,v_base,(SELECT id FROM public.exercises ORDER BY id LIMIT 1),0,10,0,jsonb_build_object('exercise_name','Base exercise')),
   (v_challenge_step,v_challenge,(SELECT id FROM public.exercises ORDER BY id DESC LIMIT 1),0,20,0,jsonb_build_object('exercise_name','Challenge exercise'));
  INSERT INTO public.training_plans(id,name,team_id,owner_user_id,status,kind,visibility) VALUES(v_plan,'Challenge plan',v_team,v_coach,'active','coach','private');
  PERFORM set_config('request.jwt.claim.sub',v_coach::text,true);
  INSERT INTO public.training_plan_items(id,training_plan_id,workout_id,challenge_workout_id,day_offset,position) VALUES(v_item,v_plan,v_base,v_challenge,0,0);
  -- A real assistant is a team coach, but private kind='coach' plans are
  -- owner/admin-only after the plan-library hardening migration.
  PERFORM set_config('request.jwt.claim.sub',v_assistant::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  v_denied:=false; v_rows:=0; BEGIN UPDATE public.training_plan_items SET challenge_workout_id=v_hidden WHERE id=v_item RETURNING id INTO v_actor; GET DIAGNOSTICS v_rows=ROW_COUNT; EXCEPTION WHEN others THEN v_denied:=true; v_rows:=0; END;
  EXECUTE 'RESET ROLE';
  IF NOT v_denied AND v_rows<>0 THEN RAISE EXCEPTION 'cross-staff private challenge content was accepted'; END IF;
  IF (SELECT challenge_workout_id FROM public.training_plan_items WHERE id=v_item) IS NOT DISTINCT FROM v_hidden THEN RAISE EXCEPTION 'cross-staff private challenge content persisted'; END IF;
  IF (SELECT auth.uid()) IS DISTINCT FROM v_assistant THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'assistant fixture identity mismatch'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.team_memberships WHERE team_id=v_team AND user_id=v_assistant AND role='assistant_coach') THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'assistant fixture legacy membership missing'; END IF;
  IF NOT private.is_team_member(v_team,(SELECT auth.uid())) OR NOT private.is_team_coach(v_team,(SELECT auth.uid())) THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'assistant fixture membership helper failed'; END IF;
  IF private.can_manage_training_plan(v_plan,(SELECT auth.uid())) OR private.can_view_training_plan(v_plan,(SELECT auth.uid())) THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'assistant unexpectedly manages private coach plan'; END IF;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub',v_coach::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; v_rows:=0; UPDATE public.training_plan_items SET challenge_workout_id=v_challenge WHERE id=v_item RETURNING id INTO v_actor; GET DIAGNOSTICS v_rows=ROW_COUNT; EXECUTE 'RESET ROLE';
  IF v_rows<>1 OR (SELECT challenge_workout_id FROM public.training_plan_items WHERE id=v_item) IS DISTINCT FROM v_challenge THEN RAISE EXCEPTION 'owner challenge configuration failed'; END IF;
  PERFORM set_config('request.jwt.claim.sub',v_coach::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; v_rows:=0; UPDATE public.training_plan_items SET challenge_workout_id=NULL WHERE id=v_item RETURNING id INTO v_actor; GET DIAGNOSTICS v_rows=ROW_COUNT; EXECUTE 'RESET ROLE';
  IF v_rows<>1 OR (SELECT challenge_workout_id FROM public.training_plan_items WHERE id=v_item) IS NOT NULL THEN RAISE EXCEPTION 'owner challenge removal failed'; END IF;
  PERFORM set_config('request.jwt.claim.sub',v_coach::text,true); UPDATE public.training_plan_items SET challenge_workout_id=v_challenge WHERE id=v_item;
  PERFORM set_config('request.jwt.claim.sub',v_unrelated::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; v_denied:=false; v_rows:=0; BEGIN UPDATE public.training_plan_items SET challenge_workout_id=v_hidden WHERE id=v_item RETURNING id INTO v_actor; GET DIAGNOSTICS v_rows=ROW_COUNT; EXCEPTION WHEN others THEN v_denied:=true; v_rows:=0; END; EXECUTE 'RESET ROLE';
  IF (NOT v_denied AND v_rows<>0) OR (SELECT challenge_workout_id FROM public.training_plan_items WHERE id=v_item) IS DISTINCT FROM v_challenge THEN RAISE EXCEPTION 'unrelated actor changed challenge configuration'; END IF;
  PERFORM set_config('request.jwt.claim.sub',v_coach::text,true);
  INSERT INTO public.training_sessions(id,plan_item_id,athlete_id,coach_user_id,team_id,workout_id,scheduled_date,status) VALUES
    (v_session,v_item,v_athlete,v_coach,v_team,v_base,current_date,'scheduled'),
    (v_plain_session,NULL,v_athlete,v_coach,v_team,v_base,current_date,'scheduled'),
    (v_completion_challenge_session,v_item,v_athlete,v_coach,v_team,v_base,current_date,'scheduled'),
    (v_completion_assigned_session,v_item,v_athlete,v_coach,v_team,v_base,current_date,'scheduled'),
    (v_direct_challenge_session,v_item,v_athlete,v_coach,v_team,v_base,current_date,'scheduled'),
    (v_direct_assigned_session,v_item,v_athlete,v_coach,v_team,v_base,current_date,'scheduled'),
    (v_direct_timestamp_session,v_item,v_athlete,v_coach,v_team,v_base,current_date,'scheduled');
  SELECT steps INTO v_snapshot FROM public.training_session_challenge_prescriptions WHERE session_id=v_session;
  SELECT steps INTO v_assigned_snapshot FROM public.training_session_prescriptions WHERE session_id=v_session;
  IF v_snapshot IS NULL OR v_assigned_snapshot IS NULL OR EXISTS(SELECT 1 FROM public.training_session_challenge_prescriptions WHERE session_id=v_plain_session) THEN RAISE EXCEPTION 'session challenge snapshot cardinality is incorrect'; END IF;
  UPDATE public.workout_exercises SET duration_seconds=77 WHERE id=v_base_step;
  IF (SELECT steps FROM public.training_session_prescriptions WHERE session_id=v_session) IS DISTINCT FROM v_assigned_snapshot THEN RAISE EXCEPTION 'base workout edit rewrote assigned snapshot'; END IF;
  UPDATE public.workout_exercises SET duration_seconds=99 WHERE id=v_challenge_step;
  IF (SELECT steps FROM public.training_session_challenge_prescriptions WHERE session_id=v_session) IS DISTINCT FROM v_snapshot THEN RAISE EXCEPTION 'challenge edit rewrote snapshot'; END IF;
  UPDATE public.training_plan_items SET challenge_workout_id=NULL WHERE id=v_item;
  IF NOT EXISTS(SELECT 1 FROM public.training_session_challenge_prescriptions WHERE session_id=v_session) THEN RAISE EXCEPTION 'relation removal erased snapshot'; END IF;
  PERFORM set_config('request.jwt.claim.sub',v_self::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.select_my_training_session_variant(v_session,'challenge');
  PERFORM public.select_my_training_session_variant(v_session,'challenge');
  -- Canonical completion is the only ordinary result writer. A selected
  -- Challenge must be rejected there, before a result or completion state is
  -- durable. Assigned completion remains supported, and its durable result
  -- must then lock further selection.
  PERFORM public.select_my_training_session_variant(v_completion_challenge_session,'challenge');
  v_denied:=false; BEGIN
    PERFORM public.complete_my_training_session(v_completion_challenge_session);
  EXCEPTION WHEN others THEN
    IF SQLERRM<>'Challenge completion is not available' THEN RAISE; END IF;
    v_denied:=true;
  END;
  IF NOT v_denied
     OR EXISTS(SELECT 1 FROM public.workout_results WHERE training_session_id=v_completion_challenge_session)
     OR (SELECT status FROM public.training_sessions WHERE id=v_completion_challenge_session)='completed'::public.training_session_status
  THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'selected challenge completed through canonical boundary'; END IF;
  PERFORM public.complete_my_training_session(v_completion_assigned_session);
  IF NOT EXISTS(SELECT 1 FROM public.workout_results WHERE training_session_id=v_completion_assigned_session)
     OR (SELECT status FROM public.training_sessions WHERE id=v_completion_assigned_session)<>'completed'::public.training_session_status
  THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'assigned canonical completion failed'; END IF;
  v_denied:=false; BEGIN
    PERFORM public.select_my_training_session_variant(v_completion_assigned_session,'challenge');
  EXCEPTION WHEN others THEN
    IF SQLERRM<>'Challenge selection is locked after workout start' THEN RAISE; END IF;
    v_denied:=true;
  END;
  IF NOT v_denied
     OR EXISTS(SELECT 1 FROM public.training_session_variant_selection_audit WHERE session_id=v_completion_assigned_session)
  THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'completed session accepted challenge selection'; END IF;
  -- The inherited coach/admin session UPDATE path remains valid for normal
  -- session management, but cannot directly complete a selected Challenge.
  -- The actor below is a real authenticated coach under the existing RLS
  -- policy, not the validator's privileged fixture controller.
  PERFORM public.select_my_training_session_variant(v_direct_challenge_session,'challenge');
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub',v_coach::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  v_denied:=false; BEGIN
    UPDATE public.training_sessions SET status='completed' WHERE id=v_direct_challenge_session;
  EXCEPTION WHEN others THEN
    IF SQLERRM<>'Challenge completion is not available' THEN RAISE; END IF;
    v_denied:=true;
  END;
  EXECUTE 'RESET ROLE';
  IF NOT v_denied
     OR (SELECT status FROM public.training_sessions WHERE id=v_direct_challenge_session)='completed'::public.training_session_status
     OR (SELECT selected_variant FROM public.training_session_performed_variants WHERE session_id=v_direct_challenge_session)<>'challenge'
     OR (SELECT count(*) FROM public.training_session_variant_selection_audit WHERE session_id=v_direct_challenge_session)<>1
  THEN RAISE EXCEPTION 'selected challenge completed through direct session status update'; END IF;
  PERFORM set_config('request.jwt.claim.sub',v_coach::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  v_denied:=false; BEGIN
    UPDATE public.training_sessions SET completed_at=clock_timestamp() WHERE id=v_direct_challenge_session;
  EXCEPTION WHEN others THEN
    IF SQLERRM<>'Challenge completion is not available' THEN RAISE; END IF;
    v_denied:=true;
  END;
  EXECUTE 'RESET ROLE';
  IF NOT v_denied
     OR (SELECT completed_at FROM public.training_sessions WHERE id=v_direct_challenge_session) IS NOT NULL
  THEN RAISE EXCEPTION 'selected challenge accepted direct completion timestamp'; END IF;
  PERFORM set_config('request.jwt.claim.sub',v_coach::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  v_rows:=0; UPDATE public.training_sessions SET status='completed' WHERE id=v_direct_assigned_session; GET DIAGNOSTICS v_rows=ROW_COUNT;
  UPDATE public.training_sessions SET notes='ordinary coach session update preserved' WHERE id=v_plain_session;
  EXECUTE 'RESET ROLE';
  IF v_rows<>1
     OR (SELECT status FROM public.training_sessions WHERE id=v_direct_assigned_session)<>'completed'::public.training_session_status
     OR (SELECT notes FROM public.training_sessions WHERE id=v_plain_session)<>'ordinary coach session update preserved'
  THEN RAISE EXCEPTION 'assigned or unrelated direct session update failed'; END IF;
  PERFORM set_config('request.jwt.claim.sub',v_self::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  v_denied:=false; BEGIN
    PERFORM public.select_my_training_session_variant(v_direct_assigned_session,'challenge');
  EXCEPTION WHEN others THEN
    IF SQLERRM<>'Challenge selection is locked after workout start' THEN RAISE; END IF;
    v_denied:=true;
  END;
  IF NOT v_denied
     OR EXISTS(SELECT 1 FROM public.training_session_performed_variants WHERE session_id=v_direct_assigned_session)
     OR EXISTS(SELECT 1 FROM public.training_session_variant_selection_audit WHERE session_id=v_direct_assigned_session)
  THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'directly completed assigned session accepted challenge selection'; END IF;
  -- A direct completion timestamp is also durable execution state. It is
  -- intentionally distinct from the status-first case above: this verifies
  -- the scheduled-but-timestamped state cannot select Challenge.
  PERFORM set_config('request.jwt.claim.sub',v_coach::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  v_rows:=0; UPDATE public.training_sessions SET completed_at=clock_timestamp() WHERE id=v_direct_timestamp_session; GET DIAGNOSTICS v_rows=ROW_COUNT;
  EXECUTE 'RESET ROLE';
  IF v_rows<>1
     OR (SELECT completed_at FROM public.training_sessions WHERE id=v_direct_timestamp_session) IS NULL
     OR (SELECT status FROM public.training_sessions WHERE id=v_direct_timestamp_session)<>'scheduled'::public.training_session_status
  THEN RAISE EXCEPTION 'assigned session direct completion timestamp failed'; END IF;
  PERFORM set_config('request.jwt.claim.sub',v_self::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  v_denied:=false; BEGIN
    PERFORM public.select_my_training_session_variant(v_direct_timestamp_session,'challenge');
  EXCEPTION WHEN others THEN
    IF SQLERRM<>'Challenge selection is locked after workout start' THEN RAISE; END IF;
    v_denied:=true;
  END;
  IF NOT v_denied
     OR EXISTS(SELECT 1 FROM public.training_session_performed_variants WHERE session_id=v_direct_timestamp_session)
     OR EXISTS(SELECT 1 FROM public.training_session_variant_selection_audit WHERE session_id=v_direct_timestamp_session)
     OR (SELECT completed_at FROM public.training_sessions WHERE id=v_direct_timestamp_session) IS NULL
  THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'timestamped assigned session accepted challenge selection'; END IF;
  -- Use the production attempt-registration boundary.  A valid start event may
  -- exist, but a Challenge selection must fail closed before Phase 18B.
  v_denied:=false; BEGIN INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at) VALUES(gen_random_uuid(),v_session,v_attempt,0,'workout_started','ready',0,clock_timestamp()); EXCEPTION WHEN others THEN v_denied:=true; END;
  IF NOT v_denied OR EXISTS(SELECT 1 FROM public.workout_session_events WHERE session_id=v_session AND attempt_id=v_attempt) THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'selected challenge accepted execution event'; END IF;
  v_denied:=false; BEGIN PERFORM public.register_my_workout_session_attempt(v_attempt,v_session); EXCEPTION WHEN others THEN v_denied:=true; END;
  IF NOT v_denied THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'selected challenge registered through assigned attempt path'; END IF;
  PERFORM public.select_my_training_session_variant(v_session,'assigned');
  INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at) VALUES(gen_random_uuid(),v_session,v_attempt,0,'workout_started','ready',0,clock_timestamp());
  PERFORM public.register_my_workout_session_attempt(v_attempt,v_session);
  IF NOT EXISTS(SELECT 1 FROM public.workout_session_attempts WHERE id=v_attempt AND training_session_id=v_session) THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'assigned attempt registration failed'; END IF;
  v_denied:=false; BEGIN PERFORM public.select_my_training_session_variant(v_session,'challenge'); EXCEPTION WHEN others THEN v_denied:=true; END;
  IF NOT v_denied THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'attempt did not lock variant selection'; END IF;
  SELECT count(*) INTO v_audit_count FROM public.training_session_variant_selection_audit WHERE session_id=v_session;
  IF v_audit_count<>2 OR (SELECT selected_variant FROM public.training_session_performed_variants WHERE session_id=v_session)<>'assigned' THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'selection audit/idempotency failed'; END IF;
  v_denied:=false; BEGIN PERFORM public.select_my_training_session_variant(v_plain_session,'challenge'); EXCEPTION WHEN others THEN v_denied:=true; END; IF NOT v_denied THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'missing challenge accepted'; END IF;
  EXECUTE 'RESET ROLE';
  FOR v_self IN SELECT actor FROM (VALUES(v_guardian),(v_coach),(v_sibling_profile),(v_unrelated)) AS actors(actor) LOOP
    PERFORM set_config('request.jwt.claim.sub',v_self::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; v_denied:=false; BEGIN PERFORM public.select_my_training_session_variant(v_session,'challenge'); EXCEPTION WHEN others THEN v_denied:=true; END; EXECUTE 'RESET ROLE'; IF NOT v_denied THEN RAISE EXCEPTION 'non-self selected challenge'; END IF;
  END LOOP;
  EXECUTE 'SET LOCAL ROLE anon'; v_denied:=false; BEGIN PERFORM public.select_my_training_session_variant(v_session,'challenge'); EXCEPTION WHEN others THEN v_denied:=true; END; EXECUTE 'RESET ROLE'; IF NOT v_denied THEN RAISE EXCEPTION 'anon selected challenge'; END IF;
  -- The public selection surface is deliberately only session + constrained
  -- variant: it cannot accept a workout ID or caller-controlled prescription.
  IF (SELECT pg_get_function_arguments('public.select_my_training_session_variant(uuid,public.training_session_performed_variant)'::regprocedure)) IS DISTINCT FROM 'p_session_id uuid, p_variant training_session_performed_variant' THEN RAISE EXCEPTION 'selection RPC signature widened'; END IF;
  IF NOT has_function_privilege('authenticated','public.select_my_training_session_variant(uuid,public.training_session_performed_variant)'::regprocedure,'EXECUTE') OR has_function_privilege('anon','public.select_my_training_session_variant(uuid,public.training_session_performed_variant)'::regprocedure,'EXECUTE') THEN RAISE EXCEPTION 'selection RPC privilege is incorrect'; END IF;
  -- Private writers and the attempt interlock cannot be directly invoked by
  -- application roles. The read helper is intentionally executable by
  -- authenticated because SELECT policies call it.
  IF has_function_privilege('authenticated','private.validate_training_plan_item_challenge()'::regprocedure,'EXECUTE') OR has_function_privilege('authenticated','private.capture_training_session_challenge_prescription_row(uuid,uuid)'::regprocedure,'EXECUTE') OR has_function_privilege('authenticated','private.capture_training_session_challenge_prescription()'::regprocedure,'EXECUTE') OR has_function_privilege('authenticated','private.register_workout_session_attempt_from_event(uuid,uuid)'::regprocedure,'EXECUTE') OR has_function_privilege('anon','private.can_view_challenge_session(uuid)'::regprocedure,'EXECUTE') OR NOT has_function_privilege('authenticated','private.can_view_challenge_session(uuid)'::regprocedure,'EXECUTE') THEN RAISE EXCEPTION 'private helper execute privilege is incorrect'; END IF;
  -- Direct writes are denied independently of the narrow RPC, for every
  -- ordinary actor and anon. Each statement is meaningful against the
  -- session fixture; permission denial is the intended contract.
  FOR v_actor IN SELECT actor FROM (VALUES(v_self),(v_guardian),(v_coach),(v_unrelated),(NULL::uuid)) AS actors(actor) LOOP
    IF v_actor IS NULL THEN EXECUTE 'SET LOCAL ROLE anon'; ELSE PERFORM set_config('request.jwt.claim.sub',v_actor::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; END IF;
    v_denied:=false; BEGIN EXECUTE 'INSERT INTO public.training_session_challenge_prescriptions(session_id) VALUES($1)' USING v_plain_session; EXCEPTION WHEN insufficient_privilege THEN v_denied:=true; END; IF NOT v_denied THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'direct challenge snapshot insert allowed'; END IF;
    v_denied:=false; BEGIN EXECUTE 'UPDATE public.training_session_challenge_prescriptions SET workout_name=''rewritten'' WHERE session_id=$1' USING v_session; EXCEPTION WHEN insufficient_privilege THEN v_denied:=true; END; IF NOT v_denied THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'direct challenge snapshot update allowed'; END IF;
    v_denied:=false; BEGIN EXECUTE 'UPDATE public.training_session_performed_variants SET selected_variant=''challenge'' WHERE session_id=$1' USING v_session; EXCEPTION WHEN insufficient_privilege THEN v_denied:=true; END; IF NOT v_denied THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'direct selected variant update allowed'; END IF;
    v_denied:=false; BEGIN EXECUTE 'INSERT INTO public.training_session_variant_selection_audit(session_id,selected_variant,selected_by_profile_id) VALUES($1,''assigned'',$2)' USING v_session,coalesce(v_actor,v_self); EXCEPTION WHEN insufficient_privilege THEN v_denied:=true; END; IF NOT v_denied THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'direct selection audit insert allowed'; END IF;
    v_denied:=false; BEGIN EXECUTE 'UPDATE public.training_session_variant_selection_audit SET selected_variant=''challenge'' WHERE session_id=$1' USING v_session; EXCEPTION WHEN insufficient_privilege THEN v_denied:=true; END; IF NOT v_denied THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'direct selection audit update allowed'; END IF;
    v_denied:=false; BEGIN EXECUTE 'DELETE FROM public.training_session_variant_selection_audit WHERE session_id=$1' USING v_session; EXCEPTION WHEN insufficient_privilege THEN v_denied:=true; END; IF NOT v_denied THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'direct selection audit delete allowed'; END IF;
    EXECUTE 'RESET ROLE';
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub',v_guardian::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  FOR v_snapshot IN SELECT jsonb_build_object('name',tab.name) FROM (VALUES('training_session_challenge_prescriptions'),('training_session_performed_variants'),('training_session_variant_selection_audit')) AS tab(name) LOOP
    v_denied:=false; BEGIN EXECUTE format('DELETE FROM public.%I WHERE session_id=$1',v_snapshot->>'name') USING v_session; EXCEPTION WHEN insufficient_privilege THEN v_denied:=true; END; IF NOT v_denied THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'direct challenge integrity mutation allowed'; END IF;
  END LOOP; EXECUTE 'RESET ROLE';
END;
$validation$;

ROLLBACK;
