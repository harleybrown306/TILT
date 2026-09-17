-- Execute only after create_family_first_team_athlete_roster_writer.sql is applied.
-- Every fixture is rollback-only and leaves no production data behind.
BEGIN;

DO $validation$
DECLARE
  v_coach uuid; v_assistant uuid; v_guardian uuid; v_coach_only uuid;
  v_admin uuid; v_self uuid; v_team uuid;
  v_child uuid := gen_random_uuid(); v_assistant_child uuid := gen_random_uuid();
  v_unmanaged_child uuid := gen_random_uuid(); v_manage_false_child uuid := gen_random_uuid();
  v_revoked_child uuid := gen_random_uuid(); v_inactive_child uuid := gen_random_uuid();
  v_plan uuid; v_batch uuid := gen_random_uuid();
  v_membership_count bigint; v_failed boolean;
BEGIN
  SELECT plan.owner_user_id, plan.id INTO v_coach, v_plan
  FROM public.training_plans AS plan
  WHERE plan.kind='coach' AND plan.visibility='private' AND plan.status='active'
    AND EXISTS (SELECT 1 FROM public.training_plan_items AS item WHERE item.training_plan_id=plan.id)
  ORDER BY plan.id LIMIT 1;
  SELECT profile.id INTO v_assistant
  FROM public.profiles AS profile
  WHERE profile.platform_role <> 'admin' AND profile.id <> v_coach
  ORDER BY profile.id LIMIT 1;
  SELECT profile.id INTO v_guardian
  FROM public.profiles AS profile
  WHERE profile.platform_role <> 'admin' AND profile.id NOT IN (v_coach, v_assistant)
  ORDER BY profile.id LIMIT 1;
  SELECT profile.id INTO v_coach_only
  FROM public.profiles AS profile
  WHERE profile.platform_role <> 'admin' AND profile.id NOT IN (v_coach, v_assistant, v_guardian)
  ORDER BY profile.id LIMIT 1;
  SELECT profile.id INTO v_admin
  FROM public.profiles AS profile
  WHERE profile.platform_role = 'admin'
  ORDER BY profile.id LIMIT 1;
  SELECT relationship.profile_id INTO v_self
  FROM public.athlete_profile_relationships AS relationship
  WHERE relationship.role = 'self' AND relationship.revoked_at IS NULL
  ORDER BY relationship.created_at LIMIT 1;
  IF v_coach IS NULL OR v_assistant IS NULL OR v_guardian IS NULL
     OR v_coach_only IS NULL OR v_admin IS NULL OR v_self IS NULL OR v_plan IS NULL THEN
    RAISE EXCEPTION 'Validation requires an active private coach plan, five profiles including an admin, and a self athlete';
  END IF;

  INSERT INTO public.teams (id, name, created_by_user_id)
  VALUES (gen_random_uuid(), 'Family roster writer validation', v_coach)
  RETURNING id INTO v_team;
  INSERT INTO public.team_staff_memberships (team_id, profile_id, role, created_by_profile_id)
  VALUES
    (v_team, v_coach, 'coach', v_coach),
    (v_team, v_assistant, 'assistant_coach', v_coach),
    (v_team, v_coach_only, 'coach', v_coach);
  INSERT INTO public.team_staff_memberships (team_id, profile_id, role, created_by_profile_id)
  VALUES (v_team, v_self, 'coach', v_coach)
  ON CONFLICT (team_id, profile_id) DO NOTHING;

  INSERT INTO public.athletes (id, display_name, created_by_profile_id)
  VALUES
    (v_child, 'Roster writer no-auth child', v_coach),
    (v_assistant_child, 'Roster writer assistant child', v_assistant),
    (v_unmanaged_child, 'Roster writer unmanaged child', v_guardian),
    (v_manage_false_child, 'Roster writer manage-false child', v_coach),
    (v_revoked_child, 'Roster writer revoked child', v_coach),
    (v_inactive_child, 'Roster writer inactive child', v_coach);
  UPDATE public.athletes SET status='archived', archived_at=clock_timestamp() WHERE id=v_inactive_child;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id IN (v_child, v_assistant_child, v_unmanaged_child, v_manage_false_child, v_revoked_child, v_inactive_child)) THEN
    RAISE EXCEPTION 'No-auth validation athlete unexpectedly has a profile';
  END IF;
  INSERT INTO public.athlete_profile_relationships
    (athlete_id, profile_id, role, training_permission, manage_permission, created_by_profile_id)
  VALUES
    (v_child, v_coach, 'guardian', true, true, v_coach),
    (v_assistant_child, v_assistant, 'guardian', true, true, v_assistant),
    (v_unmanaged_child, v_guardian, 'guardian', true, true, v_guardian),
    (v_manage_false_child, v_coach, 'guardian', true, false, v_coach),
    (v_revoked_child, v_coach, 'guardian', true, true, v_coach),
    (v_inactive_child, v_coach, 'guardian', true, true, v_coach);

  -- Coach + guardian creates the no-auth child; exact retry is idempotent.
  PERFORM set_config('request.jwt.claim.sub', v_coach::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.add_my_managed_athlete_to_team(v_team, v_child);
  PERFORM public.add_my_managed_athlete_to_team(v_team, v_child);
  EXECUTE 'RESET ROLE';
  SELECT count(*) INTO v_membership_count FROM public.team_athlete_memberships
  WHERE team_id = v_team AND athlete_id = v_child;
  IF v_membership_count <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.team_athlete_memberships
    WHERE team_id = v_team AND athlete_id = v_child
      AND created_by_profile_id = v_coach
  ) THEN RAISE EXCEPTION 'coach guardian create or retry was not idempotent'; END IF;

  v_failed := false; BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_coach::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.add_my_managed_athlete_to_team(v_team, v_manage_false_child); EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'coach guardian with manage=false added athlete'; END IF;

  v_failed := false; BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_coach::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.add_my_managed_athlete_to_team(v_team, v_inactive_child); EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; v_failed := true; END;
  IF NOT v_failed OR EXISTS (SELECT 1 FROM public.team_athlete_memberships WHERE team_id=v_team AND athlete_id=v_inactive_child) THEN
    RAISE EXCEPTION 'inactive athlete was rostered'; END IF;

  -- Existing can_manage_roster treats assistant coach staff as roster managers;
  -- assistant still needs an active manage relationship with the athlete.
  PERFORM set_config('request.jwt.claim.sub', v_assistant::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.add_my_managed_athlete_to_team(v_team, v_assistant_child);
  EXECUTE 'RESET ROLE';
  IF NOT EXISTS (SELECT 1 FROM public.team_athlete_memberships WHERE team_id=v_team AND athlete_id=v_assistant_child) THEN
    RAISE EXCEPTION 'assistant with guardian management authority was denied';
  END IF;
  v_failed := false; BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_assistant::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.add_my_managed_athlete_to_team(v_team, v_child); EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'assistant without guardian relationship added sibling athlete'; END IF;

  -- UUID guessing: each denial leaves no membership behind.
  v_failed := false; BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_coach_only::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.add_my_managed_athlete_to_team(v_team, v_unmanaged_child); EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; v_failed := true; END;
  IF NOT v_failed OR EXISTS (SELECT 1 FROM public.team_athlete_memberships WHERE team_id=v_team AND athlete_id=v_unmanaged_child) THEN
    RAISE EXCEPTION 'roster-managing coach claimed an unmanaged athlete by UUID'; END IF;

  v_failed := false; BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_guardian::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.add_my_managed_athlete_to_team(v_team, v_unmanaged_child); EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'guardian without roster authority added athlete'; END IF;

  v_failed := false; BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.add_my_managed_athlete_to_team(v_team, v_unmanaged_child); EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'admin alone added athlete'; END IF;

  -- Null and unknown resources fail without creating an orphan membership.
  v_failed := false; BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_coach::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.add_my_managed_athlete_to_team(NULL, v_child); EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'NULL team was accepted'; END IF;
  v_failed := false; BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_coach::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.add_my_managed_athlete_to_team(v_team, NULL); EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'NULL athlete was accepted'; END IF;
  v_failed := false; BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_coach::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.add_my_managed_athlete_to_team(gen_random_uuid(), v_child); EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'unknown team was accepted'; END IF;
  v_failed := false; BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_coach::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.add_my_managed_athlete_to_team(v_team, gen_random_uuid()); EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'unknown athlete was accepted'; END IF;

  -- Same two-sided rule permits a self athlete only when that profile is staff.
  PERFORM set_config('request.jwt.claim.sub', v_self::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.add_my_managed_athlete_to_team(v_team, v_self); EXECUTE 'RESET ROLE';
  IF NOT EXISTS (SELECT 1 FROM public.team_athlete_memberships WHERE team_id=v_team AND athlete_id=v_self) THEN
    RAISE EXCEPTION 'self athlete with roster authority was denied'; END IF;

  -- A revoked guardian relationship is not management authority.
  UPDATE public.athlete_profile_relationships SET revoked_at=clock_timestamp()
  WHERE athlete_id=v_revoked_child AND profile_id=v_coach AND role='guardian' AND revoked_at IS NULL;
  v_failed := false; BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_coach::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.add_my_managed_athlete_to_team(v_team, v_revoked_child); EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; v_failed := true; END;
  IF NOT v_failed OR EXISTS (SELECT 1 FROM public.team_athlete_memberships WHERE team_id=v_team AND athlete_id=v_revoked_child) THEN
    RAISE EXCEPTION 'revoked guardian added athlete'; END IF;

  -- Authenticated callers retain no direct table INSERT path.
  v_failed := false; BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_coach::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    INSERT INTO public.team_athlete_memberships(team_id, athlete_id, created_by_profile_id)
    VALUES (v_team, v_unmanaged_child, v_coach);
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'authenticated direct roster insert bypass succeeded'; END IF;

  -- The existing canonical assignment writer accepts the durable no-auth child
  -- after roster membership and retains a NULL legacy owner.
  PERFORM set_config('request.jwt.claim.sub', v_coach::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.assign_my_team_training(v_batch, v_team, v_plan, current_date, NULL, ARRAY[v_child]);
  EXECUTE 'RESET ROLE';
  IF NOT EXISTS (
    SELECT 1 FROM public.training_plan_assignments
    WHERE assignment_batch_id=v_batch AND athlete_id=v_child AND athlete_user_id IS NULL
  ) OR EXISTS (
    SELECT 1 FROM public.training_sessions AS session
    JOIN public.training_plan_assignments AS assignment ON assignment.id=session.assignment_id
    LEFT JOIN public.training_session_prescriptions AS prescription ON prescription.session_id=session.id
    WHERE assignment.assignment_batch_id=v_batch
      AND (session.athlete_id IS DISTINCT FROM v_child OR session.athlete_user_id IS NOT NULL OR prescription.session_id IS NULL)
  ) THEN RAISE EXCEPTION 'canonical assignment did not preserve no-auth child ownership'; END IF;
END;
$validation$;

ROLLBACK;
