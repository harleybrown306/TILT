-- Run only after the Phase 13D.5 guardian-invitation migration is applied.
-- Every fixture and assertion is contained in this transaction.
BEGIN;

DO $validation$
#variable_conflict error
DECLARE
  manager_id uuid; recipient_id uuid; unrelated_id uuid; view_id uuid; act_only_id uuid; candidate_id uuid;
  v_athlete_id uuid := gen_random_uuid(); self_athlete_id uuid := gen_random_uuid(); strong_athlete_id uuid := gen_random_uuid(); revoked_athlete_id uuid := gen_random_uuid(); authority_loss_athlete_id uuid := gen_random_uuid(); inactive_athlete_id uuid := gen_random_uuid();
  staff_team_id uuid;
  v_invitation_id uuid; base_invitation_id uuid; expired_invitation_id uuid; token text; v_token_hash text; result_athlete_id uuid; failed boolean; error_message text;
  original_manage boolean; original_training boolean;
  recipient_confirmed_at timestamptz;
  manager_email text; recipient_email text; view_email text;
BEGIN
  -- Catalog and grant contract checks run before transactional fixtures.
  IF NOT EXISTS (SELECT 1 FROM pg_class AS class JOIN pg_namespace AS namespace ON namespace.oid=class.relnamespace WHERE namespace.nspname='public' AND class.relname='guardian_invitations' AND class.relrowsecurity) THEN RAISE EXCEPTION 'guardian invitation table/RLS is missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('guardian_invitations_email_normalized','guardian_invitations_token_hash_sha256','guardian_invitations_expiry_after_creation','guardian_invitations_lifecycle_consistent') GROUP BY conrelid HAVING count(*)=4) THEN RAISE EXCEPTION 'guardian invitation constraints are incomplete'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='guardian_invitations' AND indexname='guardian_invitations_one_pending_per_email') THEN RAISE EXCEPTION 'guardian invitation pending uniqueness index is missing'; END IF;
  IF has_table_privilege('authenticated','public.guardian_invitations','INSERT') OR has_table_privilege('authenticated','public.guardian_invitations','UPDATE') OR has_table_privilege('authenticated','public.guardian_invitations','DELETE') OR has_table_privilege('authenticated','public.guardian_invitations','SELECT') THEN RAISE EXCEPTION 'authenticated has direct guardian invitation table access'; END IF;
  IF to_regprocedure('public.create_guardian_invitation(uuid,text,text,timestamptz)') IS NULL OR to_regprocedure('public.get_guardian_invitation_summary(text)') IS NULL OR to_regprocedure('public.accept_guardian_invitation(text)') IS NULL OR to_regprocedure('public.revoke_guardian_invitation(uuid)') IS NULL OR to_regprocedure('public.list_my_guardian_invitations(uuid)') IS NULL THEN RAISE EXCEPTION 'guardian invitation function signatures are incomplete'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc AS procedure JOIN pg_namespace AS namespace ON namespace.oid=procedure.pronamespace WHERE namespace.nspname='public' AND procedure.proname IN ('create_guardian_invitation','get_guardian_invitation_summary','accept_guardian_invitation','revoke_guardian_invitation','list_my_guardian_invitations') AND (NOT procedure.prosecdef OR NOT (coalesce(procedure.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=""']::text[]))) THEN RAISE EXCEPTION 'guardian invitation function hardening is incomplete'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc AS procedure JOIN pg_namespace AS namespace ON namespace.oid=procedure.pronamespace WHERE namespace.nspname='public' AND procedure.proname IN ('create_guardian_invitation','get_guardian_invitation_summary','accept_guardian_invitation','revoke_guardian_invitation','list_my_guardian_invitations') AND (NOT has_function_privilege('authenticated',procedure.oid,'EXECUTE') OR has_function_privilege('anon',procedure.oid,'EXECUTE'))) THEN RAISE EXCEPTION 'guardian invitation function grants are incorrect'; END IF;
  SELECT p.id INTO manager_id FROM public.profiles AS p JOIN auth.users AS u ON u.id=p.id
    WHERE u.email_confirmed_at IS NOT NULL AND u.email IS NOT NULL
      AND lower(btrim(u.email)) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    ORDER BY p.id LIMIT 1;
  SELECT p.id INTO recipient_id FROM public.profiles AS p JOIN auth.users AS u ON u.id=p.id
    WHERE p.id <> manager_id AND u.email_confirmed_at IS NOT NULL AND u.email IS NOT NULL
      AND lower(btrim(u.email)) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    ORDER BY p.id LIMIT 1;
  SELECT p.id INTO unrelated_id FROM public.profiles AS p JOIN auth.users AS u ON u.id=p.id
    WHERE p.id NOT IN (manager_id, recipient_id) AND u.email_confirmed_at IS NOT NULL AND u.email IS NOT NULL
      AND lower(btrim(u.email)) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' AND NOT private.is_admin(p.id)
    ORDER BY p.id LIMIT 1;
  SELECT p.id INTO view_id FROM public.profiles AS p JOIN auth.users AS u ON u.id=p.id
    WHERE p.id NOT IN (manager_id, recipient_id, unrelated_id) AND u.email_confirmed_at IS NOT NULL AND u.email IS NOT NULL
      AND lower(btrim(u.email)) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' ORDER BY p.id LIMIT 1;
  SELECT p.id INTO act_only_id FROM public.profiles AS p JOIN auth.users AS u ON u.id=p.id
    WHERE p.id NOT IN (manager_id, recipient_id, unrelated_id, view_id) AND u.email_confirmed_at IS NOT NULL AND u.email IS NOT NULL
      AND lower(btrim(u.email)) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' ORDER BY p.id LIMIT 1;
  IF manager_id IS NULL OR recipient_id IS NULL OR unrelated_id IS NULL OR view_id IS NULL OR act_only_id IS NULL THEN
    RAISE EXCEPTION 'Validator fixture error: requires five confirmed auth-backed profiles';
  END IF;
  SELECT email_confirmed_at INTO recipient_confirmed_at FROM auth.users WHERE id=recipient_id;
  SELECT lower(btrim(email)) INTO manager_email FROM auth.users WHERE id=manager_id;
  SELECT lower(btrim(email)) INTO recipient_email FROM auth.users WHERE id=recipient_id;
  SELECT lower(btrim(email)) INTO view_email FROM auth.users WHERE id=view_id;

  -- A genuine staff account has no family MANAGE authority merely by being staff.
  INSERT INTO public.teams(name, created_by_user_id)
  VALUES ('Guardian invitation validation staff team', manager_id)
  RETURNING id INTO staff_team_id;
  INSERT INTO public.team_staff_memberships(team_id, profile_id, role, created_by_profile_id)
  VALUES (staff_team_id, unrelated_id, 'coach', manager_id);

  INSERT INTO public.athletes(id, display_name, created_by_profile_id) VALUES
    (v_athlete_id, 'Guardian invitation validation athlete', manager_id),
    (self_athlete_id, 'Guardian self validation athlete', manager_id),
    (strong_athlete_id, 'Guardian stronger validation athlete', manager_id),
    (revoked_athlete_id, 'Guardian revoked validation athlete', manager_id),
    (authority_loss_athlete_id, 'Guardian authority loss validation athlete', manager_id),
    (inactive_athlete_id, 'Guardian inactive validation athlete', manager_id);
  INSERT INTO public.athlete_profile_relationships(athlete_id, profile_id, role, training_permission, manage_permission, created_by_profile_id) VALUES
    (v_athlete_id, manager_id, 'guardian', true, true, manager_id),
    (v_athlete_id, view_id, 'guardian', false, false, manager_id),
    (v_athlete_id, act_only_id, 'guardian', true, false, manager_id),
    (self_athlete_id, manager_id, 'guardian', true, true, manager_id),
    (self_athlete_id, recipient_id, 'self', true, true, recipient_id),
    (strong_athlete_id, manager_id, 'guardian', true, true, manager_id),
    (strong_athlete_id, recipient_id, 'guardian', true, true, manager_id),
    (revoked_athlete_id, manager_id, 'guardian', true, true, manager_id),
    (revoked_athlete_id, recipient_id, 'guardian', false, false, manager_id),
    (authority_loss_athlete_id, manager_id, 'guardian', true, true, manager_id),
    (inactive_athlete_id, manager_id, 'guardian', true, true, manager_id);
  UPDATE public.athlete_profile_relationships AS relationship SET revoked_at=clock_timestamp()
    WHERE relationship.athlete_id=revoked_athlete_id AND relationship.profile_id=recipient_id AND relationship.role='guardian';

  -- Only explicit MANAGE can create; VIEW, ACT-only, staff/unrelated, bad input, and own email fail.
  token:=repeat('a',64); v_token_hash:=encode(extensions.digest(token,'sha256'),'hex');
  PERFORM set_config('request.jwt.claim.sub',manager_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT created.invitation_id INTO v_invitation_id FROM public.create_guardian_invitation(v_athlete_id,recipient_email,v_token_hash) AS created;
  base_invitation_id := v_invitation_id;
  IF NOT EXISTS (SELECT 1 FROM public.list_my_guardian_invitations(v_athlete_id) AS invitation WHERE invitation.invitation_id = v_invitation_id) THEN
    RAISE EXCEPTION 'MANAGE guardian could not read operational invitation metadata';
  END IF;
  failed:=false; BEGIN PERFORM public.create_guardian_invitation(strong_athlete_id,view_email,v_token_hash); EXCEPTION WHEN unique_violation THEN GET STACKED DIAGNOSTICS error_message = MESSAGE_TEXT; failed := error_message = 'Guardian invitation token is unavailable'; END;
  IF NOT failed THEN RAISE EXCEPTION 'duplicate guardian token hash was not a controlled domain failure'; END IF;
  SELECT created.invitation_id INTO v_invitation_id FROM public.create_guardian_invitation(strong_athlete_id,view_email,encode(extensions.digest(repeat('z',64),'sha256'),'hex'),CURRENT_TIMESTAMP + interval '7 days') AS created;
  IF v_invitation_id IS NULL THEN RAISE EXCEPTION 'exact seven-day guardian invitation expiry was rejected'; END IF;
  EXECUTE 'RESET ROLE';
  IF v_invitation_id IS NULL THEN RAISE EXCEPTION 'MANAGE guardian could not create invitation'; END IF;
  FOREACH candidate_id IN ARRAY ARRAY[view_id,act_only_id,unrelated_id] LOOP
    failed:=false; BEGIN PERFORM set_config('request.jwt.claim.sub',candidate_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
      PERFORM public.create_guardian_invitation(v_athlete_id,'denied@example.invalid',repeat('b',64)); EXECUTE 'RESET ROLE';
    EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; failed:=true; END;
    IF NOT failed THEN RAISE EXCEPTION 'VIEW-only, ACT-only, staff-only, or unrelated actor created guardian invitation'; END IF;
  END LOOP;
  failed:=false; BEGIN PERFORM set_config('request.jwt.claim.sub',manager_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.create_guardian_invitation(v_athlete_id,manager_email,repeat('c',64)); EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'own-email guardian invitation was accepted'; END IF;
  failed:=false; BEGIN PERFORM set_config('request.jwt.claim.sub',manager_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.create_guardian_invitation(v_athlete_id,'not-an-email',repeat('c',64)); EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'malformed guardian invitation email was accepted'; END IF;
  failed:=false; BEGIN PERFORM set_config('request.jwt.claim.sub',manager_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.create_guardian_invitation(v_athlete_id,'expired@example.invalid',repeat('c',64),clock_timestamp()); EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'non-future guardian invitation expiry was accepted'; END IF;
  failed:=false; BEGIN PERFORM set_config('request.jwt.claim.sub',manager_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.create_guardian_invitation(v_athlete_id,'too-long@example.invalid',repeat('c',64),CURRENT_TIMESTAMP + interval '7 days 1 microsecond'); EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'over-seven-day guardian invitation expiry was accepted'; END IF;
  failed:=false; BEGIN PERFORM set_config('request.jwt.claim.sub',manager_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.create_guardian_invitation(v_athlete_id,'hash@example.invalid','not-a-sha256-hash'); EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'malformed guardian invitation token hash was accepted'; END IF;

  -- Wrong/unverified accounts receive no minor identity through summary and cannot accept.
  PERFORM set_config('request.jwt.claim.sub',unrelated_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  IF EXISTS (SELECT 1 FROM public.get_guardian_invitation_summary(token)) THEN RAISE EXCEPTION 'wrong account learned minor identity'; END IF;
  failed:=false; BEGIN PERFORM public.accept_guardian_invitation(token); EXCEPTION WHEN others THEN failed:=true; END; EXECUTE 'RESET ROLE';
  IF NOT failed THEN RAISE EXCEPTION 'wrong account accepted guardian invitation'; END IF;
  UPDATE auth.users SET email_confirmed_at=NULL WHERE id=recipient_id;
  PERFORM set_config('request.jwt.claim.sub',recipient_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  IF EXISTS (SELECT 1 FROM public.get_guardian_invitation_summary(token)) THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'unverified account learned minor identity'; END IF;
  failed:=false; BEGIN PERFORM public.accept_guardian_invitation(token); EXCEPTION WHEN others THEN failed:=true; END; EXECUTE 'RESET ROLE';
  UPDATE auth.users SET email_confirmed_at=recipient_confirmed_at WHERE id=recipient_id;
  IF NOT failed THEN RAISE EXCEPTION 'unverified account accepted guardian invitation'; END IF;
  PERFORM set_config('request.jwt.claim.sub',recipient_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  IF NOT EXISTS (SELECT 1 FROM public.get_guardian_invitation_summary(token)) THEN RAISE EXCEPTION 'matching verified recipient did not receive minimal summary'; END IF;
  SELECT accepted.athlete_id INTO result_athlete_id FROM public.accept_guardian_invitation(token) AS accepted; EXECUTE 'RESET ROLE';
  IF result_athlete_id IS DISTINCT FROM v_athlete_id OR NOT EXISTS (
    SELECT 1 FROM public.athlete_profile_relationships AS r WHERE r.athlete_id=v_athlete_id AND r.profile_id=recipient_id
      AND r.role='guardian' AND NOT r.manage_permission AND NOT r.training_permission AND r.revoked_at IS NULL
  ) THEN RAISE EXCEPTION 'fixed VIEW-only guardian grant was not created'; END IF;
  IF (SELECT invitation.status FROM public.guardian_invitations AS invitation WHERE invitation.id=base_invitation_id) <> 'accepted' THEN RAISE EXCEPTION 'acceptance audit/lifecycle failed'; END IF;
  failed:=false; BEGIN PERFORM set_config('request.jwt.claim.sub',recipient_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.accept_guardian_invitation(token); EXECUTE 'RESET ROLE'; EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'accepted guardian invitation replay succeeded'; END IF;
  token:=repeat('r',64); v_token_hash:=encode(extensions.digest(token,'sha256'),'hex');
  PERFORM set_config('request.jwt.claim.sub',manager_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; SELECT created.invitation_id INTO v_invitation_id FROM public.create_guardian_invitation(v_athlete_id,recipient_email,v_token_hash) AS created; EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub',recipient_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.accept_guardian_invitation(token); EXECUTE 'RESET ROLE';
  IF (SELECT count(*) FROM public.athlete_profile_relationships AS relationship WHERE relationship.athlete_id=v_athlete_id AND relationship.profile_id=recipient_id AND relationship.role='guardian' AND relationship.revoked_at IS NULL) <> 1 THEN
    RAISE EXCEPTION 'existing VIEW guardian acceptance was not idempotent';
  END IF;
  token:=repeat('s',64); v_token_hash:=encode(extensions.digest(token,'sha256'),'hex');
  PERFORM set_config('request.jwt.claim.sub',manager_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; SELECT created.invitation_id INTO v_invitation_id FROM public.create_guardian_invitation(v_athlete_id,recipient_email,v_token_hash) AS created; PERFORM public.revoke_guardian_invitation(v_invitation_id); EXECUTE 'RESET ROLE';
  IF NOT EXISTS (SELECT 1 FROM public.athlete_profile_relationships AS relationship WHERE relationship.athlete_id=v_athlete_id AND relationship.profile_id=recipient_id AND relationship.role='guardian' AND relationship.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'revoking guardian invitation changed existing guardian access';
  END IF;

  -- Existing stronger relationship stays byte-for-byte permission-equivalent.
  token:=repeat('d',64); v_token_hash:=encode(extensions.digest(token,'sha256'),'hex');
  SELECT relationship.manage_permission, relationship.training_permission INTO original_manage,original_training FROM public.athlete_profile_relationships AS relationship WHERE relationship.athlete_id=strong_athlete_id AND relationship.profile_id=recipient_id AND relationship.role='guardian';
  PERFORM set_config('request.jwt.claim.sub',manager_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; SELECT created.invitation_id INTO v_invitation_id FROM public.create_guardian_invitation(strong_athlete_id,recipient_email,v_token_hash) AS created; EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub',recipient_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.accept_guardian_invitation(token); EXECUTE 'RESET ROLE';
  IF NOT EXISTS (SELECT 1 FROM public.athlete_profile_relationships AS relationship WHERE relationship.athlete_id=strong_athlete_id AND relationship.profile_id=recipient_id AND relationship.role='guardian' AND relationship.manage_permission=original_manage AND relationship.training_permission=original_training) THEN RAISE EXCEPTION 'stronger guardian was downgraded or changed'; END IF;

  -- A revoked historical guardian gains a new active fixed grant; self never converts.
  token:=repeat('e',64); v_token_hash:=encode(extensions.digest(token,'sha256'),'hex');
  PERFORM set_config('request.jwt.claim.sub',manager_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; SELECT created.invitation_id INTO v_invitation_id FROM public.create_guardian_invitation(revoked_athlete_id,recipient_email,v_token_hash) AS created; EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub',recipient_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.accept_guardian_invitation(token); EXECUTE 'RESET ROLE';
  IF (SELECT count(*) FROM public.athlete_profile_relationships AS relationship WHERE relationship.athlete_id=revoked_athlete_id AND relationship.profile_id=recipient_id AND relationship.role='guardian') <> 2 THEN RAISE EXCEPTION 'revoked guardian history was not preserved'; END IF;
  token:=repeat('f',64); v_token_hash:=encode(extensions.digest(token,'sha256'),'hex');
  PERFORM set_config('request.jwt.claim.sub',manager_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; SELECT created.invitation_id INTO v_invitation_id FROM public.create_guardian_invitation(self_athlete_id,recipient_email,v_token_hash) AS created; EXECUTE 'RESET ROLE';
  failed:=false; BEGIN PERFORM set_config('request.jwt.claim.sub',recipient_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.create_guardian_invitation(self_athlete_id,view_email,encode(extensions.digest(repeat('l',64),'sha256'),'hex')); EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'self MANAGE relationship created guardian invitation'; END IF;
  PERFORM set_config('request.jwt.claim.sub',recipient_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  IF EXISTS (SELECT 1 FROM public.list_my_guardian_invitations(self_athlete_id)) THEN EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'self MANAGE relationship listed guardian invitations'; END IF;
  failed:=false; BEGIN PERFORM public.revoke_guardian_invitation(v_invitation_id); EXCEPTION WHEN others THEN failed:=true; END; EXECUTE 'RESET ROLE';
  IF NOT failed THEN RAISE EXCEPTION 'self MANAGE relationship revoked guardian invitation'; END IF;
  failed:=false; BEGIN PERFORM set_config('request.jwt.claim.sub',recipient_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.accept_guardian_invitation(token); EXECUTE 'RESET ROLE'; EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'self relationship was converted to guardian'; END IF;
  token:=repeat('n',64); v_token_hash:=encode(extensions.digest(token,'sha256'),'hex');
  INSERT INTO public.guardian_invitations(athlete_id, invited_email, inviter_profile_id, token_hash, expires_at)
  VALUES (self_athlete_id, view_email, recipient_id, v_token_hash, CURRENT_TIMESTAMP + interval '1 day');
  failed:=false; BEGIN PERFORM set_config('request.jwt.claim.sub',view_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.accept_guardian_invitation(token); EXECUTE 'RESET ROLE'; EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'self-based inviter authority accepted guardian invitation'; END IF;

  token:=repeat('u',64); v_token_hash:=encode(extensions.digest(token,'sha256'),'hex');
  PERFORM set_config('request.jwt.claim.sub',manager_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; SELECT created.invitation_id INTO v_invitation_id FROM public.create_guardian_invitation(inactive_athlete_id,recipient_email,v_token_hash) AS created; EXECUTE 'RESET ROLE';
  UPDATE public.athletes AS athlete SET status='archived', archived_at=clock_timestamp() WHERE athlete.id=inactive_athlete_id;
  failed:=false; BEGIN PERFORM set_config('request.jwt.claim.sub',recipient_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.accept_guardian_invitation(token); EXECUTE 'RESET ROLE'; EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'inactive athlete guardian invitation accepted'; END IF;

  -- Revocation and loss of inviter MANAGE authority both fail closed without changing guardian access.
  token:=repeat('g',64); v_token_hash:=encode(extensions.digest(token,'sha256'),'hex');
  PERFORM set_config('request.jwt.claim.sub',manager_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; SELECT created.invitation_id INTO v_invitation_id FROM public.create_guardian_invitation(authority_loss_athlete_id,recipient_email,v_token_hash) AS created; PERFORM public.revoke_guardian_invitation(v_invitation_id); EXECUTE 'RESET ROLE';
  failed:=false; BEGIN PERFORM set_config('request.jwt.claim.sub',recipient_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.accept_guardian_invitation(token); EXECUTE 'RESET ROLE'; EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'revoked guardian invitation accepted'; END IF;
  token:=repeat('i',64); v_token_hash:=encode(extensions.digest(token,'sha256'),'hex');
  PERFORM set_config('request.jwt.claim.sub',manager_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; SELECT created.invitation_id INTO expired_invitation_id FROM public.create_guardian_invitation(authority_loss_athlete_id,recipient_email,v_token_hash,clock_timestamp()+interval '1 second') AS created;
  failed:=false; BEGIN PERFORM public.create_guardian_invitation(authority_loss_athlete_id,recipient_email,repeat('j',64)); EXCEPTION WHEN others THEN failed:=true; END; EXECUTE 'RESET ROLE';
  IF NOT failed THEN RAISE EXCEPTION 'duplicate live guardian invitation was accepted'; END IF;
  PERFORM pg_sleep(1.1);
  failed:=false; BEGIN PERFORM set_config('request.jwt.claim.sub',recipient_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.accept_guardian_invitation(token); EXECUTE 'RESET ROLE'; EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'expired guardian invitation accepted'; END IF;
  token:=repeat('h',64); v_token_hash:=encode(extensions.digest(token,'sha256'),'hex');
  PERFORM set_config('request.jwt.claim.sub',manager_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; SELECT created.invitation_id INTO v_invitation_id FROM public.create_guardian_invitation(authority_loss_athlete_id,recipient_email,v_token_hash) AS created; EXECUTE 'RESET ROLE';
  IF (SELECT invitation.status FROM public.guardian_invitations AS invitation WHERE invitation.id=expired_invitation_id) <> 'expired' THEN RAISE EXCEPTION 'stale guardian invitation was not expired before replacement'; END IF;
  UPDATE public.athlete_profile_relationships AS relationship SET revoked_at=clock_timestamp() WHERE relationship.athlete_id=authority_loss_athlete_id AND relationship.profile_id=manager_id AND relationship.role='guardian' AND relationship.revoked_at IS NULL;
  failed:=false; BEGIN PERFORM set_config('request.jwt.claim.sub',recipient_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.accept_guardian_invitation(token); EXECUTE 'RESET ROLE'; EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'inviter authority loss did not block guardian acceptance'; END IF;

  -- Direct table/relationship writes are denied, and invitation revocation never revokes guardian access.
  PERFORM set_config('request.jwt.claim.sub',manager_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  failed:=false; BEGIN INSERT INTO public.guardian_invitations(athlete_id,invited_email,inviter_profile_id,token_hash,expires_at) VALUES(v_athlete_id,'direct@example.invalid',manager_id,repeat('0',64),clock_timestamp()+interval '1 day'); EXCEPTION WHEN insufficient_privilege THEN failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'direct guardian invitation write was not denied'; END IF;
  failed:=false; BEGIN INSERT INTO public.athlete_profile_relationships(athlete_id,profile_id,role,training_permission,manage_permission) VALUES(v_athlete_id,unrelated_id,'guardian',false,false); EXCEPTION WHEN insufficient_privilege THEN failed:=true; END; EXECUTE 'RESET ROLE';
  IF NOT failed THEN RAISE EXCEPTION 'direct guardian relationship write was not denied'; END IF;
  PERFORM set_config('request.jwt.claim.sub',manager_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  failed:=false; BEGIN PERFORM invitation.token_hash FROM public.guardian_invitations AS invitation WHERE invitation.id=v_invitation_id; EXCEPTION WHEN insufficient_privilege THEN failed:=true; END; EXECUTE 'RESET ROLE';
  IF NOT failed THEN RAISE EXCEPTION 'guardian invitation token hash was readable to authenticated manager'; END IF;
END;
$validation$;

ROLLBACK;
