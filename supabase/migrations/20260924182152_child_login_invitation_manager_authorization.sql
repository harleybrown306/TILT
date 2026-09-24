BEGIN;

CREATE OR REPLACE FUNCTION public.create_child_login_invitation(p_athlete_id uuid,p_invited_email text,p_token_hash text) RETURNS TABLE(invitation_id uuid,expires_at timestamptz) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_actor uuid:=(SELECT auth.uid()); v_email text:=lower(btrim(p_invited_email)); v_old public.child_login_invitations%ROWTYPE; BEGIN
 IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
 IF p_athlete_id IS NULL OR v_email IS NULL OR v_email !~ E'^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$' OR p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Child login invitation is invalid'; END IF;
 PERFORM private.child_login_claim_lock(p_athlete_id);
 PERFORM 1 FROM public.athletes a WHERE a.id=p_athlete_id AND a.status='active' FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Athlete is unavailable'; END IF;
 PERFORM 1 FROM public.athlete_profile_relationships r WHERE r.athlete_id=p_athlete_id AND r.profile_id=v_actor AND r.role IN ('self','guardian') FOR UPDATE;
 IF NOT private.can_manage_athlete_identity(p_athlete_id) THEN RAISE EXCEPTION 'Child login invitation is not authorized' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.athlete_profile_relationships r WHERE r.athlete_id=p_athlete_id AND r.role='self' FOR UPDATE; IF FOUND THEN RAISE EXCEPTION 'Athlete self claim is unavailable'; END IF;
 SELECT * INTO v_old FROM public.child_login_invitations i WHERE i.athlete_id=p_athlete_id AND i.status='pending' FOR UPDATE;
 IF FOUND THEN IF v_old.expires_at>private.child_login_now() THEN RAISE EXCEPTION 'A pending child login invitation already exists'; END IF; UPDATE public.child_login_invitations SET status='expired' WHERE id=v_old.id; END IF;
 BEGIN INSERT INTO public.child_login_invitations(athlete_id,invited_email,inviter_profile_id,token_hash) VALUES(p_athlete_id,v_email,v_actor,p_token_hash) RETURNING id,child_login_invitations.expires_at INTO invitation_id,expires_at; EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'Child login invitation is unavailable'; END;
 RETURN NEXT; END; $function$;

CREATE OR REPLACE FUNCTION public.revoke_child_login_invitation(p_invitation_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_actor uuid:=(SELECT auth.uid()); v_athlete uuid; v_i public.child_login_invitations%ROWTYPE; BEGIN
 IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
 SELECT i.athlete_id INTO v_athlete FROM public.child_login_invitations i WHERE i.id=p_invitation_id;
 IF v_athlete IS NULL THEN RAISE EXCEPTION 'Child login invitation is unavailable'; END IF;
 PERFORM private.child_login_claim_lock(v_athlete);
 SELECT * INTO v_i FROM public.child_login_invitations i WHERE i.id=p_invitation_id FOR UPDATE;
 IF NOT FOUND OR v_i.status<>'pending' THEN RAISE EXCEPTION 'Child login invitation is unavailable'; END IF;
 IF NOT private.can_manage_athlete_identity(v_i.athlete_id) THEN RAISE EXCEPTION 'Child login invitation is not authorized' USING ERRCODE='42501'; END IF;
 IF v_i.expires_at<=private.child_login_now() THEN UPDATE public.child_login_invitations SET status='expired' WHERE id=v_i.id; RAISE EXCEPTION 'Child login invitation is unavailable'; END IF;
 UPDATE public.child_login_invitations SET status='revoked',revoked_by_profile_id=v_actor,revoked_at=private.child_login_now() WHERE id=v_i.id;
END; $function$;

CREATE OR REPLACE FUNCTION public.list_my_child_login_invitations(p_athlete_id uuid) RETURNS TABLE(invitation_id uuid,invited_email text,invitation_status public.team_invitation_status,expires_at timestamptz,created_at timestamptz) LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
 SELECT i.id,i.invited_email,CASE WHEN i.status='pending' AND i.expires_at<=private.child_login_now() THEN 'expired'::public.team_invitation_status ELSE i.status END,i.expires_at,i.created_at FROM public.child_login_invitations i WHERE i.athlete_id=p_athlete_id AND private.can_manage_athlete_identity(p_athlete_id) ORDER BY i.created_at,i.id; $function$;

DROP FUNCTION private.child_login_guardian_manage(uuid,uuid);

REVOKE ALL ON FUNCTION public.create_child_login_invitation(uuid,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.revoke_child_login_invitation(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.list_my_child_login_invitations(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.get_child_login_invitation_summary(text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.accept_child_login_invitation(text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON TABLE public.child_login_invitations FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_child_login_invitation(uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_child_login_invitation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_my_child_login_invitations(uuid) TO authenticated;

COMMIT;
