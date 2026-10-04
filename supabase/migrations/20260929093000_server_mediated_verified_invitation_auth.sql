BEGIN;

-- Auth facts are asserted by the trusted server immediately before these
-- operations.  They are transaction-local and inaccessible to browser RPCs.
CREATE FUNCTION private.server_verified_email()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  SELECT nullif(current_setting('tilt.verified_email', true), '');
$$;
REVOKE ALL ON FUNCTION private.server_verified_email() FROM PUBLIC, anon, authenticated;

-- All predecessor signatures must exist before any replacement is attempted.
DO $$
BEGIN
  IF to_regprocedure('public.accept_family_team_invitation(text,uuid,text,text,integer)') IS NULL THEN
    RAISE EXCEPTION 'Expected predecessor function is missing: public.accept_family_team_invitation(text,uuid,text,text,integer)';
  END IF;
  IF to_regprocedure('public.create_guardian_invitation(uuid,text,text,timestamp with time zone)') IS NULL THEN
    RAISE EXCEPTION 'Expected predecessor function is missing: public.create_guardian_invitation(uuid,text,text,timestamp with time zone)';
  END IF;
  IF to_regprocedure('public.get_guardian_invitation_summary(text)') IS NULL THEN
    RAISE EXCEPTION 'Expected predecessor function is missing: public.get_guardian_invitation_summary(text)';
  END IF;
  IF to_regprocedure('public.accept_guardian_invitation(text)') IS NULL THEN
    RAISE EXCEPTION 'Expected predecessor function is missing: public.accept_guardian_invitation(text)';
  END IF;
  IF to_regprocedure('public.get_child_login_invitation_summary(text)') IS NULL THEN
    RAISE EXCEPTION 'Expected predecessor function is missing: public.get_child_login_invitation_summary(text)';
  END IF;
  IF to_regprocedure('public.accept_child_login_invitation(text)') IS NULL THEN
    RAISE EXCEPTION 'Expected predecessor function is missing: public.accept_child_login_invitation(text)';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_family_team_invitation(
  p_invitation_token text,
  p_existing_athlete_id uuid DEFAULT NULL,
  p_first_name text DEFAULT NULL,
  p_last_name text DEFAULT NULL,
  p_graduation_year integer DEFAULT NULL
)
RETURNS TABLE(team_id uuid, athlete_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_email text;
  v_email_confirmed_at timestamptz;
  v_invitation public.family_team_invitations%ROWTYPE;
  v_athlete_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_invitation_token IS NULL
     OR char_length(p_invitation_token) NOT BETWEEN 32 AND 256
     OR p_invitation_token !~ '^[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'Family invitation is invalid or unavailable';
  END IF;
  IF (p_existing_athlete_id IS NULL) = (p_first_name IS NULL AND p_last_name IS NULL AND p_graduation_year IS NULL) THEN
    RAISE EXCEPTION 'Choose an existing athlete or provide new child details';
  END IF;

  v_email := private.server_verified_email();
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'Authenticated account must have a verified email';
  END IF;

  SELECT invitation.* INTO v_invitation
  FROM public.family_team_invitations AS invitation
  WHERE invitation.token_hash = encode(extensions.digest(p_invitation_token, 'sha256'), 'hex')
  FOR UPDATE;
  IF NOT FOUND OR v_invitation.status <> 'pending' OR v_invitation.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Family invitation is no longer pending';
  END IF;
  IF lower(v_email) <> v_invitation.invited_email THEN
    RAISE EXCEPTION 'Invitation email does not match the signed-in account';
  END IF;
  IF NOT private.can_manage_roster(v_invitation.team_id, v_invitation.invited_by_profile_id) THEN
    RAISE EXCEPTION 'Inviter no longer has permission to enroll families';
  END IF;

  IF p_existing_athlete_id IS NOT NULL THEN
    IF NOT private.can_manage_athlete(p_existing_athlete_id) THEN
      RAISE EXCEPTION 'Selected athlete is not manageable by this account' USING ERRCODE = '42501';
    END IF;
    SELECT athlete.id INTO v_athlete_id FROM public.athletes AS athlete
    WHERE athlete.id = p_existing_athlete_id AND athlete.status = 'active';
    IF v_athlete_id IS NULL THEN
      RAISE EXCEPTION 'Selected athlete is unavailable';
    END IF;
  ELSE
    v_athlete_id := private.create_guardian_managed_athlete(
      v_actor, p_first_name, p_last_name, p_graduation_year
    );
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_invitation.team_id::text || ':' || v_athlete_id::text, 0)
  );
  IF NOT EXISTS (
    SELECT 1 FROM public.team_athlete_memberships AS membership
    WHERE membership.team_id = v_invitation.team_id AND membership.athlete_id = v_athlete_id
  ) THEN
    INSERT INTO public.team_athlete_memberships (team_id, athlete_id, created_by_profile_id)
    VALUES (v_invitation.team_id, v_athlete_id, v_actor);
  END IF;

  UPDATE public.family_team_invitations
  SET status = 'accepted', accepted_by_profile_id = v_actor, accepted_athlete_id = v_athlete_id,
    accepted_at = clock_timestamp()
  WHERE id = v_invitation.id;
  RETURN QUERY SELECT v_invitation.team_id, v_athlete_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_guardian_invitation(
  p_athlete_id uuid,
  p_invited_email text,
  p_token_hash text,
  p_expires_at timestamptz DEFAULT (CURRENT_TIMESTAMP + interval '7 days')
)
RETURNS TABLE(invitation_id uuid, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_actor_email text;
  v_actor_email_confirmed_at timestamptz;
  v_email text := lower(btrim(p_invited_email));
  v_existing public.guardian_invitations%ROWTYPE;
  v_invitation_id uuid := gen_random_uuid();
  v_constraint_name text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  -- Creation is authorized by the existing active guardian relationship, not
  -- by recipient-email disclosure. Do not make ordinary creation depend on
  -- a server assertion or an Auth-internal column.
  v_actor_email := NULL;
  IF p_athlete_id IS NULL OR NOT private.can_manage_guardian_invitation(p_athlete_id) THEN
    RAISE EXCEPTION 'Guardian invitation is not authorized' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.athletes AS athlete WHERE athlete.id = p_athlete_id AND athlete.status = 'active') THEN
    RAISE EXCEPTION 'Athlete is unavailable';
  END IF;
  IF v_email IS NULL OR v_email !~ E'^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'Invitation email is invalid';
  END IF;
  IF lower(btrim(v_actor_email)) = v_email THEN RAISE EXCEPTION 'Cannot invite your own email'; END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invitation token hash is invalid'; END IF;
  IF p_expires_at IS NULL OR p_expires_at <= CURRENT_TIMESTAMP OR p_expires_at > CURRENT_TIMESTAMP + interval '7 days' THEN
    RAISE EXCEPTION 'Invitation expiry must be within the next 7 days';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_athlete_id::text || ':' || v_email, 0));
  SELECT invitation.* INTO v_existing
  FROM public.guardian_invitations AS invitation
  WHERE invitation.athlete_id = p_athlete_id AND invitation.invited_email = v_email AND invitation.status = 'pending'
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.expires_at > clock_timestamp() THEN RAISE EXCEPTION 'An equivalent pending guardian invitation already exists'; END IF;
    UPDATE public.guardian_invitations SET status = 'expired' WHERE id = v_existing.id;
  END IF;
  BEGIN
    INSERT INTO public.guardian_invitations (id, athlete_id, invited_email, inviter_profile_id, token_hash, expires_at)
    VALUES (v_invitation_id, p_athlete_id, v_email, v_actor, p_token_hash, p_expires_at);
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name = 'guardian_invitations_token_hash_unique' THEN
      RAISE EXCEPTION 'Guardian invitation token is unavailable' USING ERRCODE = '23505';
    END IF;
    RAISE;
  END;
  RETURN QUERY SELECT v_invitation_id, p_expires_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_guardian_invitation_summary(p_invitation_token text)
RETURNS TABLE(athlete_display_name text, expires_at timestamptz, invitation_status public.team_invitation_status)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_email text;
  v_confirmed_at timestamptz;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF p_invitation_token IS NULL OR char_length(p_invitation_token) NOT BETWEEN 32 AND 256 OR p_invitation_token !~ '^[A-Za-z0-9_-]+$' THEN RETURN; END IF;
  v_email := private.server_verified_email();
  IF v_email IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT athlete.display_name, invitation.expires_at,
    CASE WHEN invitation.status = 'pending' AND invitation.expires_at <= clock_timestamp() THEN 'expired'::public.team_invitation_status ELSE invitation.status END
  FROM public.guardian_invitations AS invitation
  JOIN public.athletes AS athlete ON athlete.id = invitation.athlete_id
  WHERE invitation.token_hash = encode(extensions.digest(p_invitation_token, 'sha256'), 'hex')
    AND lower(btrim(v_email)) = invitation.invited_email
  LIMIT 1;
END;
$function$;

CREATE OR REPLACE FUNCTION public.accept_guardian_invitation(p_invitation_token text)
RETURNS TABLE(athlete_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_email text;
  v_confirmed_at timestamptz;
  v_invitation public.guardian_invitations%ROWTYPE;
  v_athlete public.athletes%ROWTYPE;
  v_inviter_relationship public.athlete_profile_relationships%ROWTYPE;
  v_recipient_relationship public.athlete_profile_relationships%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF p_invitation_token IS NULL OR char_length(p_invitation_token) NOT BETWEEN 32 AND 256 OR p_invitation_token !~ '^[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'Guardian invitation is invalid or unavailable';
  END IF;
  v_email := private.server_verified_email();
  IF v_email IS NULL THEN RAISE EXCEPTION 'Authenticated account must have a verified email'; END IF;
  SELECT invitation.* INTO v_invitation FROM public.guardian_invitations AS invitation
  WHERE invitation.token_hash = encode(extensions.digest(p_invitation_token, 'sha256'), 'hex') FOR UPDATE;
  IF NOT FOUND OR v_invitation.status <> 'pending' OR v_invitation.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Guardian invitation is no longer pending';
  END IF;
  IF lower(btrim(v_email)) <> v_invitation.invited_email THEN RAISE EXCEPTION 'Invitation email does not match the signed-in account'; END IF;
  -- Keep this order (invitation, athlete, inviter relationship, recipient advisory lock,
  -- recipient relationship) in every acceptance. FOR UPDATE conflicts with the ordinary
  -- status/permission and revocation updates that could otherwise race this decision.
  SELECT athlete.* INTO v_athlete
  FROM public.athletes AS athlete
  WHERE athlete.id = v_invitation.athlete_id
    AND athlete.status = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Athlete is unavailable';
  END IF;
  SELECT relationship.* INTO v_inviter_relationship
  FROM public.athlete_profile_relationships AS relationship
  WHERE relationship.athlete_id = v_invitation.athlete_id
    AND relationship.profile_id = v_invitation.inviter_profile_id
    AND relationship.role = 'guardian'
    AND relationship.revoked_at IS NULL
    AND relationship.manage_permission
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inviter no longer has guardian permission to share access';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_invitation.athlete_id::text || ':' || v_actor::text, 0));
  SELECT relationship.* INTO v_recipient_relationship
  FROM public.athlete_profile_relationships AS relationship
  WHERE relationship.athlete_id = v_invitation.athlete_id
    AND relationship.profile_id = v_actor
    AND relationship.revoked_at IS NULL
  ORDER BY CASE relationship.role WHEN 'self' THEN 0 ELSE 1 END
  FOR UPDATE;
  IF FOUND AND v_recipient_relationship.role = 'self' THEN
    RAISE EXCEPTION 'Guardian invitation cannot be accepted by the athlete self account';
  END IF;
  IF NOT FOUND THEN
    INSERT INTO public.athlete_profile_relationships (
      athlete_id, profile_id, role, training_permission, manage_permission, created_by_profile_id
    ) VALUES (v_invitation.athlete_id, v_actor, 'guardian', false, false, v_invitation.inviter_profile_id);
  END IF;
  UPDATE public.guardian_invitations
  SET status = 'accepted', accepted_by_profile_id = v_actor, accepted_at = clock_timestamp()
  WHERE id = v_invitation.id;
  RETURN QUERY SELECT v_invitation.athlete_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_child_login_invitation_summary(p_invitation_token text) RETURNS TABLE(athlete_display_name text,expires_at timestamptz,invitation_status public.team_invitation_status) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_actor uuid:=(SELECT auth.uid()); v_email text; v_confirmed timestamptz; BEGIN
 IF v_actor IS NULL OR p_invitation_token IS NULL OR char_length(p_invitation_token) NOT BETWEEN 32 AND 256 OR p_invitation_token !~ '^[A-Za-z0-9_-]+$' THEN RETURN; END IF;
 v_email := private.server_verified_email(); IF v_email IS NULL THEN RETURN; END IF;
 RETURN QUERY SELECT a.display_name,i.expires_at,CASE WHEN i.status='pending' AND i.expires_at<=private.child_login_now() THEN 'expired'::public.team_invitation_status ELSE i.status END FROM public.child_login_invitations i JOIN public.athletes a ON a.id=i.athlete_id WHERE i.token_hash=encode(extensions.digest(p_invitation_token,'sha256'),'hex') AND lower(btrim(v_email))=i.invited_email LIMIT 1; END; $function$;

CREATE OR REPLACE FUNCTION public.accept_child_login_invitation(p_invitation_token text)
RETURNS TABLE(athlete_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_candidate uuid;
  v_i public.child_login_invitations%ROWTYPE;
  v_email text;
  v_confirmed timestamptz;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  IF p_invitation_token IS NULL OR char_length(p_invitation_token) NOT BETWEEN 32 AND 256 OR p_invitation_token !~ '^[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'Child login invitation is unavailable';
  END IF;

  SELECT i.athlete_id INTO v_candidate
  FROM public.child_login_invitations AS i
  WHERE i.token_hash = encode(extensions.digest(p_invitation_token,'sha256'),'hex');
  IF v_candidate IS NULL THEN RAISE EXCEPTION 'Child login invitation is unavailable'; END IF;

  PERFORM private.child_login_claim_lock(v_candidate,v_actor);

  SELECT * INTO v_i
  FROM public.child_login_invitations AS i
  WHERE i.token_hash = encode(extensions.digest(p_invitation_token,'sha256'),'hex')
  FOR UPDATE;
  IF NOT FOUND OR v_i.athlete_id <> v_candidate THEN RAISE EXCEPTION 'Child login invitation is unavailable'; END IF;

  IF v_i.status = 'accepted' THEN
    IF v_i.accepted_by_profile_id = v_actor
       AND EXISTS (
         SELECT 1
         FROM public.athlete_profile_relationships AS r
         WHERE r.athlete_id = v_i.athlete_id
           AND r.profile_id = v_actor
           AND r.role = 'self'
           AND r.revoked_at IS NULL
           AND r.training_permission
           AND r.manage_permission
         FOR UPDATE
       ) THEN
      RETURN QUERY SELECT v_i.athlete_id;
      RETURN;
    END IF;
    RAISE EXCEPTION 'Child login invitation is unavailable';
  END IF;

  IF v_i.status <> 'pending' THEN RAISE EXCEPTION 'Child login invitation is unavailable'; END IF;
  IF v_i.expires_at <= private.child_login_now() THEN
    UPDATE public.child_login_invitations SET status = 'expired' WHERE id = v_i.id;
    RAISE EXCEPTION 'Child login invitation is unavailable';
  END IF;

  v_email := private.server_verified_email();
  IF v_email IS NULL
     OR lower(btrim(v_email)) <> v_i.invited_email
     OR NOT EXISTS (SELECT 1 FROM public.profiles AS p WHERE p.id = v_actor) THEN
    RAISE EXCEPTION 'Child login invitation is unavailable';
  END IF;

  PERFORM 1
  FROM public.athletes AS a
  WHERE a.id = v_i.athlete_id AND a.status = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Athlete is unavailable'; END IF;

  -- Lock both candidate roles before evaluating the original inviter under
  -- the same SELF-first, guardian-fallback rule used by current managers.
  PERFORM 1
  FROM public.athlete_profile_relationships AS r
  WHERE r.athlete_id = v_i.athlete_id
    AND r.profile_id = v_i.inviter_profile_id
    AND r.role IN ('self','guardian')
  ORDER BY CASE r.role WHEN 'self' THEN 0 ELSE 1 END
  FOR UPDATE;
  IF NOT private.can_manage_athlete_identity_for_profile(v_i.athlete_id,v_i.inviter_profile_id) THEN
    RAISE EXCEPTION 'Child login invitation is unavailable';
  END IF;

  PERFORM 1
  FROM public.athlete_profile_relationships AS r
  WHERE r.athlete_id = v_i.athlete_id AND r.role = 'self'
  FOR UPDATE;
  IF FOUND THEN RAISE EXCEPTION 'Child login claim conflict'; END IF;

  PERFORM 1
  FROM public.athlete_profile_relationships AS r
  WHERE r.profile_id = v_actor AND r.role = 'self' AND r.revoked_at IS NULL
  FOR UPDATE;
  IF FOUND THEN RAISE EXCEPTION 'Child login claim conflict'; END IF;

  BEGIN
    INSERT INTO public.athlete_profile_relationships(
      athlete_id,profile_id,role,training_permission,manage_permission,created_by_profile_id
    ) VALUES (v_i.athlete_id,v_actor,'self',true,true,v_i.inviter_profile_id);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Child login claim conflict';
  END;

  UPDATE public.child_login_invitations
  SET status = 'accepted',accepted_by_profile_id = v_actor,accepted_at = private.child_login_now()
  WHERE id = v_i.id;
  RETURN QUERY SELECT v_i.athlete_id;
END;
$function$;

CREATE FUNCTION public.server_accept_family_team_invitation(p_auth_user_id uuid,p_verified_email text,p_invitation_token text,p_existing_athlete_id uuid,p_first_name text,p_last_name text,p_graduation_year integer)
RETURNS TABLE(team_id uuid, athlete_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN PERFORM set_config('request.jwt.claim.sub',$1::text,true); PERFORM set_config('tilt.verified_email',lower(btrim($2)),true); RETURN QUERY SELECT * FROM public.accept_family_team_invitation($3,$4,$5,$6,$7); END $$;
CREATE FUNCTION public.server_accept_guardian_invitation(p_auth_user_id uuid,p_verified_email text,p_invitation_token text)
RETURNS TABLE(athlete_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN PERFORM set_config('request.jwt.claim.sub',$1::text,true); PERFORM set_config('tilt.verified_email',lower(btrim($2)),true); RETURN QUERY SELECT * FROM public.accept_guardian_invitation($3); END $$;
CREATE FUNCTION public.server_accept_child_login_invitation(p_auth_user_id uuid,p_verified_email text,p_invitation_token text)
RETURNS TABLE(athlete_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN PERFORM set_config('request.jwt.claim.sub',$1::text,true); PERFORM set_config('tilt.verified_email',lower(btrim($2)),true); RETURN QUERY SELECT * FROM public.accept_child_login_invitation($3); END $$;
CREATE FUNCTION public.server_get_guardian_invitation_summary(p_auth_user_id uuid,p_verified_email text,p_invitation_token text)
RETURNS TABLE(athlete_display_name text,expires_at timestamptz,invitation_status public.team_invitation_status) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN PERFORM set_config('request.jwt.claim.sub',$1::text,true); PERFORM set_config('tilt.verified_email',lower(btrim($2)),true); RETURN QUERY SELECT * FROM public.get_guardian_invitation_summary($3); END $$;
CREATE FUNCTION public.server_get_child_login_invitation_summary(p_auth_user_id uuid,p_verified_email text,p_invitation_token text)
RETURNS TABLE(athlete_display_name text,expires_at timestamptz,invitation_status public.team_invitation_status) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN PERFORM set_config('request.jwt.claim.sub',$1::text,true); PERFORM set_config('tilt.verified_email',lower(btrim($2)),true); RETURN QUERY SELECT * FROM public.get_child_login_invitation_summary($3); END $$;

REVOKE ALL ON FUNCTION public.accept_family_team_invitation(text,uuid,text,text,integer), public.create_guardian_invitation(uuid,text,text,timestamptz), public.get_guardian_invitation_summary(text), public.accept_guardian_invitation(text), public.get_child_login_invitation_summary(text), public.accept_child_login_invitation(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_guardian_invitation(uuid,text,text,timestamptz) TO authenticated;
REVOKE ALL ON FUNCTION public.server_accept_family_team_invitation(uuid,text,text,uuid,text,text,integer), public.server_accept_guardian_invitation(uuid,text,text), public.server_accept_child_login_invitation(uuid,text,text), public.server_get_guardian_invitation_summary(uuid,text,text), public.server_get_child_login_invitation_summary(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.server_accept_family_team_invitation(uuid,text,text,uuid,text,text,integer), public.server_accept_guardian_invitation(uuid,text,text), public.server_accept_child_login_invitation(uuid,text,text), public.server_get_guardian_invitation_summary(uuid,text,text), public.server_get_child_login_invitation_summary(uuid,text,text) TO service_role;
COMMIT;
