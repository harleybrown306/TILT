BEGIN;

-- Replacement is one transaction: if minting the new record fails, the old
-- bearer link remains valid. The new raw token stays application-local and
-- only its hash reaches the database.
CREATE FUNCTION public.replace_assistant_coach_invitation(
  p_invitation_id uuid,
  p_invited_email text,
  p_token_hash text,
  p_expires_at timestamptz
)
RETURNS TABLE(invitation_id uuid, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_old public.team_invitations%ROWTYPE;
  v_email text := lower(btrim(p_invited_email));
  v_actor_email text;
  v_invitation_id uuid := gen_random_uuid();
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT lower(btrim(user_record.email)) INTO v_actor_email FROM auth.users AS user_record WHERE user_record.id = v_actor;
  IF p_invitation_id IS NULL OR v_email IS NULL OR v_email !~ E'^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$' THEN RAISE EXCEPTION 'Invitation email is invalid'; END IF;
  IF v_actor_email IS NULL OR v_actor_email = v_email THEN RAISE EXCEPTION 'Use another email address'; END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invitation token hash is invalid'; END IF;
  IF p_expires_at IS NULL OR p_expires_at <= clock_timestamp() OR p_expires_at > clock_timestamp() + interval '7 days' THEN RAISE EXCEPTION 'Invitation expiry must be within the next 7 days'; END IF;
  SELECT invitation.* INTO v_old FROM public.team_invitations AS invitation WHERE invitation.id = p_invitation_id FOR UPDATE;
  IF NOT FOUND OR v_old.status <> 'pending' OR v_old.role <> 'assistant_coach' THEN RAISE EXCEPTION 'Only pending assistant coach invitations can be replaced'; END IF;
  IF NOT private.can_manage_team(v_old.team_id) THEN RAISE EXCEPTION 'Invitation replacement is not authorized' USING ERRCODE = '42501'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_old.team_id::text || ':' || v_email || ':assistant_coach', 0));
  UPDATE public.team_invitations SET status = 'revoked', revoked_at = clock_timestamp() WHERE id = v_old.id;
  INSERT INTO public.team_invitations (id, team_id, invited_email, role, invited_by_user_id, token_hash, status, expires_at)
  VALUES (v_invitation_id, v_old.team_id, v_email, 'assistant_coach', v_actor, p_token_hash, 'pending', p_expires_at);
  RETURN QUERY SELECT v_invitation_id, p_expires_at;
END;
$function$;

CREATE FUNCTION public.replace_family_team_invitation(
  p_invitation_id uuid,
  p_invited_email text,
  p_token_hash text,
  p_expires_at timestamptz
)
RETURNS TABLE(invitation_id uuid, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF p_invitation_id IS NULL THEN RAISE EXCEPTION 'Family invitation is unavailable'; END IF;
  PERFORM public.revoke_family_team_invitation(p_invitation_id);
  RETURN QUERY SELECT * FROM public.create_family_team_invitation(
    (SELECT team_id FROM public.family_team_invitations WHERE id = p_invitation_id),
    p_invited_email, p_token_hash, p_expires_at
  );
END;
$function$;

CREATE FUNCTION public.replace_guardian_invitation(
  p_invitation_id uuid,
  p_invited_email text,
  p_token_hash text,
  p_expires_at timestamptz
)
RETURNS TABLE(invitation_id uuid, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF p_invitation_id IS NULL THEN RAISE EXCEPTION 'Guardian invitation is unavailable'; END IF;
  PERFORM public.revoke_guardian_invitation(p_invitation_id);
  RETURN QUERY SELECT * FROM public.create_guardian_invitation(
    (SELECT athlete_id FROM public.guardian_invitations WHERE id = p_invitation_id),
    p_invited_email, p_token_hash, p_expires_at
  );
END;
$function$;

CREATE FUNCTION public.replace_child_login_invitation(
  p_invitation_id uuid,
  p_invited_email text,
  p_token_hash text
)
RETURNS TABLE(invitation_id uuid, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF p_invitation_id IS NULL THEN RAISE EXCEPTION 'Child login invitation is unavailable'; END IF;
  PERFORM public.revoke_child_login_invitation(p_invitation_id);
  RETURN QUERY SELECT * FROM public.create_child_login_invitation(
    (SELECT athlete_id FROM public.child_login_invitations WHERE id = p_invitation_id),
    p_invited_email, p_token_hash
  );
END;
$function$;

ALTER FUNCTION public.replace_assistant_coach_invitation(uuid, text, text, timestamptz) OWNER TO postgres;
ALTER FUNCTION public.replace_family_team_invitation(uuid, text, text, timestamptz) OWNER TO postgres;
ALTER FUNCTION public.replace_guardian_invitation(uuid, text, text, timestamptz) OWNER TO postgres;
ALTER FUNCTION public.replace_child_login_invitation(uuid, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.replace_assistant_coach_invitation(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.replace_family_team_invitation(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.replace_guardian_invitation(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.replace_child_login_invitation(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_assistant_coach_invitation(uuid, text, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.replace_family_team_invitation(uuid, text, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.replace_guardian_invitation(uuid, text, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.replace_child_login_invitation(uuid, text, text) TO authenticated;

COMMIT;
