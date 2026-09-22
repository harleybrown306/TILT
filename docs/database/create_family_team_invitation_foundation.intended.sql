BEGIN;

CREATE TABLE public.family_team_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  invited_email text NOT NULL,
  invited_by_profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE,
  status public.team_invitation_status NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_by_profile_id uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  accepted_athlete_id uuid REFERENCES public.athletes(id) ON DELETE RESTRICT,
  accepted_at timestamptz,
  revoked_by_profile_id uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT family_team_invitations_email_normalized CHECK (
    invited_email = lower(btrim(invited_email))
    AND invited_email ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'
  ),
  CONSTRAINT family_team_invitations_token_hash_sha256 CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT family_team_invitations_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT family_team_invitations_lifecycle_consistent CHECK (
    (status = 'pending' AND accepted_by_profile_id IS NULL AND accepted_athlete_id IS NULL
      AND accepted_at IS NULL AND revoked_by_profile_id IS NULL AND revoked_at IS NULL)
    OR (status = 'accepted' AND accepted_by_profile_id IS NOT NULL AND accepted_athlete_id IS NOT NULL
      AND accepted_at IS NOT NULL AND revoked_by_profile_id IS NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND accepted_by_profile_id IS NULL AND accepted_athlete_id IS NULL
      AND accepted_at IS NULL AND revoked_by_profile_id IS NOT NULL AND revoked_at IS NOT NULL)
    OR (status = 'expired' AND accepted_by_profile_id IS NULL AND accepted_athlete_id IS NULL
      AND accepted_at IS NULL AND revoked_by_profile_id IS NULL AND revoked_at IS NULL)
  )
);

CREATE UNIQUE INDEX family_team_invitations_one_pending_per_email
  ON public.family_team_invitations (team_id, invited_email)
  WHERE status = 'pending';
CREATE INDEX family_team_invitations_team_id_idx ON public.family_team_invitations(team_id);
CREATE INDEX family_team_invitations_invited_by_idx ON public.family_team_invitations(invited_by_profile_id);
CREATE INDEX family_team_invitations_expires_at_idx
  ON public.family_team_invitations(expires_at) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION private.validate_family_team_invitation_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NEW.team_id <> OLD.team_id
     OR NEW.invited_email <> OLD.invited_email
     OR NEW.invited_by_profile_id <> OLD.invited_by_profile_id
     OR NEW.token_hash <> OLD.token_hash
     OR NEW.created_at <> OLD.created_at
     OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'Family invitation identity fields cannot be changed';
  END IF;

  IF OLD.status <> 'pending' OR NEW.status NOT IN ('pending', 'accepted', 'revoked', 'expired') THEN
    IF NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'Completed invitations cannot change status';
    END IF;
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.validate_family_team_invitation_update() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER family_team_invitations_validate_update
BEFORE UPDATE ON public.family_team_invitations
FOR EACH ROW EXECUTE FUNCTION private.validate_family_team_invitation_update();

ALTER TABLE public.family_team_invitations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.family_team_invitations FROM PUBLIC, anon, authenticated;
-- Managers may read the operational metadata needed to manage an invitation,
-- but a bearer-token verifier must never be queryable through the Data API.
GRANT SELECT (
  id, team_id, invited_email, invited_by_profile_id, status, expires_at,
  accepted_by_profile_id, accepted_athlete_id, accepted_at,
  revoked_by_profile_id, revoked_at, created_at, updated_at
) ON public.family_team_invitations TO authenticated;

CREATE POLICY family_team_invitations_select_roster_manager
ON public.family_team_invitations FOR SELECT TO authenticated
USING (private.can_manage_roster(team_id, (SELECT auth.uid())));

-- Canonical structured-athlete constructor.  This is deliberately private:
-- public callers retain the existing create_my_athlete contract, while every
-- internal path that creates a guardian-managed no-login child shares one
-- validation and write implementation.
CREATE OR REPLACE FUNCTION private.create_guardian_managed_athlete(
  p_profile_id uuid,
  p_first_name text,
  p_last_name text,
  p_graduation_year integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_athlete_id uuid := gen_random_uuid();
  v_first_name text := nullif(btrim(p_first_name), '');
  v_last_name text := nullif(btrim(p_last_name), '');
  v_display_name text;
BEGIN
  IF p_profile_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF v_first_name IS NULL THEN
    RAISE EXCEPTION 'Athlete first name is required';
  END IF;
  IF v_last_name IS NULL THEN
    RAISE EXCEPTION 'Athlete last name is required';
  END IF;
  IF p_graduation_year IS NULL OR p_graduation_year NOT BETWEEN 2000 AND 2100 THEN
    RAISE EXCEPTION 'Graduation year must be between 2000 and 2100';
  END IF;
  v_display_name := v_first_name || ' ' || v_last_name;
  IF char_length(v_display_name) > 200 THEN
    RAISE EXCEPTION 'Athlete name must be at most 200 characters';
  END IF;
  INSERT INTO public.athletes (
    id, first_name, last_name, display_name, graduation_year, created_by_profile_id
  ) VALUES (
    v_athlete_id, v_first_name, v_last_name, v_display_name, p_graduation_year, p_profile_id
  );
  INSERT INTO public.athlete_profile_relationships (
    athlete_id, profile_id, role, training_permission, manage_permission, created_by_profile_id
  ) VALUES (
    v_athlete_id, p_profile_id, 'guardian', true, true, p_profile_id
  );
  RETURN v_athlete_id;
END;
$function$;

ALTER FUNCTION private.create_guardian_managed_athlete(uuid, text, text, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.create_guardian_managed_athlete(uuid, text, text, integer)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_my_athlete(
  p_first_name text,
  p_last_name text,
  p_graduation_year integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_profile_id uuid := (SELECT auth.uid());
BEGIN
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  RETURN private.create_guardian_managed_athlete(
    v_profile_id, p_first_name, p_last_name, p_graduation_year
  );
END;
$function$;

ALTER FUNCTION public.create_my_athlete(text, text, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_my_athlete(text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_my_athlete(text, text, integer)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.create_family_team_invitation(
  p_team_id uuid,
  p_invited_email text,
  p_token_hash text,
  p_expires_at timestamptz DEFAULT (clock_timestamp() + interval '7 days')
)
RETURNS TABLE(invitation_id uuid, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_email text := lower(btrim(p_invited_email));
  v_existing public.family_team_invitations%ROWTYPE;
  v_invitation_id uuid := gen_random_uuid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_team_id IS NULL OR NOT private.can_manage_roster(p_team_id, v_actor) THEN
    RAISE EXCEPTION 'Family invitation is not authorized' USING ERRCODE = '42501';
  END IF;
  IF v_email IS NULL OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'Invitation email is invalid';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Invitation token hash is invalid';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Invitation expiry must be in the future';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_team_id::text || ':' || v_email, 0)
  );
  SELECT invitation.* INTO v_existing
  FROM public.family_team_invitations AS invitation
  WHERE invitation.team_id = p_team_id
    AND invitation.invited_email = v_email
    AND invitation.status = 'pending'
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.expires_at > clock_timestamp() THEN
      RAISE EXCEPTION 'An equivalent pending family invitation already exists';
    END IF;
    UPDATE public.family_team_invitations
    SET status = 'expired'
    WHERE id = v_existing.id;
  END IF;

  INSERT INTO public.family_team_invitations (
    id, team_id, invited_email, invited_by_profile_id, token_hash, expires_at
  ) VALUES (
    v_invitation_id, p_team_id, v_email, v_actor, p_token_hash, p_expires_at
  );
  RETURN QUERY SELECT v_invitation_id, p_expires_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_family_team_invitation(p_invitation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_invitation public.family_team_invitations%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT invitation.* INTO v_invitation
  FROM public.family_team_invitations AS invitation
  WHERE invitation.id = p_invitation_id
  FOR UPDATE;
  IF NOT FOUND OR v_invitation.status <> 'pending' THEN
    RAISE EXCEPTION 'Only pending family invitations can be revoked';
  END IF;
  IF NOT private.can_manage_roster(v_invitation.team_id, v_actor) THEN
    RAISE EXCEPTION 'Family invitation revocation is not authorized' USING ERRCODE = '42501';
  END IF;
  UPDATE public.family_team_invitations
  SET status = 'revoked', revoked_by_profile_id = v_actor, revoked_at = clock_timestamp()
  WHERE id = v_invitation.id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_family_team_invitation_summary(p_invitation_token text)
RETURNS TABLE(team_name text, expires_at timestamptz, invitation_status public.team_invitation_status)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_invitation_token IS NULL OR p_invitation_token !~ '^[A-Za-z0-9_-]{32,256}$' THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT team.name, invitation.expires_at,
    CASE WHEN invitation.status = 'pending' AND invitation.expires_at <= clock_timestamp()
      THEN 'expired'::public.team_invitation_status ELSE invitation.status END
  FROM public.family_team_invitations AS invitation
  JOIN public.teams AS team ON team.id = invitation.team_id
  WHERE invitation.token_hash = encode(extensions.digest(p_invitation_token, 'sha256'), 'hex')
  LIMIT 1;
END;
$function$;

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
  IF p_invitation_token IS NULL OR p_invitation_token !~ '^[A-Za-z0-9_-]{32,256}$' THEN
    RAISE EXCEPTION 'Family invitation is invalid or unavailable';
  END IF;
  IF (p_existing_athlete_id IS NULL) = (p_first_name IS NULL AND p_last_name IS NULL AND p_graduation_year IS NULL) THEN
    RAISE EXCEPTION 'Choose an existing athlete or provide new child details';
  END IF;

  SELECT user_record.email, user_record.email_confirmed_at INTO v_email, v_email_confirmed_at
  FROM auth.users AS user_record WHERE user_record.id = v_actor;
  IF v_email IS NULL OR v_email_confirmed_at IS NULL THEN
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

ALTER FUNCTION public.create_family_team_invitation(uuid, text, text, timestamptz) OWNER TO postgres;
ALTER FUNCTION public.revoke_family_team_invitation(uuid) OWNER TO postgres;
ALTER FUNCTION public.get_family_team_invitation_summary(text) OWNER TO postgres;
ALTER FUNCTION public.accept_family_team_invitation(text, uuid, text, text, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_family_team_invitation(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_family_team_invitation(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_family_team_invitation_summary(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.accept_family_team_invitation(text, uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_family_team_invitation(uuid, text, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_family_team_invitation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_family_team_invitation_summary(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_family_team_invitation(text, uuid, text, text, integer) TO authenticated;

COMMENT ON TABLE public.family_team_invitations IS
  'Family-email team enrollment invitations. They acquire an athlete only on atomic acceptance.';
COMMENT ON FUNCTION public.accept_family_team_invitation(text, uuid, text, text, integer) IS
  'Atomically enrolls a manageable existing athlete or creates a guardian-managed no-login child and durable roster membership.';

COMMIT;
