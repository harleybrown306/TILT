BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.create_guardian_invitation(uuid,text,text,timestamp with time zone)') IS NULL THEN
    RAISE EXCEPTION 'Expected predecessor function is missing: public.create_guardian_invitation(uuid,text,text,timestamp with time zone)';
  END IF;
END;
$$;

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
  v_email text := lower(btrim(p_invited_email));
  v_existing public.guardian_invitations%ROWTYPE;
  v_invitation_id uuid := gen_random_uuid();
  v_constraint_name text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  -- Creation keeps its authenticated guardian-relationship boundary. The
  -- current actor email comes from the database-owned Auth record, never a
  -- browser argument or user metadata; confirmation is enforced upstream.
  SELECT lower(btrim(user_record.email)) INTO v_actor_email
  FROM auth.users AS user_record
  WHERE user_record.id = v_actor;
  IF v_actor_email IS NULL OR v_actor_email = '' THEN
    RAISE EXCEPTION 'Authenticated account must have an email';
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
  IF v_actor_email = v_email THEN RAISE EXCEPTION 'Cannot invite your own email'; END IF;
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

COMMIT;
