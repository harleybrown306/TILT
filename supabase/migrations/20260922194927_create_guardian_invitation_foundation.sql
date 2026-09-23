BEGIN;

-- Phase 13D.5A: an account-to-athlete permission grant, separate from team enrollment.
CREATE TABLE public.guardian_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id uuid NOT NULL REFERENCES public.athletes(id) ON DELETE RESTRICT,
  invited_email text NOT NULL,
  inviter_profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  token_hash text NOT NULL CONSTRAINT guardian_invitations_token_hash_unique UNIQUE,
  status public.team_invitation_status NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '7 days'),
  accepted_by_profile_id uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  accepted_at timestamptz,
  revoked_by_profile_id uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT guardian_invitations_email_normalized CHECK (
    invited_email = lower(btrim(invited_email))
    AND invited_email ~ E'^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'
  ),
  CONSTRAINT guardian_invitations_token_hash_sha256 CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT guardian_invitations_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT guardian_invitations_lifecycle_consistent CHECK (
    (status = 'pending' AND accepted_by_profile_id IS NULL AND accepted_at IS NULL
      AND revoked_by_profile_id IS NULL AND revoked_at IS NULL)
    OR (status = 'accepted' AND accepted_by_profile_id IS NOT NULL AND accepted_at IS NOT NULL
      AND revoked_by_profile_id IS NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND accepted_by_profile_id IS NULL AND accepted_at IS NULL
      AND revoked_by_profile_id IS NOT NULL AND revoked_at IS NOT NULL)
    OR (status = 'expired' AND accepted_by_profile_id IS NULL AND accepted_at IS NULL
      AND revoked_by_profile_id IS NULL AND revoked_at IS NULL)
  )
);

CREATE UNIQUE INDEX guardian_invitations_one_pending_per_email
  ON public.guardian_invitations (athlete_id, invited_email)
  WHERE status = 'pending';
CREATE INDEX guardian_invitations_athlete_id_idx ON public.guardian_invitations(athlete_id);
CREATE INDEX guardian_invitations_inviter_idx ON public.guardian_invitations(inviter_profile_id);
CREATE INDEX guardian_invitations_expires_at_idx
  ON public.guardian_invitations(expires_at) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION private.can_manage_guardian_invitation(
  p_athlete_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.athlete_profile_relationships AS relationship
    WHERE relationship.athlete_id = p_athlete_id
      AND relationship.profile_id = (SELECT auth.uid())
      AND relationship.role = 'guardian'
      AND relationship.revoked_at IS NULL
      AND relationship.manage_permission
  );
$function$;
REVOKE ALL ON FUNCTION private.can_manage_guardian_invitation(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.validate_guardian_invitation_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NEW.athlete_id <> OLD.athlete_id
     OR NEW.invited_email <> OLD.invited_email
     OR NEW.inviter_profile_id <> OLD.inviter_profile_id
     OR NEW.token_hash <> OLD.token_hash
     OR NEW.created_at <> OLD.created_at
     OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'Guardian invitation identity fields cannot be changed';
  END IF;
  IF OLD.status <> 'pending' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'Completed guardian invitations cannot change status';
  END IF;
  IF OLD.status = 'accepted' AND (
    NEW.accepted_by_profile_id IS DISTINCT FROM OLD.accepted_by_profile_id
    OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
  ) THEN RAISE EXCEPTION 'Accepted guardian invitation audit fields cannot be changed'; END IF;
  IF OLD.status = 'revoked' AND (
    NEW.revoked_by_profile_id IS DISTINCT FROM OLD.revoked_by_profile_id
    OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
  ) THEN RAISE EXCEPTION 'Revoked guardian invitation audit fields cannot be changed'; END IF;
  IF OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'accepted', 'revoked', 'expired') THEN
    RAISE EXCEPTION 'Guardian invitation lifecycle is invalid';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.validate_guardian_invitation_update() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER guardian_invitations_validate_update
BEFORE UPDATE ON public.guardian_invitations
FOR EACH ROW EXECUTE FUNCTION private.validate_guardian_invitation_update();

ALTER TABLE public.guardian_invitations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.guardian_invitations FROM PUBLIC, anon, authenticated;

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
  SELECT user_record.email, user_record.email_confirmed_at
  INTO v_actor_email, v_actor_email_confirmed_at
  FROM auth.users AS user_record WHERE user_record.id = v_actor;
  IF v_actor_email IS NULL OR v_actor_email_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'Authenticated account must have a verified email';
  END IF;
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
  SELECT user_record.email, user_record.email_confirmed_at INTO v_email, v_confirmed_at FROM auth.users AS user_record WHERE user_record.id = v_actor;
  IF v_email IS NULL OR v_confirmed_at IS NULL THEN RETURN; END IF;
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
  SELECT user_record.email, user_record.email_confirmed_at INTO v_email, v_confirmed_at FROM auth.users AS user_record WHERE user_record.id = v_actor;
  IF v_email IS NULL OR v_confirmed_at IS NULL THEN RAISE EXCEPTION 'Authenticated account must have a verified email'; END IF;
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

CREATE OR REPLACE FUNCTION public.revoke_guardian_invitation(p_invitation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_invitation public.guardian_invitations%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT invitation.* INTO v_invitation FROM public.guardian_invitations AS invitation WHERE invitation.id = p_invitation_id FOR UPDATE;
  IF NOT FOUND OR v_invitation.status <> 'pending' THEN RAISE EXCEPTION 'Only pending guardian invitations can be revoked'; END IF;
  IF NOT private.can_manage_guardian_invitation(v_invitation.athlete_id) THEN RAISE EXCEPTION 'Guardian invitation revocation is not authorized' USING ERRCODE = '42501'; END IF;
  UPDATE public.guardian_invitations SET status = 'revoked', revoked_by_profile_id = v_actor, revoked_at = clock_timestamp() WHERE id = v_invitation.id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.list_my_guardian_invitations(p_athlete_id uuid)
RETURNS TABLE(invitation_id uuid, invited_email text, invitation_status public.team_invitation_status, expires_at timestamptz, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT invitation.id, invitation.invited_email,
    CASE WHEN invitation.status = 'pending' AND invitation.expires_at <= clock_timestamp() THEN 'expired'::public.team_invitation_status ELSE invitation.status END,
    invitation.expires_at, invitation.created_at
  FROM public.guardian_invitations AS invitation
  WHERE invitation.athlete_id = p_athlete_id AND private.can_manage_guardian_invitation(p_athlete_id)
  ORDER BY invitation.created_at, invitation.id;
$function$;

ALTER FUNCTION public.create_guardian_invitation(uuid, text, text, timestamptz) OWNER TO postgres;
ALTER FUNCTION public.get_guardian_invitation_summary(text) OWNER TO postgres;
ALTER FUNCTION public.accept_guardian_invitation(text) OWNER TO postgres;
ALTER FUNCTION public.revoke_guardian_invitation(uuid) OWNER TO postgres;
ALTER FUNCTION public.list_my_guardian_invitations(uuid) OWNER TO postgres;
ALTER FUNCTION private.can_manage_guardian_invitation(uuid) OWNER TO postgres;
ALTER FUNCTION private.validate_guardian_invitation_update() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_guardian_invitation(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_guardian_invitation_summary(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.accept_guardian_invitation(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_guardian_invitation(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_my_guardian_invitations(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_guardian_invitation(uuid, text, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_guardian_invitation_summary(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_guardian_invitation(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_guardian_invitation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_my_guardian_invitations(uuid) TO authenticated;

COMMENT ON TABLE public.guardian_invitations IS 'Auditable bearer-token invitations that grant a fixed VIEW-only guardian relationship to an existing durable athlete.';
COMMENT ON FUNCTION public.accept_guardian_invitation(text) IS 'Accepts an email-bound guardian invitation and creates at most a fixed VIEW-only guardian relationship; existing active guardian permissions are never changed.';

COMMIT;
