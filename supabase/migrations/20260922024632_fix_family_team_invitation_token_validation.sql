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
  IF p_invitation_token IS NULL
     OR char_length(p_invitation_token) NOT BETWEEN 32 AND 256
     OR p_invitation_token !~ '^[A-Za-z0-9_-]+$' THEN
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
  IF p_invitation_token IS NULL
     OR char_length(p_invitation_token) NOT BETWEEN 32 AND 256
     OR p_invitation_token !~ '^[A-Za-z0-9_-]+$' THEN
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
