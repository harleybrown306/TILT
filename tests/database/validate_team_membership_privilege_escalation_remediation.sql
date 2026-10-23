-- Execute only after 20261022003825_harden_team_membership_mutations.sql.
-- Every fixture and assertion is rollback-only. The authenticated sections
-- model direct PostgREST table mutations by setting the JWT subject and role.
BEGIN;

DO $validation$
DECLARE
  v_admin uuid := gen_random_uuid();
  v_coach uuid := gen_random_uuid();
  v_assistant uuid := gen_random_uuid();
  v_athlete uuid := gen_random_uuid();
  v_guardian uuid := gen_random_uuid();
  v_target uuid := gen_random_uuid();
  v_team uuid;
  v_other_team uuid;
  v_child uuid := gen_random_uuid();
  v_coach_membership uuid;
  v_assistant_membership uuid;
  v_athlete_membership uuid;
  v_target_membership uuid;
  v_admin_membership uuid;
  v_rows bigint;
  v_denied boolean;
BEGIN
  -- Self-contained synthetic profiles keep this test independent from seed
  -- data. The existing auth-user trigger creates their profile records.
  INSERT INTO auth.users (
    id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) VALUES
    (v_admin, 'authenticated', 'authenticated', 'membership-rls-admin@example.test', '{}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp()),
    (v_coach, 'authenticated', 'authenticated', 'membership-rls-coach@example.test', '{}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp()),
    (v_assistant, 'authenticated', 'authenticated', 'membership-rls-assistant@example.test', '{}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp()),
    (v_athlete, 'authenticated', 'authenticated', 'membership-rls-athlete@example.test', '{}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp()),
    (v_guardian, 'authenticated', 'authenticated', 'membership-rls-guardian@example.test', '{}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp()),
    (v_target, 'authenticated', 'authenticated', 'membership-rls-target@example.test', '{}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp());
  UPDATE public.profiles
  SET platform_role = 'admin'::public.platform_role
  WHERE id = v_admin;
  IF (SELECT count(*) FROM public.profiles WHERE id IN (v_admin, v_coach, v_assistant, v_athlete, v_guardian, v_target)) <> 6 THEN
    RAISE EXCEPTION 'Synthetic auth users did not create six profile fixtures';
  END IF;

  -- An active family relationship never grants roster-management authority.
  INSERT INTO public.athletes (id, display_name, created_by_profile_id)
  VALUES (v_child, 'Membership RLS validation child', v_guardian);
  INSERT INTO public.athlete_profile_relationships (
    athlete_id, profile_id, role, training_permission, manage_permission, created_by_profile_id
  ) VALUES (v_child, v_guardian, 'guardian', true, true, v_guardian);

  -- The team-creation trigger is the only retained database-mediated path
  -- that creates an initial coach. All following membership writes model the
  -- legacy direct Data API path under review.
  INSERT INTO public.teams (id, name, created_by_user_id)
  VALUES (gen_random_uuid(), 'Membership RLS validation ' || gen_random_uuid()::text, v_admin)
  RETURNING id INTO v_team;
  INSERT INTO public.teams (id, name, created_by_user_id)
  VALUES (gen_random_uuid(), 'Membership RLS other team ' || gen_random_uuid()::text, v_admin)
  RETURNING id INTO v_other_team;

  INSERT INTO public.team_memberships (team_id, user_id, role, created_by_user_id)
  VALUES
    (v_team, v_coach, 'coach'::public.team_member_role, v_admin),
    (v_team, v_assistant, 'assistant_coach'::public.team_member_role, v_admin),
    (v_team, v_athlete, 'athlete'::public.team_member_role, v_admin),
    (v_team, v_target, 'athlete'::public.team_member_role, v_admin);

  SELECT id INTO v_coach_membership
  FROM public.team_memberships
  WHERE team_id = v_team AND user_id = v_coach;
  SELECT id INTO v_assistant_membership
  FROM public.team_memberships
  WHERE team_id = v_team AND user_id = v_assistant;
  SELECT id INTO v_athlete_membership
  FROM public.team_memberships
  WHERE team_id = v_team AND user_id = v_athlete;
  SELECT id INTO v_target_membership
  FROM public.team_memberships
  WHERE team_id = v_team AND user_id = v_target;

  IF NOT EXISTS (
    SELECT 1 FROM public.team_staff_memberships
    WHERE id = v_coach_membership AND role = 'coach'::public.team_staff_role
  ) OR NOT EXISTS (
    SELECT 1 FROM public.team_staff_memberships
    WHERE id = v_assistant_membership AND role = 'assistant_coach'::public.team_staff_role
  ) THEN
    RAISE EXCEPTION 'Initial staff fixture did not reach the canonical mirror';
  END IF;

  IF has_table_privilege('authenticated', 'public.team_staff_memberships', 'INSERT')
     OR has_table_privilege('authenticated', 'public.team_staff_memberships', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.team_staff_memberships', 'DELETE') THEN
    RAISE EXCEPTION 'Authenticated callers received a direct canonical-staff write grant';
  END IF;

  -- Assistant cannot promote its own staff membership. A denied USING filter
  -- returns no row, so assert both row count and canonical mirror state.
  PERFORM set_config('request.jwt.claim.sub', v_assistant::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE public.team_memberships
  SET role = 'coach'::public.team_member_role
  WHERE id = v_assistant_membership;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXECUTE 'RESET ROLE';
  IF v_rows <> 0
     OR NOT EXISTS (
       SELECT 1 FROM public.team_memberships
       WHERE id = v_assistant_membership AND role = 'assistant_coach'::public.team_member_role
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.team_staff_memberships
       WHERE id = v_assistant_membership AND role = 'assistant_coach'::public.team_staff_role
     ) THEN
    RAISE EXCEPTION 'Assistant self-promotion changed legacy or canonical staff authority';
  END IF;

  -- This is the reported P0 route: an assistant must not promote a same-team
  -- athlete to assistant coach. The old athlete row is writable, but the
  -- resulting staff role fails WITH CHECK, so PostgreSQL raises 42501.
  -- Assert that denial and that neither authoritative nor mirrored state moves.
  v_denied := false;
  PERFORM set_config('request.jwt.claim.sub', v_assistant::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    UPDATE public.team_memberships
    SET role = 'assistant_coach'::public.team_member_role
    WHERE id = v_target_membership;
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  EXECUTE 'RESET ROLE';
  IF NOT v_denied
     OR NOT EXISTS (
       SELECT 1 FROM public.team_memberships
       WHERE id = v_target_membership AND role = 'athlete'::public.team_member_role
     )
     OR EXISTS (
       SELECT 1 FROM public.team_staff_memberships
       WHERE id = v_target_membership
     ) THEN
    RAISE EXCEPTION 'Assistant promoted a same-team athlete to canonical staff authority';
  END IF;

  -- Direct coach creation by an assistant fails its INSERT check and never
  -- invokes the mirror trigger.
  v_denied := false;
  PERFORM set_config('request.jwt.claim.sub', v_assistant::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    INSERT INTO public.team_memberships (team_id, user_id, role, created_by_user_id)
    VALUES (v_team, v_guardian, 'coach'::public.team_member_role, v_assistant);
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  EXECUTE 'RESET ROLE';
  IF NOT v_denied
     OR EXISTS (
       SELECT 1 FROM public.team_memberships WHERE team_id = v_team AND user_id = v_guardian
     )
     OR EXISTS (
       SELECT 1 FROM public.team_staff_memberships WHERE team_id = v_team AND profile_id = v_guardian
     ) THEN
    RAISE EXCEPTION 'Assistant directly created coach authority';
  END IF;

  -- Assistant cannot remove a coach. This is another filtered DELETE, not an
  -- exception, so prove that both authoritative and mirror rows survive.
  PERFORM set_config('request.jwt.claim.sub', v_assistant::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  DELETE FROM public.team_memberships WHERE id = v_coach_membership;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXECUTE 'RESET ROLE';
  IF v_rows <> 0
     OR NOT EXISTS (SELECT 1 FROM public.team_memberships WHERE id = v_coach_membership)
     OR NOT EXISTS (SELECT 1 FROM public.team_staff_memberships WHERE id = v_coach_membership) THEN
    RAISE EXCEPTION 'Assistant removed coach authority';
  END IF;

  -- Staff authority is team-scoped. Assistant A cannot add a roster member to
  -- team B, even though it has authenticated direct table access.
  v_denied := false;
  PERFORM set_config('request.jwt.claim.sub', v_assistant::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    INSERT INTO public.team_memberships (team_id, user_id, role, created_by_user_id)
    VALUES (v_other_team, v_target, 'athlete'::public.team_member_role, v_assistant);
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  EXECUTE 'RESET ROLE';
  IF NOT v_denied
     OR EXISTS (
       SELECT 1 FROM public.team_memberships WHERE team_id = v_other_team AND user_id = v_target
     ) THEN
    RAISE EXCEPTION 'Assistant crossed a team boundary';
  END IF;

  -- A guardian with an active family relationship is neither staff nor a
  -- roster manager. An athlete likewise cannot promote its own roster row.
  v_denied := false;
  PERFORM set_config('request.jwt.claim.sub', v_guardian::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    INSERT INTO public.team_memberships (team_id, user_id, role, created_by_user_id)
    VALUES (v_team, v_guardian, 'athlete'::public.team_member_role, v_guardian);
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  EXECUTE 'RESET ROLE';
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Guardian relationship granted team-membership mutation authority';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_athlete::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE public.team_memberships
  SET role = 'coach'::public.team_member_role
  WHERE id = v_athlete_membership;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXECUTE 'RESET ROLE';
  IF v_rows <> 0
     OR NOT EXISTS (
       SELECT 1 FROM public.team_memberships
       WHERE id = v_athlete_membership AND role = 'athlete'::public.team_member_role
     )
     OR EXISTS (SELECT 1 FROM public.team_staff_memberships WHERE id = v_athlete_membership) THEN
    RAISE EXCEPTION 'Athlete promoted itself to staff';
  END IF;

  -- A coach may transition an athlete to assistant and back. The mirror must
  -- follow both allowed changes exactly.
  PERFORM set_config('request.jwt.claim.sub', v_coach::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE public.team_memberships
  SET role = 'assistant_coach'::public.team_member_role
  WHERE id = v_target_membership;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXECUTE 'RESET ROLE';
  IF v_rows <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.team_staff_memberships
       WHERE id = v_target_membership AND role = 'assistant_coach'::public.team_staff_role
     ) THEN
    RAISE EXCEPTION 'Coach could not promote an athlete to assistant with an exact mirror';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_coach::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE public.team_memberships
  SET role = 'athlete'::public.team_member_role
  WHERE id = v_target_membership;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXECUTE 'RESET ROLE';
  IF v_rows <> 1
     OR EXISTS (SELECT 1 FROM public.team_staff_memberships WHERE id = v_target_membership) THEN
    RAISE EXCEPTION 'Coach could not demote assistant to athlete without removing the mirror';
  END IF;

  -- Assistant retains precisely athlete-scoped authority, including update
  -- and delete, but never receives an implicit staff-management capability.
  PERFORM set_config('request.jwt.claim.sub', v_assistant::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE public.team_memberships
  SET role = 'athlete'::public.team_member_role
  WHERE id = v_target_membership;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  DELETE FROM public.team_memberships WHERE id = v_target_membership;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXECUTE 'RESET ROLE';
  IF v_rows <> 1
     OR EXISTS (SELECT 1 FROM public.team_memberships WHERE id = v_target_membership) THEN
    RAISE EXCEPTION 'Assistant could not manage only an athlete membership';
  END IF;

  -- Platform admins retain the explicit exception: they may create, promote,
  -- and delete coach authority through the direct client table API.
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO public.team_memberships (team_id, user_id, role, created_by_user_id)
  VALUES (v_other_team, v_target, 'assistant_coach'::public.team_member_role, v_admin)
  RETURNING id INTO v_admin_membership;
  UPDATE public.team_memberships
  SET role = 'coach'::public.team_member_role
  WHERE id = v_admin_membership;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXECUTE 'RESET ROLE';
  IF v_rows <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.team_staff_memberships
       WHERE id = v_admin_membership AND role = 'coach'::public.team_staff_role
     ) THEN
    RAISE EXCEPTION 'Platform admin could not promote assistant to coach';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  DELETE FROM public.team_memberships WHERE id = v_admin_membership;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXECUTE 'RESET ROLE';
  IF v_rows <> 1
     OR EXISTS (SELECT 1 FROM public.team_staff_memberships WHERE id = v_admin_membership) THEN
    RAISE EXCEPTION 'Platform admin could not delete coach authority';
  END IF;
END;
$validation$;

ROLLBACK;
