BEGIN;

-- Phase 13E.A.  The 13EA protocol serializes every future SELF writer using
-- transaction advisory locks derived with this fixed seed.
CREATE TABLE public.child_login_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id uuid NOT NULL REFERENCES public.athletes(id) ON DELETE RESTRICT,
  invited_email text NOT NULL,
  inviter_profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  token_hash text NOT NULL CONSTRAINT child_login_invitations_token_hash_unique UNIQUE,
  status public.team_invitation_status NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_by_profile_id uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  accepted_at timestamptz,
  revoked_by_profile_id uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL,
  CONSTRAINT child_login_invitations_email_normalized CHECK (invited_email = lower(btrim(invited_email)) AND invited_email ~ E'^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'),
  CONSTRAINT child_login_invitations_token_hash_sha256 CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT child_login_invitations_exact_expiry CHECK (expires_at = created_at + interval '7 days'),
  CONSTRAINT child_login_invitations_lifecycle CHECK (
    (status='pending' AND accepted_by_profile_id IS NULL AND accepted_at IS NULL AND revoked_by_profile_id IS NULL AND revoked_at IS NULL)
    OR (status='accepted' AND accepted_by_profile_id IS NOT NULL AND accepted_at IS NOT NULL AND revoked_by_profile_id IS NULL AND revoked_at IS NULL)
    OR (status='revoked' AND accepted_by_profile_id IS NULL AND accepted_at IS NULL AND revoked_by_profile_id IS NOT NULL AND revoked_at IS NOT NULL)
    OR (status='expired' AND accepted_by_profile_id IS NULL AND accepted_at IS NULL AND revoked_by_profile_id IS NULL AND revoked_at IS NULL)
  )
);
CREATE UNIQUE INDEX child_login_invitations_one_pending_per_athlete ON public.child_login_invitations(athlete_id) WHERE status='pending';
CREATE INDEX child_login_invitations_inviter_idx ON public.child_login_invitations(inviter_profile_id);
CREATE INDEX child_login_invitations_pending_expiry_idx ON public.child_login_invitations(expires_at) WHERE status='pending';

CREATE FUNCTION private.child_login_now() RETURNS timestamptz LANGUAGE sql SECURITY INVOKER SET search_path TO '' AS $function$
  SELECT pg_catalog.clock_timestamp();
$function$;
REVOKE ALL ON FUNCTION private.child_login_now() FROM PUBLIC, anon, authenticated;

CREATE FUNCTION private.set_child_login_invitation_insert_values() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_now timestamptz := private.child_login_now(); BEGIN NEW.created_at:=v_now; NEW.updated_at:=v_now; NEW.expires_at:=v_now+interval '7 days'; RETURN NEW; END; $function$;
REVOKE ALL ON FUNCTION private.set_child_login_invitation_insert_values() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER child_login_invitations_set_insert_values BEFORE INSERT ON public.child_login_invitations FOR EACH ROW EXECUTE FUNCTION private.set_child_login_invitation_insert_values();

CREATE FUNCTION private.validate_child_login_invitation_update() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
BEGIN
 IF NEW.athlete_id<>OLD.athlete_id OR NEW.invited_email<>OLD.invited_email OR NEW.inviter_profile_id<>OLD.inviter_profile_id OR NEW.token_hash<>OLD.token_hash OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at THEN RAISE EXCEPTION 'Child login invitation identity fields cannot be changed'; END IF;
 IF OLD.status<>'pending' AND NEW.status<>OLD.status THEN RAISE EXCEPTION 'Completed child login invitations cannot change status'; END IF;
 IF OLD.status='accepted' AND (NEW.accepted_by_profile_id IS DISTINCT FROM OLD.accepted_by_profile_id OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at) THEN RAISE EXCEPTION 'Accepted child login invitation audit fields cannot be changed'; END IF;
 IF OLD.status='revoked' AND (NEW.revoked_by_profile_id IS DISTINCT FROM OLD.revoked_by_profile_id OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN RAISE EXCEPTION 'Revoked child login invitation audit fields cannot be changed'; END IF;
 NEW.updated_at:=private.child_login_now(); RETURN NEW;
END; $function$;
REVOKE ALL ON FUNCTION private.validate_child_login_invitation_update() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER child_login_invitations_validate_update BEFORE UPDATE ON public.child_login_invitations FOR EACH ROW EXECUTE FUNCTION private.validate_child_login_invitation_update();

CREATE FUNCTION private.child_login_guardian_manage(p_athlete uuid, p_actor uuid DEFAULT auth.uid()) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
 SELECT EXISTS(SELECT 1 FROM public.athlete_profile_relationships r WHERE r.athlete_id=p_athlete AND r.profile_id=p_actor AND r.role='guardian' AND r.manage_permission AND r.revoked_at IS NULL); $function$;
REVOKE ALL ON FUNCTION private.child_login_guardian_manage(uuid,uuid) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION private.child_login_claim_lock(p_athlete uuid, p_profile uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE a bigint:=pg_catalog.hashtextextended('13EA:athlete:'||p_athlete::text,13051); b bigint; BEGIN
 IF p_profile IS NULL THEN PERFORM pg_catalog.pg_advisory_xact_lock(a); RETURN; END IF;
 b:=pg_catalog.hashtextextended('13EA:profile:'||p_profile::text,13051);
 IF a<=b THEN PERFORM pg_catalog.pg_advisory_xact_lock(a); PERFORM pg_catalog.pg_advisory_xact_lock(b); ELSE PERFORM pg_catalog.pg_advisory_xact_lock(b); PERFORM pg_catalog.pg_advisory_xact_lock(a); END IF;
END; $function$;
REVOKE ALL ON FUNCTION private.child_login_claim_lock(uuid,uuid) FROM PUBLIC, anon, authenticated;

-- This is a database boundary, not a convention for child-login RPCs.  Any
-- writer that changes SELF history contends with the 13EA athlete claim lock.
CREATE FUNCTION private.guard_child_login_self_relationship_write() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_first uuid; v_second uuid; v_first_key bigint; v_second_key bigint;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.role = 'self' THEN v_first := OLD.athlete_id; END IF;
  IF TG_OP <> 'DELETE' AND NEW.role = 'self' THEN
    IF v_first IS NULL THEN v_first := NEW.athlete_id;
    ELSIF v_first IS DISTINCT FROM NEW.athlete_id THEN v_second := NEW.athlete_id;
    END IF;
  END IF;
  IF v_first IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  v_first_key := pg_catalog.hashtextextended('13EA:athlete:' || v_first::text, 13051);
  IF v_second IS NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(v_first_key);
  ELSE
    v_second_key := pg_catalog.hashtextextended('13EA:athlete:' || v_second::text, 13051);
    IF v_first_key <= v_second_key THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(v_first_key);
      PERFORM pg_catalog.pg_advisory_xact_lock(v_second_key);
    ELSE
      PERFORM pg_catalog.pg_advisory_xact_lock(v_second_key);
      PERFORM pg_catalog.pg_advisory_xact_lock(v_first_key);
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END; $function$;
REVOKE ALL ON FUNCTION private.guard_child_login_self_relationship_write() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER athlete_profile_relationships_guard_child_login_self_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.athlete_profile_relationships
  FOR EACH ROW EXECUTE FUNCTION private.guard_child_login_self_relationship_write();

-- SELF is durable identity history: revoke it if necessary, never erase or relocate it.
CREATE FUNCTION private.prevent_child_login_self_history_erasure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.role = 'self' THEN
    RAISE EXCEPTION 'Historical SELF relationships cannot be deleted' USING ERRCODE='P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.role = 'self'
     AND (NEW.role <> 'self' OR NEW.athlete_id <> OLD.athlete_id OR NEW.profile_id <> OLD.profile_id) THEN
    RAISE EXCEPTION 'Historical SELF relationships cannot be erased or relocated' USING ERRCODE='P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END; $function$;
REVOKE ALL ON FUNCTION private.prevent_child_login_self_history_erasure() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER athlete_profile_relationships_protect_child_login_self_history
  BEFORE UPDATE OR DELETE ON public.athlete_profile_relationships
  FOR EACH ROW EXECUTE FUNCTION private.prevent_child_login_self_history_erasure();

ALTER TABLE public.child_login_invitations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.child_login_invitations FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.create_child_login_invitation(p_athlete_id uuid,p_invited_email text,p_token_hash text) RETURNS TABLE(invitation_id uuid,expires_at timestamptz) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_actor uuid:=(SELECT auth.uid()); v_email text:=lower(btrim(p_invited_email)); v_old public.child_login_invitations%ROWTYPE; BEGIN
 IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
 IF p_athlete_id IS NULL OR v_email IS NULL OR v_email !~ E'^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$' OR p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Child login invitation is invalid'; END IF;
 PERFORM private.child_login_claim_lock(p_athlete_id);
 PERFORM 1 FROM public.athletes a WHERE a.id=p_athlete_id AND a.status='active' FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Athlete is unavailable'; END IF;
 PERFORM 1 FROM public.athlete_profile_relationships r WHERE r.athlete_id=p_athlete_id AND r.profile_id=v_actor AND r.role='guardian' AND r.manage_permission AND r.revoked_at IS NULL FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Child login invitation is not authorized' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.athlete_profile_relationships r WHERE r.athlete_id=p_athlete_id AND r.role='self' FOR UPDATE; IF FOUND THEN RAISE EXCEPTION 'Athlete self claim is unavailable'; END IF;
 SELECT * INTO v_old FROM public.child_login_invitations i WHERE i.athlete_id=p_athlete_id AND i.status='pending' FOR UPDATE;
 IF FOUND THEN IF v_old.expires_at>private.child_login_now() THEN RAISE EXCEPTION 'A pending child login invitation already exists'; END IF; UPDATE public.child_login_invitations SET status='expired' WHERE id=v_old.id; END IF;
 BEGIN INSERT INTO public.child_login_invitations(athlete_id,invited_email,inviter_profile_id,token_hash) VALUES(p_athlete_id,v_email,v_actor,p_token_hash) RETURNING id,child_login_invitations.expires_at INTO invitation_id,expires_at; EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'Child login invitation is unavailable'; END;
 RETURN NEXT; END; $function$;

CREATE FUNCTION public.get_child_login_invitation_summary(p_invitation_token text) RETURNS TABLE(athlete_display_name text,expires_at timestamptz,invitation_status public.team_invitation_status) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_actor uuid:=(SELECT auth.uid()); v_email text; v_confirmed timestamptz; BEGIN
 IF v_actor IS NULL OR p_invitation_token IS NULL OR char_length(p_invitation_token) NOT BETWEEN 32 AND 256 OR p_invitation_token !~ '^[A-Za-z0-9_-]+$' THEN RETURN; END IF;
 SELECT u.email,u.email_confirmed_at INTO v_email,v_confirmed FROM auth.users u WHERE u.id=v_actor; IF v_email IS NULL OR v_confirmed IS NULL THEN RETURN; END IF;
 RETURN QUERY SELECT a.display_name,i.expires_at,CASE WHEN i.status='pending' AND i.expires_at<=private.child_login_now() THEN 'expired'::public.team_invitation_status ELSE i.status END FROM public.child_login_invitations i JOIN public.athletes a ON a.id=i.athlete_id WHERE i.token_hash=encode(extensions.digest(p_invitation_token,'sha256'),'hex') AND lower(btrim(v_email))=i.invited_email LIMIT 1; END; $function$;

CREATE FUNCTION public.accept_child_login_invitation(p_invitation_token text) RETURNS TABLE(athlete_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_actor uuid:=(SELECT auth.uid()); v_candidate uuid; v_i public.child_login_invitations%ROWTYPE; v_email text; v_confirmed timestamptz; BEGIN
 IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
 IF p_invitation_token IS NULL OR char_length(p_invitation_token) NOT BETWEEN 32 AND 256 OR p_invitation_token !~ '^[A-Za-z0-9_-]+$' THEN RAISE EXCEPTION 'Child login invitation is unavailable'; END IF;
 SELECT i.athlete_id INTO v_candidate FROM public.child_login_invitations i WHERE i.token_hash=encode(extensions.digest(p_invitation_token,'sha256'),'hex'); IF v_candidate IS NULL THEN RAISE EXCEPTION 'Child login invitation is unavailable'; END IF;
 PERFORM private.child_login_claim_lock(v_candidate,v_actor);
 SELECT * INTO v_i FROM public.child_login_invitations i WHERE i.token_hash=encode(extensions.digest(p_invitation_token,'sha256'),'hex') FOR UPDATE; IF NOT FOUND OR v_i.athlete_id<>v_candidate THEN RAISE EXCEPTION 'Child login invitation is unavailable'; END IF;
 IF v_i.status='accepted' THEN IF v_i.accepted_by_profile_id=v_actor AND EXISTS(SELECT 1 FROM public.athlete_profile_relationships r WHERE r.athlete_id=v_i.athlete_id AND r.profile_id=v_actor AND r.role='self' AND r.revoked_at IS NULL AND r.training_permission AND r.manage_permission FOR UPDATE) THEN RETURN QUERY SELECT v_i.athlete_id; RETURN; END IF; RAISE EXCEPTION 'Child login invitation is unavailable'; END IF;
 IF v_i.status<>'pending' THEN RAISE EXCEPTION 'Child login invitation is unavailable'; END IF;
 IF v_i.expires_at<=private.child_login_now() THEN UPDATE public.child_login_invitations SET status='expired' WHERE id=v_i.id; RAISE EXCEPTION 'Child login invitation is unavailable'; END IF;
 SELECT u.email,u.email_confirmed_at INTO v_email,v_confirmed FROM auth.users u WHERE u.id=v_actor; IF v_email IS NULL OR v_confirmed IS NULL OR lower(btrim(v_email))<>v_i.invited_email OR NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=v_actor) THEN RAISE EXCEPTION 'Child login invitation is unavailable'; END IF;
 PERFORM 1 FROM public.athletes a WHERE a.id=v_i.athlete_id AND a.status='active' FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Athlete is unavailable'; END IF;
 PERFORM 1 FROM public.athlete_profile_relationships r WHERE r.athlete_id=v_i.athlete_id AND r.profile_id=v_i.inviter_profile_id AND r.role='guardian' AND r.manage_permission AND r.revoked_at IS NULL FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Child login invitation is unavailable'; END IF;
 PERFORM 1 FROM public.athlete_profile_relationships r WHERE r.athlete_id=v_i.athlete_id AND r.role='self' FOR UPDATE; IF FOUND THEN RAISE EXCEPTION 'Child login claim conflict'; END IF;
 PERFORM 1 FROM public.athlete_profile_relationships r WHERE r.profile_id=v_actor AND r.role='self' AND r.revoked_at IS NULL FOR UPDATE; IF FOUND THEN RAISE EXCEPTION 'Child login claim conflict'; END IF;
 BEGIN INSERT INTO public.athlete_profile_relationships(athlete_id,profile_id,role,training_permission,manage_permission,created_by_profile_id) VALUES(v_i.athlete_id,v_actor,'self',true,true,v_i.inviter_profile_id); EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'Child login claim conflict'; END;
 UPDATE public.child_login_invitations SET status='accepted',accepted_by_profile_id=v_actor,accepted_at=private.child_login_now() WHERE id=v_i.id; RETURN QUERY SELECT v_i.athlete_id; END; $function$;

CREATE FUNCTION public.revoke_child_login_invitation(p_invitation_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_actor uuid:=(SELECT auth.uid()); v_athlete uuid; v_i public.child_login_invitations%ROWTYPE; BEGIN
 IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
 SELECT i.athlete_id INTO v_athlete FROM public.child_login_invitations i WHERE i.id=p_invitation_id;
 IF v_athlete IS NULL THEN RAISE EXCEPTION 'Child login invitation is unavailable'; END IF;
 PERFORM private.child_login_claim_lock(v_athlete);
 SELECT * INTO v_i FROM public.child_login_invitations i WHERE i.id=p_invitation_id FOR UPDATE;
 IF NOT FOUND OR v_i.status<>'pending' THEN RAISE EXCEPTION 'Child login invitation is unavailable'; END IF;
 IF NOT private.child_login_guardian_manage(v_i.athlete_id,v_actor) THEN RAISE EXCEPTION 'Child login invitation is not authorized' USING ERRCODE='42501'; END IF;
 IF v_i.expires_at<=private.child_login_now() THEN UPDATE public.child_login_invitations SET status='expired' WHERE id=v_i.id; RAISE EXCEPTION 'Child login invitation is unavailable'; END IF;
 UPDATE public.child_login_invitations SET status='revoked',revoked_by_profile_id=v_actor,revoked_at=private.child_login_now() WHERE id=v_i.id;
END; $function$;
CREATE FUNCTION public.list_my_child_login_invitations(p_athlete_id uuid) RETURNS TABLE(invitation_id uuid,invited_email text,invitation_status public.team_invitation_status,expires_at timestamptz,created_at timestamptz) LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
 SELECT i.id,i.invited_email,CASE WHEN i.status='pending' AND i.expires_at<=private.child_login_now() THEN 'expired'::public.team_invitation_status ELSE i.status END,i.expires_at,i.created_at FROM public.child_login_invitations i WHERE i.athlete_id=p_athlete_id AND private.child_login_guardian_manage(p_athlete_id) ORDER BY i.created_at,i.id; $function$;

REVOKE ALL ON FUNCTION public.create_child_login_invitation(uuid,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.get_child_login_invitation_summary(text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.accept_child_login_invitation(text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.revoke_child_login_invitation(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.list_my_child_login_invitations(uuid) FROM PUBLIC,anon,authenticated;
COMMIT;
