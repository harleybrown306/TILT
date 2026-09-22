-- Correct only the email-regex literalization in the existing invitation creator.
-- E'\\.' is parsed by PostgreSQL as the regex token '\.' (literal dot).
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
  IF v_email IS NULL OR v_email !~ E'^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$' THEN
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
