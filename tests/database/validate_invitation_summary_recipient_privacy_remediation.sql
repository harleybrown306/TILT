-- Execute only against a disposable local database after
-- 20261023000000_harden_invitation_summary_recipient_privacy.sql. Every
-- fixture and assertion is rollback-only.
BEGIN;

DO $validation$
DECLARE
  v_manager uuid := gen_random_uuid();
  v_recipient uuid := gen_random_uuid();
  v_wrong_recipient uuid := gen_random_uuid();
  v_unverified_recipient uuid := gen_random_uuid();
  v_team uuid;
  v_accepted_athlete uuid := gen_random_uuid();
  v_family_accepted_athlete uuid := gen_random_uuid();
  v_team_pending_token text := repeat('a', 64);
  v_team_accepted_token text := repeat('b', 64);
  v_team_revoked_token text := repeat('c', 64);
  v_team_expired_token text := repeat('d', 64);
  v_team_acceptance_token text := repeat('e', 64);
  v_family_pending_token text := repeat('f', 64);
  v_family_accepted_token text := repeat('g', 64);
  v_family_revoked_token text := repeat('h', 64);
  v_family_expired_token text := repeat('i', 64);
  v_recipient_email text := 'summary-recipient@example.test';
  v_wrong_email text := 'summary-wrong@example.test';
  v_expected_status public.team_invitation_status;
  v_observed_status public.team_invitation_status;
  v_expected_team_name text;
  v_returned_team_name text;
  v_membership_id uuid;
  v_created_athlete uuid;
  v_rows bigint;
  v_denied boolean;
BEGIN
  -- Profiles are created by the existing auth-user trigger. The unverified
  -- identity is intentionally present only to prove the browser helper must
  -- reject it before the service-only wrapper can be reached.
  INSERT INTO auth.users (
    id, aud, role, email, email_confirmed_at, raw_app_meta_data,
    raw_user_meta_data, created_at, updated_at
  ) VALUES
    (v_manager, 'authenticated', 'authenticated', 'summary-manager@example.test', clock_timestamp(), '{}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp()),
    (v_recipient, 'authenticated', 'authenticated', v_recipient_email, clock_timestamp(), '{}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp()),
    (v_wrong_recipient, 'authenticated', 'authenticated', v_wrong_email, clock_timestamp(), '{}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp()),
    (v_unverified_recipient, 'authenticated', 'authenticated', 'summary-unverified@example.test', NULL, '{}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp());

  IF (SELECT count(*) FROM public.profiles WHERE id IN (v_manager, v_recipient, v_wrong_recipient, v_unverified_recipient)) <> 4 THEN
    RAISE EXCEPTION 'Synthetic auth users did not create invitation-summary profile fixtures';
  END IF;

  INSERT INTO public.teams (id, name, created_by_user_id)
  VALUES (gen_random_uuid(), 'Summary privacy validation ' || gen_random_uuid()::text, v_manager)
  RETURNING id, name INTO v_team, v_expected_team_name;

  IF NOT EXISTS (
    SELECT 1 FROM public.team_memberships
    WHERE team_id = v_team AND user_id = v_manager AND role = 'coach'::public.team_member_role
  ) THEN
    RAISE EXCEPTION 'Synthetic summary manager did not receive the initial coach membership';
  END IF;

  INSERT INTO public.athletes (id, display_name, created_by_profile_id)
  VALUES
    (v_accepted_athlete, 'Summary accepted athlete', v_manager),
    (v_family_accepted_athlete, 'Family summary accepted athlete', v_manager);

  -- Four lifecycle states for each summary. The team pending token is kept
  -- distinct from the direct legacy-acceptance token by invitation role.
  INSERT INTO public.team_invitations (
    team_id, invited_email, role, invited_by_user_id, token_hash, status, expires_at,
    accepted_by_user_id, accepted_at, revoked_at
  ) VALUES
    (v_team, v_recipient_email, 'athlete', v_manager, encode(extensions.digest(v_team_pending_token, 'sha256'), 'hex'), 'pending', clock_timestamp() + interval '1 day', NULL, NULL, NULL),
    (v_team, v_recipient_email, 'athlete', v_manager, encode(extensions.digest(v_team_accepted_token, 'sha256'), 'hex'), 'accepted', clock_timestamp() + interval '1 day', v_recipient, clock_timestamp(), NULL),
    (v_team, v_recipient_email, 'athlete', v_manager, encode(extensions.digest(v_team_revoked_token, 'sha256'), 'hex'), 'revoked', clock_timestamp() + interval '1 day', NULL, NULL, clock_timestamp()),
    (v_team, v_recipient_email, 'athlete', v_manager, encode(extensions.digest(v_team_expired_token, 'sha256'), 'hex'), 'expired', clock_timestamp() - interval '1 day', NULL, NULL, NULL),
    (v_team, v_recipient_email, 'assistant_coach', v_manager, encode(extensions.digest(v_team_acceptance_token, 'sha256'), 'hex'), 'pending', clock_timestamp() + interval '1 day', NULL, NULL, NULL);

  INSERT INTO public.family_team_invitations (
    team_id, invited_email, invited_by_profile_id, token_hash, status, expires_at,
    accepted_by_profile_id, accepted_athlete_id, accepted_at, revoked_by_profile_id, revoked_at
  ) VALUES
    (v_team, v_recipient_email, v_manager, encode(extensions.digest(v_family_pending_token, 'sha256'), 'hex'), 'pending', clock_timestamp() + interval '1 day', NULL, NULL, NULL, NULL, NULL),
    (v_team, v_recipient_email, v_manager, encode(extensions.digest(v_family_accepted_token, 'sha256'), 'hex'), 'accepted', clock_timestamp() + interval '1 day', v_recipient, v_family_accepted_athlete, clock_timestamp(), NULL, NULL),
    (v_team, v_recipient_email, v_manager, encode(extensions.digest(v_family_revoked_token, 'sha256'), 'hex'), 'revoked', clock_timestamp() + interval '1 day', NULL, NULL, NULL, v_manager, clock_timestamp()),
    (v_team, v_recipient_email, v_manager, encode(extensions.digest(v_family_expired_token, 'sha256'), 'hex'), 'expired', clock_timestamp() + interval '1 day', NULL, NULL, NULL, NULL, NULL);

  -- Phase 1 preserves the authenticated legacy RPCs so previously deployed
  -- invitation links remain usable until the app cutover is validated.
  IF NOT has_function_privilege('authenticated', 'public.get_team_invitation_summary(text)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_family_team_invitation_summary(text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'Compatibility phase removed a legacy authenticated summary grant';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc AS procedure
    WHERE procedure.oid IN (
      'public.server_get_team_invitation_summary(uuid,text,text)'::regprocedure,
      'public.server_get_family_team_invitation_summary(uuid,text,text)'::regprocedure
    ) AND (
      NOT procedure.prosecdef
      OR NOT (coalesce(procedure.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=""']::text[])
      OR NOT has_function_privilege('service_role', procedure.oid, 'EXECUTE')
      OR has_function_privilege('public', procedure.oid, 'EXECUTE')
      OR has_function_privilege('anon', procedure.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
    )
  ) THEN
    RAISE EXCEPTION 'Server invitation summary wrapper privilege boundary is incorrect';
  END IF;

  -- Exercise both old calls as an authenticated browser role. This deliberate
  -- compatibility assertion is inverted by the phase-2 validator.
  PERFORM set_config('request.jwt.claim.sub', v_wrong_recipient::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_rows FROM public.get_team_invitation_summary(v_team_pending_token);
  IF v_rows <> 1 THEN RAISE EXCEPTION 'Legacy team summary compatibility regressed'; END IF;
  SELECT count(*) INTO v_rows FROM public.get_family_team_invitation_summary(v_family_pending_token);
  IF v_rows <> 1 THEN RAISE EXCEPTION 'Legacy family summary compatibility regressed'; END IF;
  EXECUTE 'RESET ROLE';

  -- A wrong recipient and an invalid bearer both produce no row for both
  -- invitation types. The service assertion represents the server-only
  -- getCurrentVerifiedAuthIdentity() boundary, not a browser-supplied claim.
  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT count(*) INTO v_rows FROM public.server_get_team_invitation_summary(v_wrong_recipient, v_wrong_email, v_team_pending_token);
  IF v_rows <> 0 THEN RAISE EXCEPTION 'Wrong email received team invitation metadata'; END IF;
  SELECT count(*) INTO v_rows FROM public.server_get_family_team_invitation_summary(v_wrong_recipient, v_wrong_email, v_family_pending_token);
  IF v_rows <> 0 THEN RAISE EXCEPTION 'Wrong email received family invitation metadata'; END IF;
  SELECT count(*) INTO v_rows FROM public.server_get_team_invitation_summary(v_wrong_recipient, v_recipient_email, v_team_pending_token);
  IF v_rows <> 0 THEN RAISE EXCEPTION 'Server wrapper accepted an email not confirmed for the supplied user'; END IF;
  SELECT count(*) INTO v_rows FROM public.server_get_family_team_invitation_summary(v_unverified_recipient, 'summary-unverified@example.test', v_family_pending_token);
  IF v_rows <> 0 THEN RAISE EXCEPTION 'Server wrapper accepted an unverified auth user'; END IF;
  SELECT count(*) INTO v_rows FROM public.server_get_team_invitation_summary(v_recipient, v_recipient_email, repeat('z', 64));
  IF v_rows <> 0 THEN RAISE EXCEPTION 'Invalid token returned team invitation metadata'; END IF;
  SELECT count(*) INTO v_rows FROM public.server_get_family_team_invitation_summary(v_recipient, v_recipient_email, repeat('z', 64));
  IF v_rows <> 0 THEN RAISE EXCEPTION 'Invalid token returned family invitation metadata'; END IF;
  SELECT count(*) INTO v_rows FROM public.server_get_team_invitation_summary(v_unverified_recipient, NULL, v_team_pending_token);
  IF v_rows <> 0 THEN RAISE EXCEPTION 'Missing verified-email assertion returned team metadata'; END IF;
  SELECT count(*) INTO v_rows FROM public.server_get_family_team_invitation_summary(v_unverified_recipient, NULL, v_family_pending_token);
  IF v_rows <> 0 THEN RAISE EXCEPTION 'Missing verified-email assertion returned family metadata'; END IF;
  EXECUTE 'RESET ROLE';

  EXECUTE 'SET LOCAL ROLE service_role';
  FOREACH v_expected_status IN ARRAY ARRAY['pending'::public.team_invitation_status, 'accepted'::public.team_invitation_status, 'revoked'::public.team_invitation_status, 'expired'::public.team_invitation_status] LOOP
    SELECT summary.team_name, summary.invitation_status INTO v_returned_team_name, v_observed_status
    FROM public.server_get_team_invitation_summary(
      v_recipient, v_recipient_email,
      CASE v_expected_status WHEN 'pending' THEN v_team_pending_token WHEN 'accepted' THEN v_team_accepted_token WHEN 'revoked' THEN v_team_revoked_token ELSE v_team_expired_token END
    ) AS summary;
    IF v_returned_team_name IS DISTINCT FROM v_expected_team_name OR v_observed_status IS DISTINCT FROM v_expected_status THEN
      RAISE EXCEPTION 'Recipient team summary lifecycle assertion failed';
    END IF;
  END LOOP;

  -- Re-read each family status explicitly; it avoids any caller-controlled
  -- filtering and confirms historical accepted/revoked/expired summaries are
  -- still available only to the invited verified recipient.
  SELECT invitation_status INTO v_observed_status FROM public.server_get_family_team_invitation_summary(v_recipient, v_recipient_email, v_family_pending_token);
  IF v_observed_status <> 'pending' THEN RAISE EXCEPTION 'Pending family summary was not returned'; END IF;
  SELECT invitation_status INTO v_observed_status FROM public.server_get_family_team_invitation_summary(v_recipient, v_recipient_email, v_family_accepted_token);
  IF v_observed_status <> 'accepted' THEN RAISE EXCEPTION 'Accepted family summary was not returned'; END IF;
  SELECT invitation_status INTO v_observed_status FROM public.server_get_family_team_invitation_summary(v_recipient, v_recipient_email, v_family_revoked_token);
  IF v_observed_status <> 'revoked' THEN RAISE EXCEPTION 'Revoked family summary was not returned'; END IF;
  SELECT invitation_status INTO v_observed_status FROM public.server_get_family_team_invitation_summary(v_recipient, v_recipient_email, v_family_expired_token);
  IF v_observed_status <> 'expired' THEN RAISE EXCEPTION 'Expired family summary was not returned'; END IF;
  EXECUTE 'RESET ROLE';

  -- The legacy acceptance path remains direct authenticated RPC behavior.
  PERFORM set_config('request.jwt.claim.sub', v_recipient::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT membership_id INTO v_membership_id FROM public.accept_team_invitation(v_team_acceptance_token);
  EXECUTE 'RESET ROLE';
  IF v_membership_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.team_invitations
    WHERE token_hash = encode(extensions.digest(v_team_acceptance_token, 'sha256'), 'hex') AND status = 'accepted'
  ) THEN
    RAISE EXCEPTION 'Legitimate legacy team invitation acceptance regressed';
  END IF;

  -- The existing family no-login-child path remains service-mediated and
  -- atomically creates the child relationship and team enrollment.
  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT athlete_id INTO v_created_athlete
  FROM public.server_accept_family_team_invitation(
    v_recipient, v_recipient_email, v_family_pending_token,
    NULL, 'Local', 'Child', 2035
  );
  EXECUTE 'RESET ROLE';
  IF v_created_athlete IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.team_athlete_memberships WHERE team_id = v_team AND athlete_id = v_created_athlete)
     OR NOT EXISTS (SELECT 1 FROM public.athlete_profile_relationships WHERE athlete_id = v_created_athlete AND profile_id = v_recipient AND role = 'guardian')
     OR NOT EXISTS (SELECT 1 FROM public.family_team_invitations WHERE token_hash = encode(extensions.digest(v_family_pending_token, 'sha256'), 'hex') AND status = 'accepted') THEN
    RAISE EXCEPTION 'Legitimate family no-login-child acceptance regressed';
  END IF;
END;
$validation$;

ROLLBACK;
