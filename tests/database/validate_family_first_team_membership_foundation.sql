-- Execute only after create_family_first_team_membership_foundation.sql is applied.
-- All fixtures are rollback-only. This does not change legacy memberships or history.
BEGIN;

DO $validation$
DECLARE
  v_legacy_staff integer;
  v_legacy_athletes integer;
  v_staff_backfilled integer;
  v_athletes_backfilled integer;
  v_profile uuid;
  v_profile_two uuid;
  v_profile_three uuid;
  v_admin uuid;
  v_self_profile uuid;
  v_self_athlete uuid;
  v_team uuid;
  v_child uuid;
  v_denied boolean := false;
  v_visible boolean;
  v_sessions_before bigint;
  v_results_before bigint;
  v_events_before bigint;
  v_sessions_after bigint;
  v_results_after bigint;
  v_events_after bigint;
BEGIN
  SELECT count(*) INTO v_legacy_staff
  FROM public.team_memberships
  WHERE role IN ('coach', 'assistant_coach');
  SELECT count(*) INTO v_staff_backfilled
  FROM public.team_memberships legacy
  JOIN public.team_staff_memberships staff
    ON staff.id = legacy.id
   AND staff.team_id = legacy.team_id
   AND staff.profile_id = legacy.user_id
   AND staff.role::text = legacy.role::text
  WHERE legacy.role IN ('coach', 'assistant_coach');
  IF v_staff_backfilled <> v_legacy_staff THEN
    RAISE EXCEPTION 'Legacy staff backfill mismatch: expected %, got %', v_legacy_staff, v_staff_backfilled;
  END IF;

  SELECT count(*) INTO v_legacy_athletes
  FROM public.team_memberships WHERE role = 'athlete';
  SELECT count(*) INTO v_athletes_backfilled
  FROM public.team_memberships legacy
  JOIN public.team_athlete_memberships athlete_membership
    ON athlete_membership.id = legacy.id
   AND athlete_membership.team_id = legacy.team_id
   AND athlete_membership.athlete_id = legacy.user_id
  WHERE legacy.role = 'athlete';
  IF v_athletes_backfilled <> v_legacy_athletes THEN
    RAISE EXCEPTION 'Legacy athlete backfill mismatch: expected %, got %', v_legacy_athletes, v_athletes_backfilled;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.team_staff_memberships staff
    LEFT JOIN public.profiles profile ON profile.id = staff.profile_id
    WHERE profile.id IS NULL
  ) OR EXISTS (
    SELECT 1 FROM public.team_athlete_memberships roster
    LEFT JOIN public.athletes athlete ON athlete.id = roster.athlete_id
    WHERE athlete.id IS NULL
  ) THEN RAISE EXCEPTION 'New memberships reference the wrong identity target'; END IF;

  SELECT count(*) INTO v_sessions_before FROM public.training_sessions;
  SELECT count(*) INTO v_results_before FROM public.workout_results;
  SELECT count(*) INTO v_events_before FROM public.workout_session_events;
  SELECT id INTO v_profile FROM public.profiles ORDER BY id LIMIT 1;
  SELECT id INTO v_profile_two FROM public.profiles WHERE id <> v_profile ORDER BY id LIMIT 1;
  SELECT id INTO v_profile_three FROM public.profiles WHERE id NOT IN (v_profile, v_profile_two) ORDER BY id LIMIT 1;
  SELECT id INTO v_admin FROM public.profiles WHERE platform_role = 'admin' ORDER BY id LIMIT 1;
  SELECT athlete_id, profile_id INTO v_self_athlete, v_self_profile
  FROM public.athlete_profile_relationships
  WHERE role = 'self' AND revoked_at IS NULL
  ORDER BY created_at LIMIT 1;
  IF v_profile IS NULL OR v_profile_two IS NULL OR v_profile_three IS NULL OR v_admin IS NULL THEN
    RAISE EXCEPTION 'Three profiles and one platform-admin profile are required for validation';
  END IF;
  IF v_self_profile IS NULL OR v_self_athlete IS NULL THEN
    RAISE EXCEPTION 'An active self relationship is required for self-join validation';
  END IF;

  INSERT INTO public.teams(id, name, created_by_user_id)
  VALUES (gen_random_uuid(), 'Family membership validation ' || gen_random_uuid()::text, v_profile)
  RETURNING id INTO v_team;
  INSERT INTO public.athletes(id, display_name, created_by_profile_id)
  VALUES (gen_random_uuid(), 'Parent-managed roster athlete', v_profile)
  RETURNING id INTO v_child;
  INSERT INTO public.athlete_profile_relationships(
    athlete_id, profile_id, role, training_permission, manage_permission, created_by_profile_id
  ) VALUES (v_child, v_profile, 'guardian', true, true, v_profile);
  INSERT INTO public.team_staff_memberships(team_id, profile_id, role, created_by_profile_id)
  VALUES (v_team, v_profile_two, 'coach', v_profile);
  INSERT INTO public.team_athlete_memberships(team_id, athlete_id, created_by_profile_id)
  VALUES (v_team, v_child, v_profile);

  BEGIN
    INSERT INTO public.team_staff_memberships(team_id, profile_id, role)
    VALUES (v_team, v_profile_two, 'assistant_coach');
  EXCEPTION WHEN unique_violation THEN v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Duplicate team staff membership was accepted'; END IF;
  v_denied := false;
  BEGIN
    INSERT INTO public.team_athlete_memberships(team_id, athlete_id)
    VALUES (v_team, v_child);
  EXCEPTION WHEN unique_violation THEN v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Duplicate team athlete membership was accepted'; END IF;

  PERFORM set_config('request.jwt.claim.sub', v_profile::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT EXISTS (SELECT 1 FROM public.team_athlete_memberships WHERE team_id = v_team AND athlete_id = v_child) INTO v_visible;
  IF NOT v_visible THEN RAISE EXCEPTION 'Guardian could not read authorized child roster membership'; END IF;
  v_denied := false;
  BEGIN
    INSERT INTO public.team_staff_memberships(team_id, profile_id, role) VALUES (v_team, v_profile, 'coach');
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Authenticated profile self-promoted to staff'; END IF;
  v_denied := false;
  BEGIN
    UPDATE public.team_staff_memberships SET role = 'assistant_coach'
    WHERE team_id = v_team AND profile_id = v_profile_two;
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Authenticated profile updated staff membership'; END IF;
  v_denied := false;
  BEGIN
    DELETE FROM public.team_staff_memberships WHERE team_id = v_team AND profile_id = v_profile_two;
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Authenticated profile deleted staff membership'; END IF;
  v_denied := false;
  BEGIN
    INSERT INTO public.team_athlete_memberships(team_id, athlete_id) VALUES (v_team, v_child);
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Guardian attached child to arbitrary team'; END IF;
  v_denied := false;
  BEGIN
    UPDATE public.team_athlete_memberships SET athlete_id = v_child
    WHERE team_id = v_team AND athlete_id = v_child;
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Authenticated profile updated athlete membership'; END IF;
  v_denied := false;
  BEGIN
    DELETE FROM public.team_athlete_memberships WHERE team_id = v_team AND athlete_id = v_child;
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Authenticated profile deleted athlete membership'; END IF;
  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_self_profile::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_denied := false;
  BEGIN
    INSERT INTO public.team_athlete_memberships(team_id, athlete_id) VALUES (v_team, v_self_athlete);
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Self-linked athlete joined arbitrary team'; END IF;
  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT EXISTS (SELECT 1 FROM public.team_athlete_memberships WHERE team_id = v_team AND athlete_id = v_child) INTO v_visible;
  IF NOT v_visible THEN RAISE EXCEPTION 'Platform admin lost intended roster read visibility'; END IF;
  IF EXISTS (SELECT 1 FROM public.team_staff_memberships WHERE team_id = v_team AND profile_id = v_admin) THEN
    RAISE EXCEPTION 'Platform admin automatically became team staff';
  END IF;
  EXECUTE 'RESET ROLE';

  SELECT count(*) INTO v_sessions_after FROM public.training_sessions;
  SELECT count(*) INTO v_results_after FROM public.workout_results;
  SELECT count(*) INTO v_events_after FROM public.workout_session_events;
  IF (v_sessions_before, v_results_before, v_events_before) <> (v_sessions_after, v_results_after, v_events_after) THEN
    RAISE EXCEPTION 'Historical training rows changed during membership validation';
  END IF;
END;
$validation$;

ROLLBACK;
