-- Execute only after the reconciled historical migration and forward acceptance-RPC
-- grant migration are applied, as its owner.
-- This fixture is rollback-only; it needs three confirmed auth-backed profiles.
BEGIN;

DO $validation$
DECLARE
  manager_id uuid; recipient_id uuid; unrelated_id uuid; validator_team_id uuid; recipient_email text; unrelated_email text;
  managed_id uuid := gen_random_uuid(); view_id uuid := gen_random_uuid(); archived_id uuid := gen_random_uuid(); guessed_id uuid := gen_random_uuid();
  invitation_id uuid; new_athlete_id uuid; candidate_id uuid;
  token text; validator_token_hash text; failed boolean; athletes_before integer; relationships_before integer; rosters_before integer;
BEGIN
  SELECT p.id INTO manager_id
  FROM public.profiles AS p JOIN auth.users AS u ON u.id = p.id
  ORDER BY p.id LIMIT 1;
  SELECT p.id, u.email INTO recipient_id, recipient_email
  FROM public.profiles AS p JOIN auth.users AS u ON u.id = p.id
  WHERE p.id <> manager_id
    AND u.email_confirmed_at IS NOT NULL
    AND u.email IS NOT NULL
    AND btrim(u.email) <> ''
    AND lower(btrim(u.email)) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ORDER BY p.id LIMIT 1;
  SELECT p.id, u.email INTO unrelated_id, unrelated_email
  FROM public.profiles AS p JOIN auth.users AS u ON u.id = p.id
  WHERE p.id NOT IN (manager_id, recipient_id)
    AND NOT private.is_admin(p.id)
  ORDER BY p.id LIMIT 1;
  IF manager_id IS NULL OR recipient_id IS NULL OR recipient_email IS NULL THEN
    RAISE EXCEPTION 'Validator fixture error: requires a manager and confirmed production-valid recipient email';
  END IF;
  IF unrelated_id IS NULL THEN
    RAISE EXCEPTION 'Validator fixture error: requires a non-admin unrelated auth-backed profile';
  END IF;
  IF unrelated_email IS NULL OR btrim(unrelated_email) = '' THEN
    RAISE EXCEPTION 'Validator fixture error: requires a usable unrelated profile email';
  END IF;
  INSERT INTO public.teams(name, created_by_user_id) VALUES ('Family invitation validation ' || gen_random_uuid(), manager_id) RETURNING id INTO validator_team_id;
  -- on_team_created already creates the manager's coach membership.
  IF NOT EXISTS (
    SELECT 1 FROM public.team_memberships AS membership
    WHERE membership.team_id = validator_team_id AND membership.user_id = manager_id AND membership.role = 'coach'
  ) THEN
    RAISE EXCEPTION 'Validator fixture error: canonical team creation did not create manager coach membership';
  END IF;
  IF unrelated_id = manager_id
     OR unrelated_id = recipient_id
     OR private.is_admin(unrelated_id)
     OR private.can_manage_roster(validator_team_id, unrelated_id) THEN
    RAISE EXCEPTION 'Validator fixture error: unrelated profile has roster-management authority';
  END IF;
  INSERT INTO public.athletes(id, display_name, created_by_profile_id) VALUES
    (managed_id, 'Managed athlete', recipient_id), (view_id, 'View-only athlete', recipient_id), (archived_id, 'Archived athlete', recipient_id);
  UPDATE public.athletes SET status='archived', archived_at=clock_timestamp() WHERE id=archived_id;
  INSERT INTO public.athlete_profile_relationships(athlete_id, profile_id, role, training_permission, manage_permission, created_by_profile_id) VALUES
    (managed_id, recipient_id, 'guardian', true, true, recipient_id),
    (view_id, recipient_id, 'guardian', false, false, recipient_id),
    (archived_id, recipient_id, 'guardian', true, true, recipient_id);

  -- Authorized creation is hash-only; unauthorized creation fails.
  token := repeat('a', 64); validator_token_hash := encode(extensions.digest(token, 'sha256'), 'hex');
  PERFORM set_config('request.jwt.claim.sub', manager_id::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT created.invitation_id INTO invitation_id FROM public.create_family_team_invitation(validator_team_id, recipient_email, validator_token_hash) AS created; EXECUTE 'RESET ROLE';
  IF NOT EXISTS (SELECT 1 FROM public.family_team_invitations AS i WHERE i.id=invitation_id AND i.token_hash=validator_token_hash) THEN RAISE EXCEPTION 'authorized creation failed'; END IF;
  failed := false; BEGIN
    PERFORM set_config('request.jwt.claim.sub', unrelated_id::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.create_family_team_invitation(validator_team_id, 'unauthorized@example.invalid', repeat('0',64)); EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; failed := true; END;
  IF NOT failed THEN RAISE EXCEPTION 'unauthorized team user created invitation'; END IF;

  -- Managers get metadata but cannot directly read a token verifier.
  PERFORM set_config('request.jwt.claim.sub', manager_id::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM i.id FROM public.family_team_invitations AS i WHERE i.id=invitation_id;
  failed := false; BEGIN PERFORM i.token_hash FROM public.family_team_invitations AS i WHERE i.id=invitation_id;
  EXCEPTION WHEN insufficient_privilege THEN failed := true; END;
  EXECUTE 'RESET ROLE'; IF NOT failed THEN RAISE EXCEPTION 'manager token_hash read was not denied'; END IF;

  -- Boundary A: the authenticated browser path is revoked independently of
  -- invitation state.  This must fail by effective function privilege.
  failed := false; BEGIN
    PERFORM set_config('request.jwt.claim.sub', recipient_id::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.accept_family_team_invitation(token, managed_id);
  EXCEPTION WHEN insufficient_privilege THEN failed := true;
  END;
  EXECUTE 'RESET ROLE';
  IF NOT failed THEN RAISE EXCEPTION 'authenticated direct family acceptance was not denied'; END IF;

  -- Boundary B below assumes the server has already completed authoritative
  -- Auth verification and supplies fixture-specific trusted ID/email values.
  -- It tests database authorization and transactions, not GoTrue verification.
  -- Wrong email, guessed UUID, VIEW-only, and archived athlete selections all fail.
  failed := false; BEGIN
    EXECUTE 'SET LOCAL ROLE service_role';
    PERFORM public.server_accept_family_team_invitation(unrelated_id, lower(btrim(unrelated_email)), token, managed_id, NULL, NULL, NULL); EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; failed := true; END;
  IF NOT failed THEN RAISE EXCEPTION 'wrong email accepted invitation'; END IF;
  FOREACH candidate_id IN ARRAY ARRAY[guessed_id, view_id, archived_id] LOOP
    failed := false; BEGIN
      EXECUTE 'SET LOCAL ROLE service_role';
      PERFORM public.server_accept_family_team_invitation(recipient_id, lower(btrim(recipient_email)), token, candidate_id, NULL, NULL, NULL); EXECUTE 'RESET ROLE';
    EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; failed := true; END;
    IF NOT failed THEN RAISE EXCEPTION 'guessed, VIEW-only, or archived athlete accepted invitation'; END IF;
  END LOOP;

  -- Existing membership is idempotent, but an accepted token cannot be replayed.
  INSERT INTO public.team_athlete_memberships(team_id, athlete_id, created_by_profile_id) VALUES (validator_team_id, managed_id, manager_id);
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM public.server_accept_family_team_invitation(recipient_id, lower(btrim(recipient_email)), token, managed_id, NULL, NULL, NULL); EXECUTE 'RESET ROLE';
  IF (SELECT count(*) FROM public.team_athlete_memberships AS m WHERE m.team_id=validator_team_id AND m.athlete_id=managed_id) <> 1
     OR (SELECT i.status FROM public.family_team_invitations AS i WHERE i.id=invitation_id) <> 'accepted' THEN RAISE EXCEPTION 'idempotent acceptance failed'; END IF;
  failed := false; BEGIN
    EXECUTE 'SET LOCAL ROLE service_role';
    PERFORM public.server_accept_family_team_invitation(recipient_id, lower(btrim(recipient_email)), token, managed_id, NULL, NULL, NULL); EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; failed := true; END;
  IF NOT failed THEN RAISE EXCEPTION 'accepted invitation replay succeeded'; END IF;

  -- Revoked and expired cases fail before enrollment.
  token := repeat('b',64); validator_token_hash := encode(extensions.digest(token,'sha256'),'hex');
  PERFORM set_config('request.jwt.claim.sub', manager_id::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT created.invitation_id INTO invitation_id FROM public.create_family_team_invitation(validator_team_id,recipient_email,validator_token_hash) AS created;
  PERFORM public.revoke_family_team_invitation(invitation_id); EXECUTE 'RESET ROLE';
  failed := false; BEGIN EXECUTE 'SET LOCAL ROLE service_role'; PERFORM public.server_accept_family_team_invitation(recipient_id,lower(btrim(recipient_email)),token,NULL,'Revoked','Child',2034); EXECUTE 'RESET ROLE'; EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'revoked token accepted'; END IF;
  token := repeat('c',64); validator_token_hash := encode(extensions.digest(token,'sha256'),'hex');
  PERFORM set_config('request.jwt.claim.sub', manager_id::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT created.invitation_id INTO invitation_id FROM public.create_family_team_invitation(validator_team_id,recipient_email,validator_token_hash,clock_timestamp()+interval '1 second') AS created; EXECUTE 'RESET ROLE'; PERFORM pg_sleep(1.1);
  failed := false; BEGIN EXECUTE 'SET LOCAL ROLE service_role'; PERFORM public.server_accept_family_team_invitation(recipient_id,lower(btrim(recipient_email)),token,NULL,'Expired','Child',2034); EXECUTE 'RESET ROLE'; EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'expired token accepted'; END IF;
  -- New child is structured, recipient-guardian-managed, durably rostered, and never a legacy parent membership or self relation.
  token := repeat('e',64); validator_token_hash := encode(extensions.digest(token,'sha256'),'hex');
  PERFORM set_config('request.jwt.claim.sub',manager_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; SELECT created.invitation_id INTO invitation_id FROM public.create_family_team_invitation(validator_team_id,recipient_email,validator_token_hash) AS created; EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE service_role'; SELECT athlete_id INTO new_athlete_id FROM public.server_accept_family_team_invitation(recipient_id,lower(btrim(recipient_email)),token,NULL,'New','Child',2034); EXECUTE 'RESET ROLE';
  IF NOT EXISTS (SELECT 1 FROM public.athletes AS a WHERE a.id=new_athlete_id AND a.first_name='New' AND a.last_name='Child' AND a.graduation_year=2034)
     OR NOT EXISTS (SELECT 1 FROM public.athlete_profile_relationships AS r WHERE r.athlete_id=new_athlete_id AND r.profile_id=recipient_id AND r.role='guardian' AND r.training_permission AND r.manage_permission)
     OR NOT EXISTS (SELECT 1 FROM public.team_athlete_memberships AS m WHERE m.team_id=validator_team_id AND m.athlete_id=new_athlete_id)
     OR EXISTS (SELECT 1 FROM public.team_memberships AS m WHERE m.team_id=validator_team_id AND m.user_id=recipient_id)
     OR EXISTS (SELECT 1 FROM public.athlete_profile_relationships AS r WHERE r.athlete_id=new_athlete_id AND r.role='self') THEN RAISE EXCEPTION 'new child violated family-first invariants'; END IF;

  -- Direct writes fail. A validation failure leaves no child/relationship/roster change and invitation pending.
  PERFORM set_config('request.jwt.claim.sub',manager_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; failed:=false; BEGIN INSERT INTO public.family_team_invitations(team_id,invited_email,invited_by_profile_id,token_hash,expires_at) VALUES(validator_team_id,'direct@example.invalid',manager_id,repeat('f',64),clock_timestamp()+interval '1 day'); EXCEPTION WHEN insufficient_privilege THEN failed:=true; END; EXECUTE 'RESET ROLE';
  IF NOT failed THEN RAISE EXCEPTION 'direct invitation write was not denied'; END IF;
  PERFORM set_config('request.jwt.claim.sub',recipient_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; failed:=false; BEGIN INSERT INTO public.team_athlete_memberships(team_id,athlete_id,created_by_profile_id) VALUES(validator_team_id,guessed_id,recipient_id); EXCEPTION WHEN insufficient_privilege THEN failed:=true; END; EXECUTE 'RESET ROLE';
  IF NOT failed THEN RAISE EXCEPTION 'direct durable roster write was not denied'; END IF;
  SELECT count(*) INTO athletes_before FROM public.athletes; SELECT count(*) INTO relationships_before FROM public.athlete_profile_relationships; SELECT count(*) INTO rosters_before FROM public.team_athlete_memberships;
  token:=repeat('g',64); validator_token_hash:=encode(extensions.digest(token,'sha256'),'hex'); PERFORM set_config('request.jwt.claim.sub',manager_id::text,true); EXECUTE 'SET LOCAL ROLE authenticated'; SELECT created.invitation_id INTO invitation_id FROM public.create_family_team_invitation(validator_team_id,recipient_email,validator_token_hash) AS created; EXECUTE 'RESET ROLE';
  failed:=false; BEGIN EXECUTE 'SET LOCAL ROLE service_role'; PERFORM public.server_accept_family_team_invitation(recipient_id,lower(btrim(recipient_email)),token,NULL,'Rollback',NULL,2034); EXECUTE 'RESET ROLE'; EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; failed:=true; END;
  IF NOT failed OR (SELECT count(*) FROM public.athletes)<>athletes_before OR (SELECT count(*) FROM public.athlete_profile_relationships)<>relationships_before OR (SELECT count(*) FROM public.team_athlete_memberships)<>rosters_before OR (SELECT i.status FROM public.family_team_invitations AS i WHERE i.id=invitation_id)<>'pending' THEN RAISE EXCEPTION 'failed acceptance did not roll back'; END IF;
  -- The same pending rollback fixture independently proves that later inviter-authority loss blocks acceptance.
  DELETE FROM public.team_memberships AS m WHERE m.team_id=validator_team_id AND m.user_id=manager_id;
  failed:=false; BEGIN EXECUTE 'SET LOCAL ROLE service_role'; PERFORM public.server_accept_family_team_invitation(recipient_id,lower(btrim(recipient_email)),token,NULL,'Authority','Lost',2034); EXECUTE 'RESET ROLE'; EXCEPTION WHEN others THEN EXECUTE 'RESET ROLE'; failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'inviter authority loss did not block acceptance'; END IF;
END;
$validation$;

ROLLBACK;
