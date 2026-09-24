-- Run only after the B1 migration on a disposable local database.
BEGIN;

DO $validation$
#variable_conflict error
DECLARE
  manager_id uuid;
  child_profile_id uuid;
  unrelated_id uuid;
  team_a uuid;
  team_b uuid;
  group_a uuid;
  athlete_a uuid := gen_random_uuid();
  athlete_b uuid := gen_random_uuid();
  marker text := '13eb1-' || replace(gen_random_uuid()::text, '-', '');
  failed boolean;
  affected_rows integer;
BEGIN
  -- Catalog contract: only durable group subjects survive the cutover.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='team_group_memberships' AND column_name='athlete_user_id')
     OR (
       SELECT count(*)
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'team_group_memberships'
         AND column_name IN ('team_id', 'athlete_id')
         AND is_nullable = 'NO'
     ) <> 2 THEN
    RAISE EXCEPTION 'B1 durable group subject columns are incorrect';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='team_group_memberships_group_athlete_unique')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='team_group_memberships_group_team_fkey')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='team_group_memberships_team_athlete_fkey') THEN
    RAISE EXCEPTION 'B1 group containment constraints are missing';
  END IF;

  INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  SELECT gen_random_uuid(),'authenticated','authenticated',marker || '-' || n || '@example.test',clock_timestamp(),'{}','{}',clock_timestamp(),clock_timestamp()
  FROM generate_series(1,3) n;
  SELECT id INTO manager_id FROM public.profiles WHERE id IN (SELECT id FROM auth.users WHERE email=marker || '-1@example.test');
  SELECT id INTO child_profile_id FROM public.profiles WHERE id IN (SELECT id FROM auth.users WHERE email=marker || '-2@example.test');
  SELECT id INTO unrelated_id FROM public.profiles WHERE id IN (SELECT id FROM auth.users WHERE email=marker || '-3@example.test');
  IF manager_id IS NULL OR child_profile_id IS NULL OR unrelated_id IS NULL THEN RAISE EXCEPTION 'fixture profiles missing'; END IF;

  INSERT INTO public.teams(name,created_by_user_id) VALUES ('B1 team A',manager_id) RETURNING id INTO team_a;
  INSERT INTO public.teams(name,created_by_user_id) VALUES ('B1 team B',manager_id) RETURNING id INTO team_b;
  INSERT INTO public.team_staff_memberships(team_id,profile_id,role,created_by_profile_id) VALUES(team_a,manager_id,'coach',manager_id),(team_a,unrelated_id,'assistant_coach',manager_id);
  INSERT INTO public.athletes(id,display_name,created_by_profile_id) VALUES(athlete_a,'Claimed child',manager_id),(athlete_b,'Other athlete',manager_id);
  INSERT INTO public.athlete_profile_relationships(athlete_id,profile_id,role,training_permission,manage_permission,created_by_profile_id)
  VALUES(athlete_a,child_profile_id,'self',true,true,manager_id),(athlete_a,child_profile_id,'guardian',true,true,manager_id),(athlete_a,manager_id,'guardian',true,true,manager_id),(athlete_b,child_profile_id,'guardian',true,true,manager_id);
  INSERT INTO public.team_athlete_memberships(team_id,athlete_id,created_by_profile_id) VALUES(team_a,athlete_a,manager_id),(team_b,athlete_b,manager_id);
  INSERT INTO public.team_groups(team_id,name,created_by_user_id) VALUES(team_a,'B1 group',manager_id) RETURNING id INTO group_a;

  -- Claimed profile and durable athlete are deliberately distinct.
  IF child_profile_id=athlete_a THEN RAISE EXCEPTION 'claimed-child fixture accidentally used same UUID'; END IF;
  INSERT INTO public.team_group_memberships(team_group_id,team_id,athlete_id,created_by_user_id) VALUES(group_a,team_a,athlete_a,manager_id);
  IF NOT EXISTS (SELECT 1 FROM public.team_group_memberships WHERE team_group_id=group_a AND team_id=team_a AND athlete_id=athlete_a) THEN RAISE EXCEPTION 'durable group membership missing'; END IF;
  failed:=false; BEGIN INSERT INTO public.team_group_memberships(team_group_id,team_id,athlete_id,created_by_user_id) VALUES(group_a,team_a,athlete_b,manager_id); EXCEPTION WHEN foreign_key_violation THEN failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'cross-team group containment was not enforced'; END IF;

  -- RLS writer/creator tests use the real authenticated role and JWT subject.
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub',manager_id::text,true);
  DELETE FROM public.team_group_memberships WHERE team_group_id=group_a AND athlete_id=athlete_a;
  INSERT INTO public.team_group_memberships(team_group_id,team_id,athlete_id,created_by_user_id) VALUES(group_a,team_a,athlete_a,manager_id);
  failed:=false; BEGIN INSERT INTO public.team_group_memberships(team_group_id,team_id,athlete_id,created_by_user_id) VALUES(group_a,team_a,athlete_a,unrelated_id); EXCEPTION WHEN insufficient_privilege THEN failed:=true; WHEN unique_violation THEN failed:=false; END;
  IF NOT failed THEN RAISE EXCEPTION 'creator spoofing was not denied'; END IF;
  PERFORM set_config('request.jwt.claim.sub',child_profile_id::text,true);
  DELETE FROM public.team_group_memberships WHERE team_group_id=group_a AND athlete_id=athlete_a;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 0 THEN RAISE EXCEPTION 'SELF relationship granted group management'; END IF;
  EXECUTE 'RESET ROLE';

  -- SELF must select MANAGE/ACT instead of borrowing guardian permission.
  PERFORM set_config('request.jwt.claim.sub',child_profile_id::text,true);
  UPDATE public.athlete_profile_relationships SET manage_permission=false,training_permission=false WHERE athlete_id=athlete_a AND profile_id=child_profile_id AND role='self';
  IF private.can_manage_athlete_identity(athlete_a) OR private.can_act_for_training(athlete_a) THEN RAISE EXCEPTION 'guardian permission leaked through active SELF'; END IF;
  UPDATE public.athlete_profile_relationships SET revoked_at=clock_timestamp() WHERE athlete_id=athlete_a AND profile_id=child_profile_id AND role='self';
  IF NOT private.can_manage_athlete_identity(athlete_a) OR NOT private.can_act_for_training(athlete_a) THEN RAISE EXCEPTION 'active guardian did not apply after SELF revocation'; END IF;
  IF NOT private.can_view_athlete_identity(athlete_a) THEN RAISE EXCEPTION 'VIEW relationship-presence regression'; END IF;
  PERFORM set_config('request.jwt.claim.sub',unrelated_id::text,true);
  IF private.can_act_for_training(athlete_a) THEN RAISE EXCEPTION 'staff/guardian fixture unexpectedly gained ACT without selected family relationship'; END IF;

  IF (SELECT count(*) FROM pg_proc p WHERE p.oid IN ('public.create_child_login_invitation(uuid,text,text)'::regprocedure,'public.get_child_login_invitation_summary(text)'::regprocedure,'public.accept_child_login_invitation(text)'::regprocedure,'public.revoke_child_login_invitation(uuid)'::regprocedure,'public.list_my_child_login_invitations(uuid)'::regprocedure) AND (has_function_privilege('public',p.oid,'EXECUTE') OR has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE')))<>0 THEN RAISE EXCEPTION '13EA RPC release gate regressed'; END IF;
  IF to_regprocedure('private.guard_child_login_self_relationship_write()') IS NULL OR to_regprocedure('private.prevent_child_login_self_history_erasure()') IS NULL THEN RAISE EXCEPTION '13EA SELF protections missing'; END IF;
  RAISE NOTICE '13EB1 VALIDATOR PASS';
END;
$validation$;

ROLLBACK;
