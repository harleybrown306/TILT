BEGIN;

CREATE FUNCTION private.can_manage_athlete_identity_for_profile(
  p_athlete_id uuid,
  p_profile_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT coalesce(
    (
      SELECT relationship.manage_permission
      FROM public.athlete_profile_relationships AS relationship
      WHERE relationship.athlete_id = p_athlete_id
        AND relationship.profile_id = p_profile_id
        AND relationship.role = 'self'
        AND relationship.revoked_at IS NULL
    ),
    (
      SELECT relationship.manage_permission
      FROM public.athlete_profile_relationships AS relationship
      WHERE relationship.athlete_id = p_athlete_id
        AND relationship.profile_id = p_profile_id
        AND relationship.role = 'guardian'
        AND relationship.revoked_at IS NULL
    ),
    false
  );
$function$;

REVOKE ALL ON FUNCTION private.can_manage_athlete_identity_for_profile(uuid,uuid) FROM PUBLIC, anon, authenticated;

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

  SELECT u.email,u.email_confirmed_at INTO v_email,v_confirmed
  FROM auth.users AS u
  WHERE u.id = v_actor;
  IF v_email IS NULL OR v_confirmed IS NULL
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

REVOKE ALL ON FUNCTION public.get_child_login_invitation_summary(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.accept_child_login_invitation(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_child_login_invitation_summary(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_child_login_invitation(text) TO authenticated;

COMMIT;
