-- Execute only after retire_direct_authenticated_session_insert.sql is applied.
-- All fixtures and attempted writes are contained in this transaction.
BEGIN;

DO $validation$
DECLARE
  v_coach uuid;
  v_guardian uuid;
  v_admin uuid;
  v_self uuid;
  v_plan uuid;
  v_team uuid;
  v_child uuid;
  v_item uuid;
  v_workout uuid;
  v_batch_self uuid := gen_random_uuid();
  v_batch_child uuid := gen_random_uuid();
  v_batch_assistant uuid := gen_random_uuid();
  v_legacy_assignment uuid;
  v_failed boolean;
  v_expected_sessions integer;
  v_before_assignments bigint;
  v_before_sessions bigint;
  v_before_prescriptions bigint;
  v_before_results bigint;
  v_before_attempts bigint;
  v_before_events bigint;
  v_actor uuid;
BEGIN
  SELECT plan.owner_user_id, plan.id
  INTO v_coach, v_plan
  FROM public.training_plans AS plan
  WHERE plan.kind = 'coach'
    AND plan.visibility = 'private'
    AND plan.status = 'active'
    AND EXISTS (
      SELECT 1 FROM public.training_plan_items AS item
      WHERE item.training_plan_id = plan.id
    )
  ORDER BY plan.id
  LIMIT 1;

  SELECT relationship.athlete_id
  INTO v_self
  FROM public.athlete_profile_relationships AS relationship
  WHERE relationship.profile_id = relationship.athlete_id
    AND relationship.role = 'self'
    AND relationship.revoked_at IS NULL
  ORDER BY relationship.created_at
  LIMIT 1;

  SELECT profile.id
  INTO v_guardian
  FROM public.profiles AS profile
  WHERE profile.id NOT IN (v_coach, v_self)
    AND profile.platform_role <> 'admin'
  ORDER BY profile.id
  LIMIT 1;

  SELECT profile.id
  INTO v_admin
  FROM public.profiles AS profile
  WHERE profile.platform_role = 'admin'
    AND profile.id NOT IN (v_coach, v_self, v_guardian)
  ORDER BY profile.id
  LIMIT 1;

  SELECT item.id, item.workout_id
  INTO v_item, v_workout
  FROM public.training_plan_items AS item
  WHERE item.training_plan_id = v_plan
  ORDER BY item.day_offset, item.position
  LIMIT 1;

  IF v_coach IS NULL OR v_plan IS NULL OR v_self IS NULL OR v_guardian IS NULL
     OR v_admin IS NULL OR v_item IS NULL THEN
    RAISE EXCEPTION 'Validation requires a coach, self athlete, guardian, admin, active plan, and plan item';
  END IF;

  SELECT count(*) INTO v_expected_sessions
  FROM public.training_plan_items WHERE training_plan_id = v_plan;
  SELECT count(*) INTO v_before_assignments FROM public.training_plan_assignments;
  SELECT count(*) INTO v_before_sessions FROM public.training_sessions;
  SELECT count(*) INTO v_before_prescriptions FROM public.training_session_prescriptions;
  SELECT count(*) INTO v_before_results FROM public.workout_results;
  SELECT count(*) INTO v_before_attempts FROM public.workout_session_attempts;
  SELECT count(*) INTO v_before_events FROM public.workout_session_events;

  INSERT INTO public.teams (id, name, created_by_user_id)
  VALUES (gen_random_uuid(), 'Session insert retirement validation', v_coach)
  RETURNING id INTO v_team;
  INSERT INTO public.athletes (id, display_name, created_by_profile_id)
  VALUES (gen_random_uuid(), 'No-auth session validation child', v_guardian)
  RETURNING id INTO v_child;
  INSERT INTO public.athlete_profile_relationships
    (athlete_id, profile_id, role, training_permission, manage_permission, created_by_profile_id)
  VALUES (v_child, v_guardian, 'guardian', true, true, v_guardian);
  INSERT INTO public.team_staff_memberships (team_id, profile_id, role, created_by_profile_id)
  VALUES (v_team, v_coach, 'coach', v_coach);
  INSERT INTO public.team_athlete_memberships (team_id, athlete_id, created_by_profile_id)
  VALUES (v_team, v_self, v_coach), (v_team, v_child, v_coach);

  -- Preserve legacy batch/assignment rollback compatibility for the self athlete.
  INSERT INTO public.team_memberships (team_id, user_id, role, created_by_user_id)
  VALUES (v_team, v_self, 'athlete', v_coach);

  -- The authenticated RPC must still create all durable sessions and their
  -- immutable prescriptions through the SECURITY DEFINER trigger chain.
  PERFORM set_config('request.jwt.claim.sub', v_coach::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.assign_my_team_training(v_batch_self, v_team, v_plan, current_date, NULL, ARRAY[v_self]);
  EXECUTE 'RESET ROLE';
  IF (SELECT count(*) FROM public.training_sessions AS session
      JOIN public.training_plan_assignments AS assignment ON assignment.id = session.assignment_id
      JOIN public.training_session_prescriptions AS prescription ON prescription.session_id = session.id
      WHERE assignment.assignment_batch_id = v_batch_self
        AND session.athlete_id = v_self
        AND session.athlete_user_id = v_self
        AND prescription.workout_id = session.workout_id) <> v_expected_sessions THEN
    RAISE EXCEPTION 'canonical self-athlete session generation or prescription capture failed';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_coach::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.assign_my_team_training(v_batch_child, v_team, v_plan, current_date, NULL, ARRAY[v_child]);
  EXECUTE 'RESET ROLE';
  IF (SELECT count(*) FROM public.training_sessions AS session
      JOIN public.training_plan_assignments AS assignment ON assignment.id = session.assignment_id
      JOIN public.training_session_prescriptions AS prescription ON prescription.session_id = session.id
      WHERE assignment.assignment_batch_id = v_batch_child
        AND session.athlete_id = v_child
        AND session.athlete_user_id IS NULL
        AND prescription.workout_id = session.workout_id) <> v_expected_sessions THEN
    RAISE EXCEPTION 'canonical no-auth-child session generation or prescription capture failed';
  END IF;

  -- The same coach profile retains canonical assignment authority while acting
  -- as an assistant coach, provided it owns the selected private plan.
  UPDATE public.team_staff_memberships
  SET role = 'assistant_coach'
  WHERE team_id = v_team AND profile_id = v_coach;
  PERFORM set_config('request.jwt.claim.sub', v_coach::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.assign_my_team_training(v_batch_assistant, v_team, v_plan, current_date, NULL, ARRAY[v_self]);
  EXECUTE 'RESET ROLE';
  UPDATE public.team_staff_memberships
  SET role = 'coach'
  WHERE team_id = v_team AND profile_id = v_coach;
  IF (SELECT count(*) FROM public.training_sessions AS session
      JOIN public.training_plan_assignments AS assignment ON assignment.id = session.assignment_id
      WHERE assignment.assignment_batch_id = v_batch_assistant
        AND session.athlete_id = v_self
        AND session.athlete_user_id = v_self) <> v_expected_sessions THEN
    RAISE EXCEPTION 'canonical assistant session generation failed';
  END IF;

  -- Every ordinary authenticated role is denied a direct INSERT, including a
  -- legacy-shaped coach payload and a durable-shaped payload.
  FOREACH v_actor IN ARRAY ARRAY[v_coach, v_guardian, v_admin] LOOP
    v_failed := false;
    BEGIN
      PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      INSERT INTO public.training_sessions
        (id, plan_item_id, athlete_id, athlete_user_id, coach_user_id, team_id, workout_id, scheduled_date, status)
      VALUES (
        gen_random_uuid(), v_item,
        CASE WHEN v_actor = v_coach THEN NULL ELSE v_child END,
        CASE WHEN v_actor = v_coach THEN v_self ELSE NULL END,
        v_actor, v_team, v_workout, current_date, 'scheduled'
      );
      EXECUTE 'RESET ROLE';
    EXCEPTION WHEN others THEN
      EXECUTE 'RESET ROLE';
      v_failed := true;
    END;
    IF NOT v_failed THEN
      RAISE EXCEPTION 'authenticated direct session INSERT succeeded for actor %', v_actor;
    END IF;
  END LOOP;

  -- Prior-app batch/assignment writes remain available and continue to invoke
  -- the protected generator; only direct session INSERT is retired.
  PERFORM set_config('request.jwt.claim.sub', v_coach::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO public.training_plan_assignments
    (training_plan_id, team_id, athlete_user_id, assigned_by_user_id, start_date, status)
  VALUES (v_plan, v_team, v_self, v_coach, current_date, 'active')
  RETURNING id INTO v_legacy_assignment;
  EXECUTE 'RESET ROLE';
  IF (SELECT count(*) FROM public.training_sessions AS session
      JOIN public.training_session_prescriptions AS prescription ON prescription.session_id = session.id
      WHERE session.assignment_id = v_legacy_assignment
        AND session.athlete_id IS NULL
        AND session.athlete_user_id = v_self) <> v_expected_sessions THEN
    RAISE EXCEPTION 'legacy assignment compatibility generation failed';
  END IF;

  IF (SELECT count(*) FROM public.workout_results) <> v_before_results
     OR (SELECT count(*) FROM public.workout_session_attempts) <> v_before_attempts
     OR (SELECT count(*) FROM public.workout_session_events) <> v_before_events THEN
    RAISE EXCEPTION 'historical completion or telemetry rows changed during validation';
  END IF;
  IF (SELECT count(*) FROM public.training_plan_assignments) < v_before_assignments
     OR (SELECT count(*) FROM public.training_sessions) < v_before_sessions
     OR (SELECT count(*) FROM public.training_session_prescriptions) < v_before_prescriptions THEN
    RAISE EXCEPTION 'historical training rows were removed during validation';
  END IF;
END;
$validation$;

ROLLBACK;
