BEGIN;

-- Compatibility phase: leave the legacy browser RPCs completely unchanged.
-- The new server-only read path is deployed and validated before the follow-up
-- migration removes legacy authenticated access.
DO $preflight$
BEGIN
  IF to_regprocedure('public.get_team_invitation_summary(text)') IS NULL THEN
    RAISE EXCEPTION 'Expected predecessor function is missing: public.get_team_invitation_summary(text)';
  END IF;
  IF to_regprocedure('public.get_family_team_invitation_summary(text)') IS NULL THEN
    RAISE EXCEPTION 'Expected predecessor function is missing: public.get_family_team_invitation_summary(text)';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_team_invitation_summary(text)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_family_team_invitation_summary(text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'Expected predecessor authenticated summary grants are missing';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc AS procedure
    WHERE procedure.oid IN (
      'public.get_team_invitation_summary(text)'::regprocedure,
      'public.get_family_team_invitation_summary(text)'::regprocedure
    )
      AND (
        NOT procedure.prosecdef
        OR NOT (coalesce(procedure.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=""']::text[])
        OR pg_get_userbyid(procedure.proowner) <> 'postgres'
      )
  ) THEN
    RAISE EXCEPTION 'Expected predecessor summary security contract does not match';
  END IF;
  IF to_regprocedure('public.server_get_team_invitation_summary(uuid,text,text)') IS NOT NULL
     OR to_regprocedure('public.server_get_family_team_invitation_summary(uuid,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'Server invitation summary wrapper already exists';
  END IF;
END;
$preflight$;

-- These wrappers independently bind the requested email to a confirmed auth
-- user. They deliberately do not call or replace the legacy summary RPCs.
CREATE FUNCTION public.server_get_team_invitation_summary(
  p_auth_user_id uuid,
  p_verified_email text,
  p_invitation_token text
)
RETURNS TABLE(team_name text, invitation_role public.team_member_role, expires_at timestamptz, invitation_status public.team_invitation_status)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_verified_email text;
BEGIN
  IF p_auth_user_id IS NULL
     OR p_verified_email IS NULL
     OR lower(btrim(p_verified_email)) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR p_invitation_token IS NULL
     OR char_length(p_invitation_token) NOT BETWEEN 32 AND 256
     OR p_invitation_token !~ '^[A-Za-z0-9_-]+$' THEN
    RETURN;
  END IF;

  SELECT lower(btrim(user_record.email))
  INTO v_verified_email
  FROM auth.users AS user_record
  WHERE user_record.id = p_auth_user_id
    AND user_record.email_confirmed_at IS NOT NULL;

  IF v_verified_email IS NULL OR v_verified_email <> lower(btrim(p_verified_email)) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT team.name, invitation.role, invitation.expires_at,
    CASE WHEN invitation.status = 'pending' AND invitation.expires_at <= now()
      THEN 'expired'::public.team_invitation_status ELSE invitation.status END
  FROM public.team_invitations AS invitation
  JOIN public.teams AS team ON team.id = invitation.team_id
  WHERE invitation.token_hash = encode(extensions.digest(p_invitation_token, 'sha256'), 'hex')
    AND lower(btrim(invitation.invited_email)) = v_verified_email
  LIMIT 1;
END;
$function$;

CREATE FUNCTION public.server_get_family_team_invitation_summary(
  p_auth_user_id uuid,
  p_verified_email text,
  p_invitation_token text
)
RETURNS TABLE(team_name text, expires_at timestamptz, invitation_status public.team_invitation_status)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_verified_email text;
BEGIN
  IF p_auth_user_id IS NULL
     OR p_verified_email IS NULL
     OR lower(btrim(p_verified_email)) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR p_invitation_token IS NULL
     OR char_length(p_invitation_token) NOT BETWEEN 32 AND 256
     OR p_invitation_token !~ '^[A-Za-z0-9_-]+$' THEN
    RETURN;
  END IF;

  SELECT lower(btrim(user_record.email))
  INTO v_verified_email
  FROM auth.users AS user_record
  WHERE user_record.id = p_auth_user_id
    AND user_record.email_confirmed_at IS NOT NULL;

  IF v_verified_email IS NULL OR v_verified_email <> lower(btrim(p_verified_email)) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT team.name, invitation.expires_at,
    CASE WHEN invitation.status = 'pending' AND invitation.expires_at <= clock_timestamp()
      THEN 'expired'::public.team_invitation_status ELSE invitation.status END
  FROM public.family_team_invitations AS invitation
  JOIN public.teams AS team ON team.id = invitation.team_id
  WHERE invitation.token_hash = encode(extensions.digest(p_invitation_token, 'sha256'), 'hex')
    AND lower(btrim(invitation.invited_email)) = v_verified_email
  LIMIT 1;
END;
$function$;

ALTER FUNCTION public.server_get_team_invitation_summary(uuid, text, text) OWNER TO postgres;
ALTER FUNCTION public.server_get_family_team_invitation_summary(uuid, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.server_get_team_invitation_summary(uuid, text, text), public.server_get_family_team_invitation_summary(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.server_get_team_invitation_summary(uuid, text, text), public.server_get_family_team_invitation_summary(uuid, text, text)
  TO service_role;

COMMIT;
