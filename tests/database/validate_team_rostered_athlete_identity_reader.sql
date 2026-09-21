-- Execute only after create_team_rostered_athlete_identity_reader.sql is applied.
-- Every fixture is transaction-local and is removed by ROLLBACK.
BEGIN;

DO $validation$
DECLARE
  v_coach uuid; v_assistant uuid; v_guardian uuid; v_unrelated uuid; v_admin uuid; v_self_profile uuid; v_self_athlete uuid;
  v_team_a uuid := gen_random_uuid(); v_team_b uuid := gen_random_uuid();
  v_child uuid := gen_random_uuid(); v_other_child uuid := gen_random_uuid();
  v_rows integer; v_failed boolean;
BEGIN
  SELECT athlete_id, profile_id INTO v_self_athlete, v_self_profile
  FROM public.athlete_profile_relationships
  WHERE role='self' AND revoked_at IS NULL ORDER BY created_at LIMIT 1;
  SELECT id INTO v_coach FROM public.profiles
  WHERE platform_role <> 'admin' AND id IS DISTINCT FROM v_self_profile ORDER BY id LIMIT 1;
  SELECT id INTO v_assistant FROM public.profiles WHERE platform_role <> 'admin' AND id NOT IN (v_coach, v_self_profile) ORDER BY id LIMIT 1;
  SELECT id INTO v_guardian FROM public.profiles WHERE platform_role <> 'admin' AND id NOT IN (v_coach, v_assistant, v_self_profile) ORDER BY id LIMIT 1;
  SELECT id INTO v_unrelated FROM public.profiles WHERE platform_role <> 'admin' AND id NOT IN (v_coach, v_assistant, v_guardian, v_self_profile) ORDER BY id LIMIT 1;
  SELECT id INTO v_admin FROM public.profiles WHERE platform_role='admin' ORDER BY id LIMIT 1;
  IF v_coach IS NULL OR v_assistant IS NULL OR v_guardian IS NULL OR v_unrelated IS NULL OR v_admin IS NULL OR v_self_profile IS NULL OR v_self_athlete IS NULL THEN
    RAISE EXCEPTION 'Validation requires four distinct non-admin profiles, an admin, and a self athlete';
  END IF;

  INSERT INTO public.teams(id,name,created_by_user_id) VALUES
    (v_team_a, 'Roster identity reader A', v_coach), (v_team_b, 'Roster identity reader B', v_unrelated);
  INSERT INTO public.team_staff_memberships(team_id,profile_id,role,created_by_profile_id) VALUES
    (v_team_a,v_coach,'coach',v_coach), (v_team_a,v_assistant,'assistant_coach',v_coach),
    (v_team_b,v_unrelated,'coach',v_unrelated);
  INSERT INTO public.athletes(id,display_name,graduation_year,created_by_profile_id) VALUES
    (v_child,'Reader no-auth child',2030,v_coach), (v_other_child,'Reader cross-team child',2031,v_guardian);
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id IN (v_child,v_other_child)) THEN RAISE EXCEPTION 'No-auth fixture received a profile'; END IF;
  INSERT INTO public.athlete_profile_relationships(athlete_id,profile_id,role,training_permission,manage_permission,created_by_profile_id) VALUES
    (v_child,v_coach,'guardian',true,true,v_coach), (v_other_child,v_guardian,'guardian',true,true,v_guardian);
  INSERT INTO public.team_athlete_memberships(team_id,athlete_id,created_by_profile_id) VALUES
    (v_team_a,v_child,v_coach), (v_team_a,v_self_athlete,v_coach), (v_team_b,v_other_child,v_unrelated);

  -- Staff of the exact rostered team resolve only the four identity columns.
  PERFORM set_config('request.jwt.claim.sub',v_coach::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_rows FROM public.list_my_team_rostered_athlete_identities(v_team_a) WHERE athlete_id=v_child AND display_name='Reader no-auth child' AND graduation_year=2030 AND status='active';
  EXECUTE 'RESET ROLE'; IF v_rows <> 1 THEN RAISE EXCEPTION 'coach could not read rostered no-auth child projection'; END IF;
  PERFORM set_config('request.jwt.claim.sub',v_assistant::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_rows FROM public.list_my_team_rostered_athlete_identities(v_team_a) WHERE athlete_id=v_child; EXECUTE 'RESET ROLE';
  IF v_rows <> 1 THEN RAISE EXCEPTION 'assistant could not read rostered no-auth child projection'; END IF;
  PERFORM set_config('request.jwt.claim.sub',v_admin::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_rows FROM public.list_my_team_rostered_athlete_identities(v_team_a) WHERE athlete_id=v_child; EXECUTE 'RESET ROLE';
  IF v_rows <> 1 THEN RAISE EXCEPTION 'platform admin not on team staff could not read rostered no-auth child projection'; END IF;

  -- Non-staff callers, including a rostered self athlete, are denied.
  v_failed := false; BEGIN
    PERFORM set_config('request.jwt.claim.sub',v_guardian::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM * FROM public.list_my_team_rostered_athlete_identities(v_team_a); EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'guardian not on team staff read team roster'; END IF;
  v_failed := false; BEGIN
    PERFORM set_config('request.jwt.claim.sub',v_self_profile::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM * FROM public.list_my_team_rostered_athlete_identities(v_team_a); EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'rostered self athlete not on team staff read team roster'; END IF;
  v_failed := false; BEGIN
    PERFORM set_config('request.jwt.claim.sub',v_unrelated::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM * FROM public.list_my_team_rostered_athlete_identities(v_team_a); EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'unrelated authenticated user read team roster'; END IF;

  -- Analytics visibility remains read-only: it grants no roster MANAGE, assignment, or training ACT.
  PERFORM set_config('request.jwt.claim.sub',v_admin::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  IF private.can_manage_roster(v_team_a) OR private.can_assign_team_athlete_training(v_team_a,v_child)
     OR private.can_act_for_training(v_child) THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'platform admin roster view broadened roster manage, assignment, or training ACT'; END IF;
  EXECUTE 'RESET ROLE';
END;
$validation$;

ROLLBACK;
