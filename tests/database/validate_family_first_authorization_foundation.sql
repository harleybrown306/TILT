-- Execute only after create_family_first_authorization_foundation.sql is applied.
-- Fixtures are rollback-only; existing authorization and historical records remain unchanged.
BEGIN;

DO $validation$
DECLARE
  v_guardian uuid;
  v_guardian_no_manage uuid;
  v_unrelated uuid;
  v_coach uuid;
  v_assistant uuid;
  v_admin uuid;
  v_self_profile uuid;
  v_self_athlete uuid;
  v_team uuid;
  v_other_team uuid;
  v_child uuid;
  v_child_no_training uuid;
  v_unrelated_athlete uuid;
  v_allowed boolean;
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE platform_role='admin' ORDER BY id LIMIT 1;
  SELECT athlete_id, profile_id INTO v_self_athlete, v_self_profile
  FROM public.athlete_profile_relationships
  WHERE role='self' AND revoked_at IS NULL ORDER BY created_at LIMIT 1;
  SELECT id INTO v_guardian FROM public.profiles
  WHERE id NOT IN (v_admin, v_self_profile) ORDER BY id LIMIT 1;
  SELECT id INTO v_guardian_no_manage FROM public.profiles
  WHERE id NOT IN (v_admin, v_self_profile, v_guardian) ORDER BY id LIMIT 1;
  SELECT id INTO v_unrelated FROM public.profiles
  WHERE id NOT IN (v_admin, v_self_profile, v_guardian, v_guardian_no_manage) ORDER BY id LIMIT 1;
  SELECT id INTO v_coach FROM public.profiles
  WHERE id NOT IN (v_admin, v_self_profile, v_guardian, v_guardian_no_manage, v_unrelated) ORDER BY id LIMIT 1;
  SELECT id INTO v_assistant FROM public.profiles
  WHERE id NOT IN (v_admin, v_self_profile, v_guardian, v_guardian_no_manage, v_unrelated, v_coach) ORDER BY id LIMIT 1;
  IF v_admin IS NULL OR v_self_profile IS NULL OR v_guardian IS NULL OR v_guardian_no_manage IS NULL
     OR v_unrelated IS NULL OR v_coach IS NULL OR v_assistant IS NULL THEN
    RAISE EXCEPTION 'Seven distinct profiles plus an active self relationship are required for authorization validation';
  END IF;

  INSERT INTO public.teams(id,name,created_by_user_id)
  VALUES (gen_random_uuid(),'Authorization validation ' || gen_random_uuid()::text,v_guardian)
  RETURNING id INTO v_team;
  INSERT INTO public.teams(id,name,created_by_user_id)
  VALUES (gen_random_uuid(),'Authorization other team ' || gen_random_uuid()::text,v_guardian)
  RETURNING id INTO v_other_team;
  INSERT INTO public.athletes(id,display_name,created_by_profile_id)
  VALUES (gen_random_uuid(),'Parent-managed authorization child',v_guardian)
  RETURNING id INTO v_child;
  INSERT INTO public.athletes(id,display_name,created_by_profile_id)
  VALUES (gen_random_uuid(),'No-training child',v_guardian)
  RETURNING id INTO v_child_no_training;
  INSERT INTO public.athletes(id,display_name,created_by_profile_id)
  VALUES (gen_random_uuid(),'Unrelated authorization athlete',v_guardian)
  RETURNING id INTO v_unrelated_athlete;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id IN (v_child,v_child_no_training,v_unrelated_athlete)) THEN
    RAISE EXCEPTION 'Parent-managed fixture unexpectedly has a profile';
  END IF;

  INSERT INTO public.athlete_profile_relationships(athlete_id,profile_id,role,training_permission,manage_permission,created_by_profile_id)
  VALUES (v_child,v_guardian,'guardian',true,true,v_guardian),
         (v_child,v_guardian_no_manage,'guardian',true,false,v_guardian),
         (v_child_no_training,v_guardian,'guardian',false,true,v_guardian),
         (v_unrelated_athlete,v_unrelated,'guardian',true,true,v_unrelated);
  INSERT INTO public.team_staff_memberships(team_id,profile_id,role,created_by_profile_id)
  VALUES (v_team,v_coach,'coach',v_guardian),
         (v_team,v_assistant,'assistant_coach',v_guardian),
         (v_other_team,v_coach,'coach',v_guardian);
  INSERT INTO public.team_athlete_memberships(team_id,athlete_id,created_by_profile_id)
  VALUES (v_team,v_child,v_guardian);

  IF to_regprocedure('private.can_view_athlete(uuid,uuid)') IS NOT NULL
     OR to_regprocedure('private.can_manage_athlete(uuid,uuid)') IS NOT NULL
     OR to_regprocedure('private.can_act_for_training(uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Authenticated authorization helper accepts a caller-supplied profile ID';
  END IF;
  IF has_function_privilege('authenticated','private.is_athlete_on_team(uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'Authenticated callers can invoke internal athlete-team lookup';
  END IF;

  PERFORM set_config('request.jwt.claim.sub',v_self_profile::text,true);
  IF NOT private.can_view_athlete(v_self_athlete) OR NOT private.can_act_for_training(v_self_athlete) THEN
    RAISE EXCEPTION 'Self-linked athlete lacks own view or training action';
  END IF;

  PERFORM set_config('request.jwt.claim.sub',v_guardian::text,true);
  IF NOT private.can_view_athlete(v_child) OR NOT private.can_manage_athlete(v_child)
     OR NOT private.can_act_for_training(v_child) THEN
    RAISE EXCEPTION 'Authorized guardian lacks expected child authority';
  END IF;
  IF private.can_act_for_training(v_child_no_training) THEN
    RAISE EXCEPTION 'Guardian acted for child without training permission';
  END IF;

  PERFORM set_config('request.jwt.claim.sub',v_guardian_no_manage::text,true);
  IF NOT private.can_view_athlete(v_child) OR private.can_manage_athlete(v_child)
     OR NOT private.can_act_for_training(v_child) THEN
    RAISE EXCEPTION 'Manage permission did not remain distinct from view/training permission';
  END IF;

  PERFORM set_config('request.jwt.claim.sub',v_unrelated::text,true);
  IF private.can_view_athlete(v_child) OR private.can_manage_athlete(v_child)
     OR private.can_act_for_training(v_child) THEN
    RAISE EXCEPTION 'Unrelated profile received athlete authority';
  END IF;

  PERFORM set_config('request.jwt.claim.sub',v_coach::text,true);
  IF NOT private.is_team_staff(v_team) OR NOT private.is_team_coach(v_team)
     OR NOT private.can_manage_team(v_team) OR NOT private.can_manage_roster(v_team)
     OR NOT private.can_view_athlete(v_child) OR NOT private.can_assign_team_athlete_training(v_team,v_child)
     OR private.can_act_for_training(v_child) OR private.can_manage_athlete(v_child) THEN
    RAISE EXCEPTION 'Coach authority did not remain team-scoped';
  END IF;
  IF private.can_view_athlete(v_unrelated_athlete) OR private.can_assign_team_athlete_training(v_team,v_unrelated_athlete) THEN
    RAISE EXCEPTION 'Coach viewed or assigned unrelated athlete';
  END IF;

  PERFORM set_config('request.jwt.claim.sub',v_assistant::text,true);
  IF NOT private.is_team_staff(v_team) OR private.is_team_coach(v_team)
     OR private.can_manage_team(v_team) OR NOT private.can_manage_roster(v_team)
     OR NOT private.can_view_athlete(v_child) OR NOT private.can_assign_team_athlete_training(v_team,v_child)
     OR private.can_act_for_training(v_child) THEN
    RAISE EXCEPTION 'Assistant authority did not follow intended team scope';
  END IF;

  PERFORM set_config('request.jwt.claim.sub',v_admin::text,true);
  IF NOT private.can_view_athlete(v_child) OR private.can_manage_athlete(v_child)
     OR private.can_act_for_training(v_child) OR private.is_team_staff(v_team)
     OR private.can_manage_team(v_team) OR private.can_manage_roster(v_team) THEN
    RAISE EXCEPTION 'Platform admin exceeded explicit support visibility';
  END IF;

  UPDATE public.athlete_profile_relationships SET revoked_at=clock_timestamp()
  WHERE athlete_id=v_child AND profile_id=v_guardian_no_manage AND role='guardian';
  PERFORM set_config('request.jwt.claim.sub',v_guardian_no_manage::text,true);
  IF private.can_view_athlete(v_child) OR private.can_manage_athlete(v_child)
     OR private.can_act_for_training(v_child) THEN
    RAISE EXCEPTION 'Revoked relationship retained authority';
  END IF;
END;
$validation$;

ROLLBACK;
