-- Execute only after create_family_first_assignment_rpc_foundation.sql is applied.
-- Every fixture is rollback-only and must leave no product data behind.
BEGIN;

DO $validation$
DECLARE
  v_coach uuid; v_guardian uuid; v_admin uuid; v_self uuid; v_plan uuid;
  v_team uuid; v_child uuid; v_unrostered uuid; v_item uuid; v_workout uuid;
  v_batch_self uuid := gen_random_uuid(); v_batch_child uuid := gen_random_uuid();
  v_batch_assistant uuid := gen_random_uuid(); v_batch_bad uuid := gen_random_uuid();
  v_batch_missing_session uuid := gen_random_uuid(); v_batch_missing_prescription uuid := gen_random_uuid();
  v_batch_bad_ownership uuid := gen_random_uuid(); v_direct_session uuid := gen_random_uuid();
  v_before_assignments bigint; v_before_sessions bigint; v_before_retry_assignments bigint;
  v_before_retry_sessions bigint; v_count bigint; v_failed boolean; v_legacy_assignment uuid;
BEGIN
  SELECT plan.owner_user_id, plan.id INTO v_coach, v_plan
  FROM public.training_plans AS plan
  WHERE plan.kind = 'coach' AND plan.visibility = 'private' AND plan.status = 'active'
    AND EXISTS (SELECT 1 FROM public.training_plan_items AS item WHERE item.training_plan_id = plan.id)
  ORDER BY plan.id LIMIT 1;
  SELECT relationship.athlete_id INTO v_self
  FROM public.athlete_profile_relationships AS relationship
  WHERE relationship.profile_id = relationship.athlete_id
    AND relationship.role = 'self' AND relationship.revoked_at IS NULL
  ORDER BY relationship.created_at LIMIT 1;
  SELECT profile.id INTO v_guardian
  FROM public.profiles AS profile
  WHERE profile.id NOT IN (v_coach, v_self) AND profile.platform_role <> 'admin'
  ORDER BY profile.id LIMIT 1;
  SELECT profile.id INTO v_admin
  FROM public.profiles AS profile
  WHERE profile.platform_role = 'admin' AND profile.id NOT IN (v_coach, v_self, v_guardian)
  ORDER BY profile.id LIMIT 1;
  SELECT item.id, item.workout_id INTO v_item, v_workout
  FROM public.training_plan_items AS item
  WHERE item.training_plan_id = v_plan
  ORDER BY item.day_offset, item.position LIMIT 1;
  IF v_coach IS NULL OR v_plan IS NULL OR v_self IS NULL OR v_guardian IS NULL
     OR v_admin IS NULL OR v_item IS NULL THEN
    RAISE EXCEPTION 'Validation requires an active private coach plan, self athlete, guardian, admin, and plan item';
  END IF;

  SELECT count(*) INTO v_before_assignments FROM public.training_plan_assignments;
  SELECT count(*) INTO v_before_sessions FROM public.training_sessions;
  INSERT INTO public.teams (id, name, created_by_user_id)
  VALUES (gen_random_uuid(), 'Assignment RPC validation', v_coach)
  RETURNING id INTO v_team;
  INSERT INTO public.athletes (id, display_name, created_by_profile_id)
  VALUES (gen_random_uuid(), 'No-auth assignment child', v_guardian)
  RETURNING id INTO v_child;
  INSERT INTO public.athletes (id, display_name, created_by_profile_id)
  VALUES (gen_random_uuid(), 'Unrostered assignment child', v_guardian)
  RETURNING id INTO v_unrostered;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id IN (v_child, v_unrostered)) THEN
    RAISE EXCEPTION 'No-auth validation child unexpectedly has a profile';
  END IF;
  INSERT INTO public.athlete_profile_relationships
    (athlete_id, profile_id, role, training_permission, manage_permission, created_by_profile_id)
  VALUES
    (v_child, v_guardian, 'guardian', true, true, v_guardian),
    (v_unrostered, v_guardian, 'guardian', true, true, v_guardian);
  INSERT INTO public.team_staff_memberships (team_id, profile_id, role, created_by_profile_id)
  VALUES (v_team, v_coach, 'coach', v_coach);
  INSERT INTO public.team_athlete_memberships (team_id, athlete_id, created_by_profile_id)
  VALUES (v_team, v_self, v_coach), (v_team, v_child, v_coach);

  -- The legacy RLS branches still consult team_memberships. These rows make
  -- the authenticated legacy assignment/session tests exercise that real path.
  INSERT INTO public.team_memberships (team_id, user_id, role, created_by_user_id)
  VALUES (v_team, v_self, 'athlete', v_coach);

  -- Canonical self-athlete generation and exact retry run as authenticated.
  PERFORM set_config('request.jwt.claim.sub', v_coach::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.assign_my_team_training(v_batch_self, v_team, v_plan, current_date, '  self note  ', ARRAY[v_self, v_self]);
  PERFORM public.assign_my_team_training(v_batch_self, v_team, v_plan, current_date, 'self note', ARRAY[v_self]);
  EXECUTE 'RESET ROLE';
  SELECT count(*) INTO v_count FROM public.training_plan_assignments WHERE assignment_batch_id = v_batch_self;
  IF v_count <> 1 THEN RAISE EXCEPTION 'duplicate recipient or retry created duplicate assignment'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.training_plan_assignments
    WHERE assignment_batch_id = v_batch_self AND athlete_id = v_self
      AND athlete_user_id = v_self AND assigned_by_user_id = v_coach
  ) THEN RAISE EXCEPTION 'canonical self athlete ownership or actor provenance is incorrect'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.training_sessions AS session
    JOIN public.training_plan_assignments AS assignment ON assignment.id = session.assignment_id
    JOIN public.training_session_prescriptions AS prescription ON prescription.session_id = session.id
    WHERE assignment.assignment_batch_id = v_batch_self AND session.athlete_id = v_self
      AND session.athlete_user_id = v_self AND prescription.workout_id = session.workout_id
  ) THEN RAISE EXCEPTION 'canonical self session propagation or prescription capture failed'; END IF;

  -- Canonical no-auth-child generation has no legacy auth-user owner.
  PERFORM set_config('request.jwt.claim.sub', v_coach::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.assign_my_team_training(v_batch_child, v_team, v_plan, current_date, NULL, ARRAY[v_child]);
  EXECUTE 'RESET ROLE';
  IF NOT EXISTS (
    SELECT 1 FROM public.training_plan_assignments
    WHERE assignment_batch_id = v_batch_child AND athlete_id = v_child
      AND athlete_user_id IS NULL AND assigned_by_user_id = v_coach
  ) THEN RAISE EXCEPTION 'canonical no-auth child ownership did not propagate'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.training_sessions AS session
    JOIN public.training_plan_assignments AS assignment ON assignment.id = session.assignment_id
    JOIN public.training_session_prescriptions AS prescription ON prescription.session_id = session.id
    WHERE assignment.assignment_batch_id = v_batch_child AND session.athlete_id = v_child
      AND session.athlete_user_id IS NULL AND prescription.workout_id = session.workout_id
  ) THEN RAISE EXCEPTION 'canonical no-auth child session or prescription missing'; END IF;

  -- Assistant authority remains canonical staff/roster authority.
  INSERT INTO public.team_staff_memberships (team_id, profile_id, role, created_by_profile_id)
  VALUES (v_team, v_coach, 'assistant_coach', v_coach)
  ON CONFLICT (team_id, profile_id) DO UPDATE SET role = EXCLUDED.role;
  PERFORM set_config('request.jwt.claim.sub', v_coach::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.assign_my_team_training(v_batch_assistant, v_team, v_plan, current_date, NULL, ARRAY[v_self]);
  EXECUTE 'RESET ROLE';
  UPDATE public.team_staff_memberships SET role = 'coach' WHERE team_id = v_team AND profile_id = v_coach;
  IF NOT EXISTS (SELECT 1 FROM public.training_plan_assignments WHERE assignment_batch_id = v_batch_assistant) THEN
    RAISE EXCEPTION 'assistant assignment authority failed';
  END IF;

  -- Atomic new-batch authorization rejects an unrostered recipient.
  v_failed := false;
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_coach::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.assign_my_team_training(v_batch_bad, v_team, v_plan, current_date, NULL, ARRAY[v_child, v_unrostered]);
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN
    EXECUTE 'RESET ROLE'; v_failed := true;
  END;
  IF NOT v_failed OR EXISTS (SELECT 1 FROM public.training_assignment_batches WHERE id = v_batch_bad)
     OR EXISTS (SELECT 1 FROM public.training_plan_assignments WHERE assignment_batch_id = v_batch_bad) THEN
    RAISE EXCEPTION 'unauthorized or unrostered recipient created assignment';
  END IF;

  -- Give guardian/admin an otherwise valid active private coach plan, then
  -- prove their failure is the canonical team-assignment authority check.
  UPDATE public.training_plans SET owner_user_id = v_guardian WHERE id = v_plan;
  v_failed := false;
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_guardian::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.assign_my_team_training(gen_random_uuid(), v_team, v_plan, current_date, NULL, ARRAY[v_child]);
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN
    EXECUTE 'RESET ROLE'; v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'guardian received team assignment authority'; END IF;
  UPDATE public.training_plans SET owner_user_id = v_admin WHERE id = v_plan;
  v_failed := false;
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.assign_my_team_training(gen_random_uuid(), v_team, v_plan, current_date, NULL, ARRAY[v_child]);
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN
    EXECUTE 'RESET ROLE'; v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'admin received team assignment authority'; END IF;
  UPDATE public.training_plans SET owner_user_id = v_coach WHERE id = v_plan;

  -- A complete exact retry is acknowledged after mutable authority changes;
  -- it creates no new rows and therefore cannot create work after revocation.
  SELECT count(*) INTO v_before_retry_assignments FROM public.training_plan_assignments;
  SELECT count(*) INTO v_before_retry_sessions FROM public.training_sessions;
  DELETE FROM public.team_staff_memberships WHERE team_id = v_team AND profile_id = v_coach;
  PERFORM set_config('request.jwt.claim.sub', v_coach::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.assign_my_team_training(v_batch_self, v_team, v_plan, current_date, 'self note', ARRAY[v_self]);
  EXECUTE 'RESET ROLE';
  IF (SELECT count(*) FROM public.training_plan_assignments) <> v_before_retry_assignments
     OR (SELECT count(*) FROM public.training_sessions) <> v_before_retry_sessions THEN
    RAISE EXCEPTION 'retry after authority revocation created new work';
  END IF;
  INSERT INTO public.team_staff_memberships (team_id, profile_id, role, created_by_profile_id)
  VALUES (v_team, v_coach, 'coach', v_coach);

  UPDATE public.training_plans SET status = 'archived' WHERE id = v_plan;
  PERFORM set_config('request.jwt.claim.sub', v_coach::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.assign_my_team_training(v_batch_child, v_team, v_plan, current_date, NULL, ARRAY[v_child]);
  EXECUTE 'RESET ROLE';
  IF (SELECT count(*) FROM public.training_plan_assignments) <> v_before_retry_assignments
     OR (SELECT count(*) FROM public.training_sessions) <> v_before_retry_sessions THEN
    RAISE EXCEPTION 'retry after plan archive created new work';
  END IF;
  UPDATE public.training_plans SET status = 'active' WHERE id = v_plan;

  -- Changed request keys conflict, while complete exact batches succeed.
  v_failed := false;
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_coach::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.assign_my_team_training(v_batch_self, v_team, v_plan, current_date + 1, 'self note', ARRAY[v_self]);
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN
    EXECUTE 'RESET ROLE'; v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'retry with different request succeeded'; END IF;

  -- Controlled rollback-only corruption demonstrates retries detect rather
  -- than repair missing sessions/prescriptions or inconsistent ownership.
  PERFORM set_config('request.jwt.claim.sub', v_coach::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.assign_my_team_training(v_batch_missing_session, v_team, v_plan, current_date, NULL, ARRAY[v_self]);
  EXECUTE 'RESET ROLE';
  DELETE FROM public.training_session_prescriptions WHERE session_id IN (
    SELECT session.id FROM public.training_sessions AS session
    JOIN public.training_plan_assignments AS assignment ON assignment.id = session.assignment_id
    WHERE assignment.assignment_batch_id = v_batch_missing_session LIMIT 1
  );
  DELETE FROM public.training_sessions WHERE id IN (
    SELECT session.id FROM public.training_sessions AS session
    JOIN public.training_plan_assignments AS assignment ON assignment.id = session.assignment_id
    WHERE assignment.assignment_batch_id = v_batch_missing_session LIMIT 1
  );
  v_failed := false; BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_coach::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.assign_my_team_training(v_batch_missing_session, v_team, v_plan, current_date, NULL, ARRAY[v_self]);
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'corrupt retry with missing session succeeded'; END IF;

  PERFORM set_config('request.jwt.claim.sub', v_coach::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.assign_my_team_training(v_batch_missing_prescription, v_team, v_plan, current_date, NULL, ARRAY[v_self]);
  EXECUTE 'RESET ROLE';
  DELETE FROM public.training_session_prescriptions WHERE session_id IN (
    SELECT session.id FROM public.training_sessions AS session
    JOIN public.training_plan_assignments AS assignment ON assignment.id = session.assignment_id
    WHERE assignment.assignment_batch_id = v_batch_missing_prescription LIMIT 1
  );
  v_failed := false; BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_coach::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.assign_my_team_training(v_batch_missing_prescription, v_team, v_plan, current_date, NULL, ARRAY[v_self]);
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'corrupt retry with missing prescription succeeded'; END IF;

  PERFORM set_config('request.jwt.claim.sub', v_coach::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.assign_my_team_training(v_batch_bad_ownership, v_team, v_plan, current_date, NULL, ARRAY[v_self]);
  EXECUTE 'RESET ROLE';
  UPDATE public.training_sessions SET athlete_id = v_child
  WHERE id IN (
    SELECT session.id FROM public.training_sessions AS session
    JOIN public.training_plan_assignments AS assignment ON assignment.id = session.assignment_id
    WHERE assignment.assignment_batch_id = v_batch_bad_ownership LIMIT 1
  );
  v_failed := false; BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_coach::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.assign_my_team_training(v_batch_bad_ownership, v_team, v_plan, current_date, NULL, ARRAY[v_self]);
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'corrupt retry with inconsistent session ownership succeeded'; END IF;

  -- Authenticated direct session RLS: legacy shape remains supported; durable
  -- ownership is never accepted outside the canonical trigger/RPC boundary.
  PERFORM set_config('request.jwt.claim.sub', v_coach::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO public.training_sessions
    (id, plan_item_id, athlete_id, athlete_user_id, coach_user_id, team_id, workout_id, scheduled_date, status)
  VALUES (v_direct_session, v_item, NULL, v_self, v_coach, v_team, v_workout, current_date, 'scheduled');
  EXECUTE 'RESET ROLE';
  IF NOT EXISTS (SELECT 1 FROM public.training_session_prescriptions WHERE session_id = v_direct_session) THEN
    RAISE EXCEPTION 'legacy-shaped authenticated direct session did not generate prescription';
  END IF;

  FOREACH v_guardian IN ARRAY ARRAY[v_coach, v_guardian, v_admin] LOOP
    v_failed := false;
    BEGIN
      PERFORM set_config('request.jwt.claim.sub', v_guardian::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      INSERT INTO public.training_sessions
        (id, plan_item_id, athlete_id, athlete_user_id, coach_user_id, team_id, workout_id, scheduled_date, status)
      VALUES (gen_random_uuid(), v_item, v_child, NULL, v_guardian, v_team, v_workout, current_date, 'scheduled');
      EXECUTE 'RESET ROLE';
    EXCEPTION WHEN others THEN
      EXECUTE 'RESET ROLE'; v_failed := true;
    END;
    IF NOT v_failed THEN
      RAISE EXCEPTION 'authenticated direct durable session bypass succeeded for actor %', v_guardian;
    END IF;
  END LOOP;

  -- Legacy assignment INSERT still creates legacy sessions/prescriptions under
  -- the current authenticated policy and protected trigger chain.
  PERFORM set_config('request.jwt.claim.sub', v_coach::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO public.training_plan_assignments
    (training_plan_id, team_id, athlete_user_id, assigned_by_user_id, start_date, status)
  VALUES (v_plan, v_team, v_self, v_coach, current_date, 'active')
  RETURNING id INTO v_legacy_assignment;
  EXECUTE 'RESET ROLE';
  IF NOT EXISTS (
    SELECT 1 FROM public.training_sessions AS session
    JOIN public.training_session_prescriptions AS prescription ON prescription.session_id = session.id
    WHERE session.assignment_id = v_legacy_assignment
      AND session.athlete_id IS NULL AND session.athlete_user_id = v_self
  ) THEN RAISE EXCEPTION 'legacy assignment trigger generation failed'; END IF;

  v_failed := false;
  BEGIN
    INSERT INTO public.training_plan_assignments
      (training_plan_id, team_id, athlete_user_id, athlete_id, assigned_by_user_id, start_date, status)
    VALUES (v_plan, v_team, NULL, NULL, v_coach, current_date, 'active');
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'ownerless assignment accepted'; END IF;
  v_failed := false;
  BEGIN
    INSERT INTO public.training_sessions
      (plan_item_id, athlete_id, athlete_user_id, coach_user_id, team_id, workout_id, scheduled_date, status)
    VALUES (v_item, NULL, NULL, v_coach, v_team, v_workout, current_date, 'scheduled');
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'ownerless session accepted'; END IF;

  IF (SELECT count(*) FROM public.training_plan_assignments) < v_before_assignments
     OR (SELECT count(*) FROM public.training_sessions) < v_before_sessions THEN
    RAISE EXCEPTION 'historical rows were removed during validation';
  END IF;
END;
$validation$;

ROLLBACK;
