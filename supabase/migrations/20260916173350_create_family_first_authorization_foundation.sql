BEGIN;

-- Phase 11B.4 adds parallel canonical authorization helpers only. Existing
-- legacy helper overloads, RLS policies, RPCs, triggers, and application
-- consumers remain unchanged until a separate cutover.

-- Internal identity-to-team lookup. It deliberately accepts an athlete ID but
-- is not executable by authenticated callers; public/current-actor helpers
-- below use it without exposing an actor parameter.
CREATE OR REPLACE FUNCTION private.is_athlete_on_team(p_team_id uuid, p_athlete_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.team_athlete_memberships AS membership
    WHERE membership.team_id = p_team_id
      AND membership.athlete_id = p_athlete_id
  );
$function$;
REVOKE ALL ON FUNCTION private.is_athlete_on_team(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- One-argument overloads are the canonical current-actor team helpers. The
-- older two-argument helpers remain intact for legacy policies and RPCs.
CREATE OR REPLACE FUNCTION private.is_team_staff(p_team_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.team_staff_memberships AS membership
    WHERE membership.team_id = p_team_id
      AND membership.profile_id = (SELECT auth.uid())
  );
$function$;

CREATE OR REPLACE FUNCTION private.is_team_coach(p_team_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.team_staff_memberships AS membership
    WHERE membership.team_id = p_team_id
      AND membership.profile_id = (SELECT auth.uid())
      AND membership.role = 'coach'::public.team_staff_role
  );
$function$;

CREATE OR REPLACE FUNCTION private.can_manage_team(p_team_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT private.is_team_coach(p_team_id);
$function$;

CREATE OR REPLACE FUNCTION private.can_manage_roster(p_team_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT private.is_team_staff(p_team_id);
$function$;

CREATE OR REPLACE FUNCTION private.can_manage_team_staff(p_team_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT private.can_manage_team(p_team_id);
$function$;

CREATE OR REPLACE FUNCTION private.can_view_team_analytics(p_team_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT private.is_team_staff(p_team_id)
    OR private.is_admin((SELECT auth.uid()));
$function$;

CREATE OR REPLACE FUNCTION private.can_assign_team_athlete_training(p_team_id uuid, p_athlete_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT private.can_manage_roster(p_team_id)
    AND private.is_athlete_on_team(p_team_id, p_athlete_id);
$function$;

-- Canonical family-first athlete capabilities. All derive the current actor
-- from auth.uid(); no authenticated callable signature accepts a profile ID.
CREATE OR REPLACE FUNCTION private.can_view_athlete(p_athlete_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT private.can_view_athlete_identity(p_athlete_id)
    OR EXISTS (
      SELECT 1
      FROM public.team_staff_memberships AS staff
      JOIN public.team_athlete_memberships AS roster
        ON roster.team_id = staff.team_id
      WHERE staff.profile_id = (SELECT auth.uid())
        AND roster.athlete_id = p_athlete_id
    );
$function$;

CREATE OR REPLACE FUNCTION private.can_manage_athlete(p_athlete_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT private.can_manage_athlete_identity(p_athlete_id);
$function$;

CREATE OR REPLACE FUNCTION private.can_act_for_training(p_athlete_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.athlete_profile_relationships AS relationship
    WHERE relationship.athlete_id = p_athlete_id
      AND relationship.profile_id = (SELECT auth.uid())
      AND relationship.revoked_at IS NULL
      AND relationship.training_permission
  );
$function$;

REVOKE ALL ON FUNCTION private.is_team_staff(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.is_team_coach(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.can_manage_team(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.can_manage_roster(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.can_manage_team_staff(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.can_view_team_analytics(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.can_assign_team_athlete_training(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.can_view_athlete(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.can_manage_athlete(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.can_act_for_training(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION private.is_team_staff(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_team_coach(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_manage_team(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_manage_roster(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_manage_team_staff(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_view_team_analytics(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_assign_team_athlete_training(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_view_athlete(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_manage_athlete(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_act_for_training(uuid) TO authenticated;

COMMENT ON FUNCTION private.can_view_athlete(uuid) IS
  'Current actor may view through an active family relationship, team staff/roster scope, or explicit platform-admin support visibility.';
COMMENT ON FUNCTION private.can_manage_athlete(uuid) IS
  'Current actor may manage athlete identity only through an active relationship with manage_permission; team staff and admin do not qualify.';
COMMENT ON FUNCTION private.can_act_for_training(uuid) IS
  'Current actor may act for athlete training only through an active self or guardian relationship with training_permission.';

COMMIT;
