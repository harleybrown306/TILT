-- Execute only after create_family_first_athlete_identity_foundation.sql is applied.
-- This validation is rollback-only and creates no persistent athlete identity.
BEGIN;

DO $validation$
DECLARE
  v_athlete_members integer;
  v_backfilled integer;
  v_missing_self integer;
  v_coach_only integer;
  v_admin_unaffiliated integer;
  v_sessions_before bigint;
  v_results_before bigint;
  v_events_before bigint;
  v_sessions_after bigint;
  v_results_after bigint;
  v_events_after bigint;
  v_profile uuid;
  v_child_one uuid;
  v_child_two uuid;
  v_guardian_two uuid;
  v_self_profile_two uuid;
  v_admin uuid;
  v_admin_subject uuid;
  v_created uuid;
  v_allowed boolean;
  v_rejected boolean := false;
BEGIN
  SELECT count(DISTINCT membership.user_id)
    INTO v_athlete_members
  FROM public.team_memberships AS membership
  JOIN public.profiles AS profile ON profile.id = membership.user_id
  WHERE membership.role = 'athlete';

  SELECT count(*) INTO v_backfilled
  FROM public.athletes AS athlete
  WHERE EXISTS (
    SELECT 1 FROM public.team_memberships AS membership
    WHERE membership.user_id = athlete.id AND membership.role = 'athlete'
  );
  IF v_backfilled <> v_athlete_members THEN
    RAISE EXCEPTION 'Backfill mismatch: expected %, got %', v_athlete_members, v_backfilled;
  END IF;

  SELECT count(*) INTO v_missing_self
  FROM public.team_memberships AS membership
  JOIN public.profiles AS profile ON profile.id = membership.user_id
  WHERE membership.role = 'athlete'
    AND NOT EXISTS (
      SELECT 1 FROM public.athlete_profile_relationships AS relationship
      WHERE relationship.athlete_id = profile.id
        AND relationship.profile_id = profile.id
        AND relationship.role = 'self'
        AND relationship.revoked_at IS NULL
    );
  IF v_missing_self <> 0 THEN RAISE EXCEPTION 'Backfilled athletes missing active self links: %', v_missing_self; END IF;

  SELECT count(*) INTO v_coach_only
  FROM public.profiles AS profile
  WHERE EXISTS (SELECT 1 FROM public.team_memberships m WHERE m.user_id = profile.id AND m.role IN ('coach', 'assistant_coach'))
    AND NOT EXISTS (SELECT 1 FROM public.team_memberships m WHERE m.user_id = profile.id AND m.role = 'athlete')
    AND EXISTS (SELECT 1 FROM public.athletes athlete WHERE athlete.id = profile.id);
  IF v_coach_only <> 0 THEN RAISE EXCEPTION 'Coach-only profiles were backfilled as athletes: %', v_coach_only; END IF;

  SELECT count(*) INTO v_admin_unaffiliated
  FROM public.profiles AS profile
  WHERE profile.platform_role = 'admin'
    AND NOT EXISTS (SELECT 1 FROM public.team_memberships m WHERE m.user_id = profile.id)
    AND EXISTS (SELECT 1 FROM public.athletes athlete WHERE athlete.id = profile.id);
  IF v_admin_unaffiliated <> 0 THEN RAISE EXCEPTION 'Unaffiliated admins were backfilled as athletes: %', v_admin_unaffiliated; END IF;

  SELECT count(*) INTO v_sessions_before FROM public.training_sessions;
  SELECT count(*) INTO v_results_before FROM public.workout_results;
  SELECT count(*) INTO v_events_before FROM public.workout_session_events;

  SELECT id INTO v_profile FROM public.profiles ORDER BY id LIMIT 1;
  IF v_profile IS NULL THEN RAISE EXCEPTION 'A profile fixture is required for identity validation'; END IF;
  SELECT id INTO v_guardian_two FROM public.profiles WHERE id <> v_profile ORDER BY id LIMIT 1;
  IF v_guardian_two IS NULL THEN RAISE EXCEPTION 'A second profile fixture is required for multi-guardian validation'; END IF;
  SELECT id INTO v_self_profile_two
  FROM public.profiles
  WHERE id NOT IN (v_profile, v_guardian_two)
  ORDER BY id LIMIT 1;
  IF v_self_profile_two IS NULL THEN RAISE EXCEPTION 'A third profile fixture is required for self-link validation'; END IF;

  INSERT INTO public.athletes (display_name, graduation_year, created_by_profile_id)
  VALUES ('Validation child one', NULL, v_profile) RETURNING id INTO v_child_one;
  INSERT INTO public.athletes (display_name, graduation_year, created_by_profile_id)
  VALUES ('Validation child two', 2035, v_profile) RETURNING id INTO v_child_two;
  INSERT INTO public.athletes (display_name, graduation_year, created_by_profile_id)
  VALUES ('Validation upper graduation boundary', 2100, v_profile);
  INSERT INTO public.athletes (display_name, graduation_year, created_by_profile_id)
  VALUES ('Validation lower graduation boundary', 2000, v_profile);
  INSERT INTO public.athletes (display_name, graduation_year, created_by_profile_id)
  VALUES ('Validation admin support subject', NULL, v_profile) RETURNING id INTO v_admin_subject;
  INSERT INTO public.athlete_profile_relationships (athlete_id, profile_id, role, training_permission, manage_permission, created_by_profile_id)
  VALUES (v_child_one, v_profile, 'guardian', true, true, v_profile),
         (v_child_two, v_profile, 'guardian', true, true, v_profile),
         (v_child_one, v_guardian_two, 'guardian', true, true, v_profile);

  BEGIN
    INSERT INTO public.athlete_profile_relationships (athlete_id, profile_id, role, training_permission, manage_permission)
    VALUES (v_child_one, v_profile, 'guardian', true, true);
  EXCEPTION WHEN unique_violation THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Duplicate active guardian relationship was accepted'; END IF;

  INSERT INTO public.athlete_profile_relationships (athlete_id, profile_id, role, training_permission, manage_permission)
  VALUES (v_child_one, v_guardian_two, 'self', true, true);
  v_rejected := false;
  BEGIN
    INSERT INTO public.athlete_profile_relationships (athlete_id, profile_id, role, training_permission, manage_permission)
    VALUES (v_child_two, v_guardian_two, 'self', true, true);
  EXCEPTION WHEN unique_violation THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'A profile received more than one active self athlete'; END IF;

  v_rejected := false;
  BEGIN
    INSERT INTO public.athlete_profile_relationships (athlete_id, profile_id, role, training_permission, manage_permission)
    VALUES (v_child_one, v_self_profile_two, 'self', true, true);
  EXCEPTION WHEN unique_violation THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'An athlete received more than one active self relationship'; END IF;

  -- The actor is sourced only from auth.uid(); no two-argument helper may be invoked.
  IF to_regprocedure('private.can_view_athlete_identity(uuid,uuid)') IS NOT NULL
     OR to_regprocedure('private.can_manage_athlete_identity(uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Authorization helpers still accept a caller-supplied profile ID';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_profile::text, true);
  SELECT private.can_manage_athlete_identity(v_child_one) INTO v_allowed;
  IF NOT v_allowed THEN RAISE EXCEPTION 'Active guardian manage permission did not grant management'; END IF;
  PERFORM set_config('request.jwt.claim.sub', v_guardian_two::text, true);
  SELECT private.can_manage_athlete_identity(v_child_one) INTO v_allowed;
  IF NOT v_allowed THEN RAISE EXCEPTION 'Active self manage permission did not grant management'; END IF;

  SELECT id INTO v_admin FROM public.profiles WHERE platform_role = 'admin' ORDER BY id LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'A platform-admin profile fixture is required for admin authorization validation'; END IF;
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  SELECT private.can_view_athlete_identity(v_admin_subject), private.can_manage_athlete_identity(v_admin_subject)
    INTO v_allowed, v_rejected;
  IF NOT v_allowed THEN RAISE EXCEPTION 'Platform admin lost intended athlete read visibility'; END IF;
  IF v_rejected THEN RAISE EXCEPTION 'Platform admin received athlete management without an active relationship'; END IF;

  UPDATE public.athlete_profile_relationships
    SET revoked_at = clock_timestamp()
  WHERE athlete_id = v_child_one AND profile_id = v_profile AND role = 'guardian';
  INSERT INTO public.athlete_profile_relationships (athlete_id, profile_id, role, training_permission, manage_permission)
  VALUES (v_child_one, v_profile, 'guardian', true, true);

  v_rejected := false;
  BEGIN
    INSERT INTO public.athletes (display_name, graduation_year) VALUES ('Invalid lower graduation', 1999);
  EXCEPTION WHEN check_violation THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Graduation year 1999 was accepted'; END IF;
  v_rejected := false;
  BEGIN
    INSERT INTO public.athletes (display_name, graduation_year) VALUES ('Invalid upper graduation', 2101);
  EXCEPTION WHEN check_violation THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Graduation year 2101 was accepted'; END IF;

  PERFORM set_config('request.jwt.claim.sub', v_profile::text, true);
  SET LOCAL ROLE authenticated;
  SELECT public.create_my_athlete('Validation RPC child', NULL) INTO v_created;
  RESET ROLE;
  IF NOT EXISTS (
    SELECT 1 FROM public.athlete_profile_relationships
    WHERE athlete_id = v_created AND profile_id = v_profile AND role = 'guardian'
      AND training_permission AND manage_permission AND revoked_at IS NULL
  ) THEN RAISE EXCEPTION 'Parent creation RPC did not create its guardian link'; END IF;

  SELECT count(*) INTO v_sessions_after FROM public.training_sessions;
  SELECT count(*) INTO v_results_after FROM public.workout_results;
  SELECT count(*) INTO v_events_after FROM public.workout_session_events;
  IF (v_sessions_before, v_results_before, v_events_before) <> (v_sessions_after, v_results_after, v_events_after) THEN
    RAISE EXCEPTION 'Existing historical-record counts changed';
  END IF;
END;
$validation$;

ROLLBACK;
