-- Execute only after 20261009000000_sync_team_staff_membership_mirror.sql.
-- All fixture work is rollback-only and uses the authoritative legacy table.
BEGIN;

DO $validation$
DECLARE
  v_creator uuid;
  v_recipient uuid;
  v_stale_profile uuid;
  v_recipient_email text;
  v_team uuid;
  v_unrelated_team uuid;
  v_token text;
  v_invitation_id uuid;
  v_membership_id uuid;
  v_reconciled_id uuid;
  v_unrelated_membership_id uuid;
  v_stale_id uuid := gen_random_uuid();
  v_inconsistent_id uuid := gen_random_uuid();
  v_failed_closed boolean := false;
BEGIN
  SELECT profile.id, lower(btrim(user_record.email))
  INTO v_creator, v_recipient_email
  FROM public.profiles AS profile
  JOIN auth.users AS user_record ON user_record.id = profile.id
  WHERE user_record.email IS NOT NULL
    AND btrim(user_record.email) <> ''
  ORDER BY profile.id
  LIMIT 1;

  SELECT profile.id, lower(btrim(user_record.email))
  INTO v_recipient, v_recipient_email
  FROM public.profiles AS profile
  JOIN auth.users AS user_record ON user_record.id = profile.id
  WHERE profile.id <> v_creator
    AND user_record.email IS NOT NULL
    AND btrim(user_record.email) <> ''
  ORDER BY profile.id
  LIMIT 1;

  SELECT profile.id
  INTO v_stale_profile
  FROM public.profiles AS profile
  WHERE profile.id NOT IN (v_creator, v_recipient)
  ORDER BY profile.id
  LIMIT 1;

  IF v_creator IS NULL OR v_recipient IS NULL OR v_stale_profile IS NULL OR v_recipient_email IS NULL THEN
    RAISE EXCEPTION 'Three profiles and two profile-backed emails are required for staff mirror validation';
  END IF;

  -- Team creation routes through on_team_created, which writes the legacy
  -- coach membership. The new mirror trigger must write the same UUID.
  INSERT INTO public.teams (id, name, created_by_user_id)
  VALUES (gen_random_uuid(), 'Staff mirror validation ' || gen_random_uuid()::text, v_creator)
  RETURNING id INTO v_team;

  IF NOT EXISTS (
    SELECT 1
    FROM public.team_memberships AS legacy
    JOIN public.team_staff_memberships AS staff
      ON staff.id = legacy.id
     AND staff.team_id = legacy.team_id
     AND staff.profile_id = legacy.user_id
     AND staff.role::text = legacy.role::text
    WHERE legacy.team_id = v_team
      AND legacy.user_id = v_creator
      AND legacy.role = 'coach'::public.team_member_role
  ) THEN
    RAISE EXCEPTION 'Team creation did not create an exact canonical coach mirror';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_creator::text, true);
  IF NOT private.is_team_staff(v_team)
     OR NOT private.is_team_coach(v_team)
     OR NOT private.can_manage_team(v_team)
     OR NOT private.can_manage_roster(v_team) THEN
    RAISE EXCEPTION 'Team creation did not preserve canonical staff authorization';
  END IF;

  -- A parent cleanup must remain scoped to its own team.
  INSERT INTO public.teams (id, name, created_by_user_id)
  VALUES (gen_random_uuid(), 'Staff mirror unrelated validation ' || gen_random_uuid()::text, v_creator)
  RETURNING id INTO v_unrelated_team;
  INSERT INTO public.team_memberships (team_id, user_id, role, created_by_user_id)
  VALUES (v_unrelated_team, v_recipient, 'assistant_coach'::public.team_member_role, v_creator)
  RETURNING id INTO v_unrelated_membership_id;
  IF NOT EXISTS (
    SELECT 1
    FROM public.team_staff_memberships AS staff
    WHERE staff.id = v_unrelated_membership_id
      AND staff.team_id = v_unrelated_team
      AND staff.profile_id = v_recipient
      AND staff.role = 'assistant_coach'::public.team_staff_role
  ) THEN
    RAISE EXCEPTION 'Unrelated team did not create an exact canonical staff mirror';
  END IF;

  -- Assistant-coach invitation acceptance writes the authoritative legacy row;
  -- the mirror must be present before the acceptance call returns.
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO public.team_invitations (
    team_id, invited_email, role, invited_by_user_id, token_hash, expires_at
  ) VALUES (
    v_team,
    v_recipient_email,
    'assistant_coach'::public.team_member_role,
    v_creator,
    encode(extensions.digest(v_token, 'sha256'), 'hex'),
    clock_timestamp() + interval '1 hour'
  ) RETURNING id INTO v_invitation_id;

  PERFORM set_config('request.jwt.claim.sub', v_recipient::text, true);
  SELECT acceptance.membership_id
  INTO v_membership_id
  FROM public.accept_team_invitation(v_token) AS acceptance;
  PERFORM set_config('request.jwt.claim.sub', '', true);

  IF NOT EXISTS (
    SELECT 1
    FROM public.team_memberships AS legacy
    JOIN public.team_staff_memberships AS staff
      ON staff.id = legacy.id
     AND staff.team_id = legacy.team_id
     AND staff.profile_id = legacy.user_id
     AND staff.role::text = legacy.role::text
    WHERE legacy.id = v_membership_id
      AND legacy.role = 'assistant_coach'::public.team_member_role
  ) THEN
    RAISE EXCEPTION 'Assistant invitation acceptance did not create an exact canonical mirror';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_recipient::text, true);
  IF NOT private.is_team_staff(v_team)
     OR private.is_team_coach(v_team)
     OR private.can_manage_team(v_team)
     OR NOT private.can_manage_roster(v_team) THEN
    RAISE EXCEPTION 'Assistant invitation acceptance did not preserve canonical authorization';
  END IF;

  UPDATE public.team_memberships
  SET role = 'coach'::public.team_member_role
  WHERE id = v_membership_id;
  IF NOT EXISTS (
    SELECT 1 FROM public.team_staff_memberships
    WHERE id = v_membership_id AND role = 'coach'::public.team_staff_role
  ) THEN
    RAISE EXCEPTION 'Staff role update did not update the canonical mirror';
  END IF;
  IF NOT private.is_team_coach(v_team) OR NOT private.can_manage_team(v_team) THEN
    RAISE EXCEPTION 'Staff role update did not update canonical authorization';
  END IF;

  DELETE FROM public.team_memberships WHERE id = v_membership_id;
  IF EXISTS (SELECT 1 FROM public.team_staff_memberships WHERE id = v_membership_id) THEN
    RAISE EXCEPTION 'Staff removal did not remove the canonical mirror';
  END IF;
  IF private.is_team_staff(v_team)
     OR private.is_team_coach(v_team)
     OR private.can_manage_team(v_team)
     OR private.can_manage_roster(v_team) THEN
    RAISE EXCEPTION 'Staff removal retained canonical authorization';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', '', true);

  -- Revoking a pending assistant invitation must not materialize a staff row.
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO public.team_invitations (
    team_id, invited_email, role, invited_by_user_id, token_hash, expires_at
  ) VALUES (
    v_team,
    v_recipient_email,
    'assistant_coach'::public.team_member_role,
    v_creator,
    encode(extensions.digest(v_token, 'sha256'), 'hex'),
    clock_timestamp() + interval '1 hour'
  ) RETURNING id INTO v_invitation_id;
  UPDATE public.team_invitations SET status = 'revoked' WHERE id = v_invitation_id;
  IF EXISTS (SELECT 1 FROM public.team_staff_memberships WHERE team_id = v_team AND profile_id = v_recipient)
     OR NOT EXISTS (SELECT 1 FROM public.team_invitations WHERE id = v_invitation_id AND status = 'revoked') THEN
    RAISE EXCEPTION 'Assistant invitation revocation changed staff mirror state';
  END IF;

  -- Reconcile a missing same-UUID canonical row, remove a stale row, then
  -- prove a second run is a no-op with exact parity.
  INSERT INTO public.team_memberships (team_id, user_id, role, created_by_user_id)
  VALUES (v_team, v_recipient, 'assistant_coach'::public.team_member_role, v_creator)
  RETURNING id INTO v_reconciled_id;
  DELETE FROM public.team_staff_memberships WHERE id = v_reconciled_id;
  INSERT INTO public.team_staff_memberships (
    id, team_id, profile_id, role, created_by_profile_id, created_at
  ) VALUES (
    v_stale_id, v_team, v_stale_profile, 'assistant_coach'::public.team_staff_role, v_creator, clock_timestamp()
  );
  PERFORM private.reconcile_team_staff_memberships();
  PERFORM private.reconcile_team_staff_memberships();

  IF NOT EXISTS (SELECT 1 FROM public.team_staff_memberships WHERE id = v_reconciled_id)
     OR EXISTS (SELECT 1 FROM public.team_staff_memberships WHERE id = v_stale_id) THEN
    RAISE EXCEPTION 'Staff mirror reconciliation is not rerun-safe';
  END IF;

  -- Reconciliation must fail closed if a current team/profile pair was
  -- detached from its deterministic legacy UUID. The exception block rolls
  -- back the corrupt fixture and leaves the parity fixture intact.
  BEGIN
    DELETE FROM public.team_staff_memberships WHERE id = v_reconciled_id;
    INSERT INTO public.team_staff_memberships (
      id, team_id, profile_id, role, created_by_profile_id, created_at
    ) VALUES (
      v_inconsistent_id, v_team, v_recipient, 'assistant_coach'::public.team_staff_role, v_creator, clock_timestamp()
    );
    PERFORM private.reconcile_team_staff_memberships();
  EXCEPTION WHEN OTHERS THEN
    v_failed_closed := true;
  END;
  IF NOT v_failed_closed THEN
    RAISE EXCEPTION 'Staff mirror reconciliation accepted an inconsistent UUID mapping';
  END IF;

  -- The canonical table intentionally keeps its restrictive team FK. Parent
  -- deletion must nevertheless clear mirrored staff before the legacy
  -- membership cascade runs, then leave no staff orphan behind.
  DELETE FROM public.teams WHERE id = v_team;
  IF EXISTS (SELECT 1 FROM public.teams WHERE id = v_team)
     OR EXISTS (SELECT 1 FROM public.team_memberships WHERE team_id = v_team)
     OR EXISTS (SELECT 1 FROM public.team_staff_memberships WHERE team_id = v_team)
     OR NOT EXISTS (
       SELECT 1
       FROM public.team_memberships AS legacy
       JOIN public.team_staff_memberships AS staff
         ON staff.id = legacy.id
        AND staff.team_id = legacy.team_id
        AND staff.profile_id = legacy.user_id
        AND staff.role::text = legacy.role::text
       WHERE legacy.id = v_unrelated_membership_id
         AND legacy.team_id = v_unrelated_team
     ) THEN
    RAISE EXCEPTION 'Team deletion did not remove mirrored staff memberships';
  END IF;
END;
$validation$;

ROLLBACK;
