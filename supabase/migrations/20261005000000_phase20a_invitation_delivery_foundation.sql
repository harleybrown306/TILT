BEGIN;

-- No bearer token, provider response, or provider identifier is ever retained.
ALTER TABLE public.team_invitations ADD COLUMN delivery_attempt_count integer NOT NULL DEFAULT 0 CHECK (delivery_attempt_count >= 0), ADD COLUMN last_delivery_attempt_at timestamptz, ADD COLUMN last_delivery_accepted_at timestamptz, ADD COLUMN delivery_attempt_timestamps timestamptz[] NOT NULL DEFAULT ARRAY[]::timestamptz[];
ALTER TABLE public.family_team_invitations ADD COLUMN delivery_attempt_count integer NOT NULL DEFAULT 0 CHECK (delivery_attempt_count >= 0), ADD COLUMN last_delivery_attempt_at timestamptz, ADD COLUMN last_delivery_accepted_at timestamptz, ADD COLUMN delivery_attempt_timestamps timestamptz[] NOT NULL DEFAULT ARRAY[]::timestamptz[];
ALTER TABLE public.guardian_invitations ADD COLUMN delivery_attempt_count integer NOT NULL DEFAULT 0 CHECK (delivery_attempt_count >= 0), ADD COLUMN last_delivery_attempt_at timestamptz, ADD COLUMN last_delivery_accepted_at timestamptz, ADD COLUMN delivery_attempt_timestamps timestamptz[] NOT NULL DEFAULT ARRAY[]::timestamptz[];
ALTER TABLE public.child_login_invitations ADD COLUMN delivery_attempt_count integer NOT NULL DEFAULT 0 CHECK (delivery_attempt_count >= 0), ADD COLUMN last_delivery_attempt_at timestamptz, ADD COLUMN last_delivery_accepted_at timestamptz, ADD COLUMN delivery_attempt_timestamps timestamptz[] NOT NULL DEFAULT ARRAY[]::timestamptz[];

-- The timestamp arrays are the minimum durable state for true rolling windows;
-- a lifetime counter alone cannot enforce a rolling-day or actor-wide cap.
CREATE TABLE public.invitation_delivery_actor_rate_state (
  profile_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE RESTRICT,
  delivery_attempt_timestamps timestamptz[] NOT NULL DEFAULT ARRAY[]::timestamptz[]
);
ALTER TABLE public.invitation_delivery_actor_rate_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invitation_delivery_actor_rate_state FROM PUBLIC, anon, authenticated;

CREATE FUNCTION private.block_client_invitation_delivery_state_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path TO '' AS $function$
BEGIN
  -- This trigger deliberately runs as the role issuing the write.  The two
  -- approved server RPCs below are postgres-owned SECURITY DEFINER functions,
  -- so their internal writes run as postgres; clients cannot SET ROLE postgres.
  IF current_user <> 'postgres' AND (
    NEW.delivery_attempt_count IS DISTINCT FROM OLD.delivery_attempt_count OR
    NEW.last_delivery_attempt_at IS DISTINCT FROM OLD.last_delivery_attempt_at OR
    NEW.last_delivery_accepted_at IS DISTINCT FROM OLD.last_delivery_accepted_at OR
    NEW.delivery_attempt_timestamps IS DISTINCT FROM OLD.delivery_attempt_timestamps
  ) THEN RAISE EXCEPTION 'Invitation delivery state is server controlled' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END; $function$;
REVOKE ALL ON FUNCTION private.block_client_invitation_delivery_state_mutation() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER team_invitations_delivery_state_guard BEFORE UPDATE ON public.team_invitations FOR EACH ROW EXECUTE FUNCTION private.block_client_invitation_delivery_state_mutation();
CREATE TRIGGER family_team_invitations_delivery_state_guard BEFORE UPDATE ON public.family_team_invitations FOR EACH ROW EXECUTE FUNCTION private.block_client_invitation_delivery_state_mutation();
CREATE TRIGGER guardian_invitations_delivery_state_guard BEFORE UPDATE ON public.guardian_invitations FOR EACH ROW EXECUTE FUNCTION private.block_client_invitation_delivery_state_mutation();
CREATE TRIGGER child_login_invitations_delivery_state_guard BEFORE UPDATE ON public.child_login_invitations FOR EACH ROW EXECUTE FUNCTION private.block_client_invitation_delivery_state_mutation();

CREATE FUNCTION private.phase20a_verified_actor(p_auth_user_id uuid, p_verified_email text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
  SELECT p_auth_user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM auth.users u WHERE u.id=p_auth_user_id AND u.email_confirmed_at IS NOT NULL AND lower(btrim(u.email))=lower(btrim(p_verified_email))
  );
$function$;
REVOKE ALL ON FUNCTION private.phase20a_verified_actor(uuid,text) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.server_reserve_invitation_delivery_attempt(p_auth_user_id uuid,p_verified_email text,p_invitation_kind text,p_invitation_id uuid)
RETURNS TABLE(result text, recipient text) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_recent timestamptz[]; v_actor_recent timestamptz[]; v_now timestamptz:=clock_timestamp(); v_authorized boolean:=false; v_status public.team_invitation_status; v_expires timestamptz; v_recipient text; v_actor uuid:=p_auth_user_id;
BEGIN
  IF NOT private.phase20a_verified_actor(p_auth_user_id,p_verified_email) OR p_invitation_kind NOT IN ('assistant_coach','family_team','guardian','child_self_login') OR p_invitation_id IS NULL THEN RETURN QUERY SELECT 'unavailable',NULL::text; RETURN; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('phase20a:invitation:'||p_invitation_kind||':'||p_invitation_id::text,20020));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('phase20a:actor:'||v_actor::text,20020));
  IF p_invitation_kind='assistant_coach' THEN
    SELECT i.status,i.expires_at,i.invited_email,(i.role='assistant_coach' AND EXISTS(SELECT 1 FROM public.team_staff_memberships s WHERE s.team_id=i.team_id AND s.profile_id=v_actor AND s.role='coach')) INTO v_status,v_expires,v_recipient,v_authorized FROM public.team_invitations i WHERE i.id=p_invitation_id FOR UPDATE;
  ELSIF p_invitation_kind='family_team' THEN
    SELECT i.status,i.expires_at,i.invited_email,EXISTS(SELECT 1 FROM public.team_staff_memberships s WHERE s.team_id=i.team_id AND s.profile_id=v_actor) INTO v_status,v_expires,v_recipient,v_authorized FROM public.family_team_invitations i WHERE i.id=p_invitation_id FOR UPDATE;
  ELSIF p_invitation_kind='guardian' THEN
    SELECT i.status,i.expires_at,i.invited_email,EXISTS(SELECT 1 FROM public.athlete_profile_relationships r WHERE r.athlete_id=i.athlete_id AND r.profile_id=v_actor AND r.role='guardian' AND r.manage_permission AND r.revoked_at IS NULL) INTO v_status,v_expires,v_recipient,v_authorized FROM public.guardian_invitations i WHERE i.id=p_invitation_id FOR UPDATE;
  ELSE
    SELECT i.status,i.expires_at,i.invited_email,EXISTS(SELECT 1 FROM public.athlete_profile_relationships r WHERE r.athlete_id=i.athlete_id AND r.profile_id=v_actor AND r.role='guardian' AND r.manage_permission AND r.revoked_at IS NULL) INTO v_status,v_expires,v_recipient,v_authorized FROM public.child_login_invitations i WHERE i.id=p_invitation_id FOR UPDATE;
  END IF;
  IF NOT FOUND OR NOT v_authorized OR v_status<>'pending' OR v_expires<=v_now THEN RETURN QUERY SELECT 'unavailable',NULL::text; RETURN; END IF;
  SELECT coalesce(array_agg(t ORDER BY t),ARRAY[]::timestamptz[]) INTO v_recent FROM unnest(CASE p_invitation_kind WHEN 'assistant_coach' THEN (SELECT delivery_attempt_timestamps FROM public.team_invitations WHERE id=p_invitation_id) WHEN 'family_team' THEN (SELECT delivery_attempt_timestamps FROM public.family_team_invitations WHERE id=p_invitation_id) WHEN 'guardian' THEN (SELECT delivery_attempt_timestamps FROM public.guardian_invitations WHERE id=p_invitation_id) ELSE (SELECT delivery_attempt_timestamps FROM public.child_login_invitations WHERE id=p_invitation_id) END) t WHERE t>v_now-interval '1 day';
  INSERT INTO public.invitation_delivery_actor_rate_state(profile_id) VALUES(v_actor) ON CONFLICT(profile_id) DO NOTHING;
  SELECT coalesce(array_agg(t ORDER BY t),ARRAY[]::timestamptz[]) INTO v_actor_recent FROM unnest((SELECT delivery_attempt_timestamps FROM public.invitation_delivery_actor_rate_state WHERE profile_id=v_actor FOR UPDATE)) t WHERE t>v_now-interval '1 day';
  IF coalesce(array_length(v_recent,1),0)>=5 OR coalesce(array_length(v_actor_recent,1),0)>=20 OR (coalesce(array_length(v_recent,1),0)>0 AND v_recent[array_length(v_recent,1)]>v_now-interval '10 minutes') THEN RETURN QUERY SELECT 'rate_limited',NULL::text; RETURN; END IF;
  v_recent:=array_append(v_recent,v_now); v_actor_recent:=array_append(v_actor_recent,v_now);
  IF p_invitation_kind='assistant_coach' THEN UPDATE public.team_invitations SET delivery_attempt_count=delivery_attempt_count+1,last_delivery_attempt_at=v_now,delivery_attempt_timestamps=v_recent WHERE id=p_invitation_id;
  ELSIF p_invitation_kind='family_team' THEN UPDATE public.family_team_invitations SET delivery_attempt_count=delivery_attempt_count+1,last_delivery_attempt_at=v_now,delivery_attempt_timestamps=v_recent WHERE id=p_invitation_id;
  ELSIF p_invitation_kind='guardian' THEN UPDATE public.guardian_invitations SET delivery_attempt_count=delivery_attempt_count+1,last_delivery_attempt_at=v_now,delivery_attempt_timestamps=v_recent WHERE id=p_invitation_id;
  ELSE UPDATE public.child_login_invitations SET delivery_attempt_count=delivery_attempt_count+1,last_delivery_attempt_at=v_now,delivery_attempt_timestamps=v_recent WHERE id=p_invitation_id; END IF;
  UPDATE public.invitation_delivery_actor_rate_state SET delivery_attempt_timestamps=v_actor_recent WHERE profile_id=v_actor;
  RETURN QUERY SELECT 'reserved',v_recipient;
END; $function$;

CREATE FUNCTION public.server_mark_invitation_delivery_accepted(p_auth_user_id uuid,p_verified_email text,p_invitation_kind text,p_invitation_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
BEGIN
  IF NOT private.phase20a_verified_actor(p_auth_user_id,p_verified_email) OR p_invitation_kind NOT IN ('assistant_coach','family_team','guardian','child_self_login') OR p_invitation_id IS NULL THEN RETURN; END IF;
  IF p_invitation_kind='assistant_coach' THEN
    UPDATE public.team_invitations i SET last_delivery_accepted_at=clock_timestamp() WHERE i.id=p_invitation_id AND i.status='pending' AND i.role='assistant_coach' AND EXISTS(SELECT 1 FROM public.team_staff_memberships s WHERE s.team_id=i.team_id AND s.profile_id=p_auth_user_id AND s.role='coach');
  ELSIF p_invitation_kind='family_team' THEN
    UPDATE public.family_team_invitations i SET last_delivery_accepted_at=clock_timestamp() WHERE i.id=p_invitation_id AND i.status='pending' AND EXISTS(SELECT 1 FROM public.team_staff_memberships s WHERE s.team_id=i.team_id AND s.profile_id=p_auth_user_id);
  ELSIF p_invitation_kind='guardian' THEN
    UPDATE public.guardian_invitations i SET last_delivery_accepted_at=clock_timestamp() WHERE i.id=p_invitation_id AND i.status='pending' AND EXISTS(SELECT 1 FROM public.athlete_profile_relationships r WHERE r.athlete_id=i.athlete_id AND r.profile_id=p_auth_user_id AND r.role='guardian' AND r.manage_permission AND r.revoked_at IS NULL);
  ELSE
    UPDATE public.child_login_invitations i SET last_delivery_accepted_at=clock_timestamp() WHERE i.id=p_invitation_id AND i.status='pending' AND EXISTS(SELECT 1 FROM public.athlete_profile_relationships r WHERE r.athlete_id=i.athlete_id AND r.profile_id=p_auth_user_id AND r.role='guardian' AND r.manage_permission AND r.revoked_at IS NULL);
  END IF;
END; $function$;
REVOKE ALL ON FUNCTION public.server_reserve_invitation_delivery_attempt(uuid,text,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.server_mark_invitation_delivery_accepted(uuid,text,text,uuid) FROM PUBLIC, anon, authenticated;
ALTER FUNCTION private.block_client_invitation_delivery_state_mutation() OWNER TO postgres;
ALTER FUNCTION private.phase20a_verified_actor(uuid,text) OWNER TO postgres;
ALTER FUNCTION public.server_reserve_invitation_delivery_attempt(uuid,text,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.server_mark_invitation_delivery_accepted(uuid,text,text,uuid) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.server_reserve_invitation_delivery_attempt(uuid,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.server_mark_invitation_delivery_accepted(uuid,text,text,uuid) TO service_role;

-- Invitation token hashes are bearer-token verifiers, not manager-facing
-- operational metadata. RLS limits rows, but only column grants prevent an
-- otherwise-authorized manager from explicitly selecting token_hash.
REVOKE SELECT ON TABLE public.team_invitations FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id, team_id, invited_email, role, invited_by_user_id, status, expires_at,
  accepted_by_user_id, accepted_at, revoked_at, created_at, updated_at
) ON TABLE public.team_invitations TO authenticated;

REVOKE SELECT ON TABLE public.family_team_invitations FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id, team_id, invited_email, invited_by_profile_id, status, expires_at,
  accepted_by_profile_id, accepted_athlete_id, accepted_at,
  revoked_by_profile_id, revoked_at, created_at, updated_at
) ON TABLE public.family_team_invitations TO authenticated;

REVOKE SELECT ON TABLE public.guardian_invitations FROM PUBLIC, anon, authenticated;
REVOKE SELECT ON TABLE public.child_login_invitations FROM PUBLIC, anon, authenticated;

COMMIT;
