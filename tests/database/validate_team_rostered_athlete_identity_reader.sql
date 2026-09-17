-- Execute only after create_team_rostered_athlete_identity_reader.sql is applied.
-- Every fixture is transaction-local and is removed by ROLLBACK.
BEGIN;

DO $validation$
DECLARE
  v_coach uuid; v_assistant uuid; v_guardian uuid; v_other_staff uuid; v_admin uuid; v_self uuid;
  v_team_a uuid := gen_random_uuid(); v_team_b uuid := gen_random_uuid();
  v_child uuid := gen_random_uuid(); v_other_child uuid := gen_random_uuid();
  v_plan uuid; v_batch uuid := gen_random_uuid(); v_session uuid;
  v_rows integer; v_failed boolean; v_non_staff_actor uuid;
BEGIN
  SELECT plan.owner_user_id, plan.id INTO v_coach, v_plan
  FROM public.training_plans AS plan
  WHERE plan.kind='coach' AND plan.visibility='private' AND plan.status='active'
    AND EXISTS (SELECT 1 FROM public.training_plan_items AS item WHERE item.training_plan_id=plan.id)
  ORDER BY plan.id LIMIT 1;
  SELECT id INTO v_assistant FROM public.profiles WHERE platform_role <> 'admin' AND id <> v_coach ORDER BY id LIMIT 1;
  SELECT id INTO v_guardian FROM public.profiles WHERE platform_role <> 'admin' AND id NOT IN (v_coach, v_assistant) ORDER BY id LIMIT 1;
  SELECT id INTO v_other_staff FROM public.profiles WHERE platform_role <> 'admin' AND id NOT IN (v_coach, v_assistant, v_guardian) ORDER BY id LIMIT 1;
  SELECT id INTO v_admin FROM public.profiles WHERE platform_role='admin' ORDER BY id LIMIT 1;
  SELECT profile_id INTO v_self FROM public.athlete_profile_relationships WHERE role='self' AND revoked_at IS NULL ORDER BY created_at LIMIT 1;
  IF v_coach IS NULL OR v_plan IS NULL OR v_assistant IS NULL OR v_guardian IS NULL OR v_other_staff IS NULL OR v_admin IS NULL OR v_self IS NULL THEN
    RAISE EXCEPTION 'Validation requires an active coach plan, four non-admin profiles, an admin, and a self athlete';
  END IF;

  INSERT INTO public.teams(id,name,created_by_user_id) VALUES
    (v_team_a, 'Roster identity reader A', v_coach), (v_team_b, 'Roster identity reader B', v_other_staff);
  INSERT INTO public.team_staff_memberships(team_id,profile_id,role,created_by_profile_id) VALUES
    (v_team_a,v_coach,'coach',v_coach), (v_team_a,v_assistant,'assistant_coach',v_coach),
    (v_team_b,v_other_staff,'coach',v_other_staff);
  INSERT INTO public.athletes(id,display_name,graduation_year,created_by_profile_id) VALUES
    (v_child,'Reader no-auth child',2030,v_coach), (v_other_child,'Reader cross-team child',2031,v_guardian);
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id IN (v_child,v_other_child)) THEN RAISE EXCEPTION 'No-auth fixture received a profile'; END IF;
  INSERT INTO public.athlete_profile_relationships(athlete_id,profile_id,role,training_permission,manage_permission,created_by_profile_id) VALUES
    (v_child,v_coach,'guardian',true,true,v_coach), (v_other_child,v_guardian,'guardian',true,true,v_guardian);
  INSERT INTO public.team_athlete_memberships(team_id,athlete_id,created_by_profile_id) VALUES
    (v_team_a,v_child,v_coach), (v_team_b,v_other_child,v_other_staff);

  -- Staff of the exact rostered team resolve only the four identity columns.
  PERFORM set_config('request.jwt.claim.sub',v_coach::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_rows FROM public.list_my_team_rostered_athlete_identities(v_team_a) WHERE athlete_id=v_child AND display_name='Reader no-auth child' AND graduation_year=2030 AND status='active';
  EXECUTE 'RESET ROLE'; IF v_rows <> 1 THEN RAISE EXCEPTION 'coach could not read rostered no-auth child projection'; END IF;
  PERFORM set_config('request.jwt.claim.sub',v_assistant::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_rows FROM public.list_my_team_rostered_athlete_identities(v_team_a) WHERE athlete_id=v_child; EXECUTE 'RESET ROLE';
  IF v_rows <> 1 THEN RAISE EXCEPTION 'assistant could not read rostered no-auth child projection'; END IF;

  -- Cross-team and UUID-guessing attempts are indistinguishably denied to non-staff.
  FOR v_non_staff_actor IN SELECT v_guardian UNION ALL SELECT v_other_staff LOOP
    v_failed := false; BEGIN
      PERFORM set_config('request.jwt.claim.sub',v_non_staff_actor::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
      PERFORM * FROM public.list_my_team_rostered_athlete_identities(v_team_a); EXECUTE 'RESET ROLE';
    EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; v_failed := true; END;
    IF NOT v_failed THEN RAISE EXCEPTION 'non-staff actor read another team roster'; END IF;
  END LOOP;

  -- Existing family/self/admin table visibility remains unchanged, while staff-only VIEW does not confer MANAGE or ACT.
  PERFORM set_config('request.jwt.claim.sub',v_guardian::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_rows FROM public.athletes WHERE id=v_other_child; EXECUTE 'RESET ROLE'; IF v_rows <> 1 THEN RAISE EXCEPTION 'guardian identity view regressed'; END IF;
  PERFORM set_config('request.jwt.claim.sub',v_admin::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_rows FROM public.athletes WHERE id=v_child; EXECUTE 'RESET ROLE'; IF v_rows <> 1 THEN RAISE EXCEPTION 'admin support identity view regressed'; END IF;
  PERFORM set_config('request.jwt.claim.sub',v_assistant::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  IF private.can_manage_athlete(v_child) OR private.can_act_for_training(v_child) THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'staff roster view broadened manage or act'; END IF;
  EXECUTE 'RESET ROLE';

  -- Produce a child session through the canonical assignment writer, then prove staff-only access cannot ACT for it.
  PERFORM set_config('request.jwt.claim.sub',v_coach::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.assign_my_team_training(v_batch,v_team_a,v_plan,current_date,NULL,ARRAY[v_child]); EXECUTE 'RESET ROLE';
  SELECT id INTO v_session FROM public.training_sessions WHERE assignment_id IN (SELECT id FROM public.training_plan_assignments WHERE assignment_batch_id=v_batch) ORDER BY id LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub',v_assistant::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  IF public.can_act_for_training_session(v_session) THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'staff roster view broadened session ACT'; END IF;
  SELECT count(*) INTO v_rows FROM public.athlete_profile_relationships WHERE athlete_id=v_child; EXECUTE 'RESET ROLE';
  IF v_rows <> 0 THEN RAISE EXCEPTION 'staff roster view exposed family relationships'; END IF;

  -- Same-UUID self identity remains viewable and has no duplicate roster identity requirement.
  PERFORM set_config('request.jwt.claim.sub',v_self::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_rows FROM public.athletes WHERE id=v_self; EXECUTE 'RESET ROLE';
  IF v_rows <> 1 THEN RAISE EXCEPTION 'self identity view regressed'; END IF;
END;
$validation$;

ROLLBACK;
