BEGIN;

-- Phase 11B.7A adds the single authenticated writer for durable athlete
-- roster membership. It intentionally changes neither table RLS nor grants.
-- The caller must independently manage both the team roster and the athlete.
CREATE OR REPLACE FUNCTION public.add_my_managed_athlete_to_team(
  p_team_id uuid,
  p_athlete_id uuid
)
RETURNS TABLE (team_id uuid, athlete_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_membership public.team_athlete_memberships;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_team_id IS NULL OR p_athlete_id IS NULL THEN
    RAISE EXCEPTION 'Roster request is incomplete';
  END IF;

  -- Do this before existence/state detail so an actor cannot use guessed UUIDs
  -- to learn whether an athlete exists or is managed by someone else.
  IF NOT private.can_manage_roster(p_team_id)
     OR NOT private.can_manage_athlete(p_athlete_id) THEN
    RAISE EXCEPTION 'Roster addition is not authorized' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.teams AS team WHERE team.id = p_team_id
  ) THEN
    RAISE EXCEPTION 'Team is unavailable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.athletes AS athlete
    WHERE athlete.id = p_athlete_id
      AND athlete.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Athlete is unavailable';
  END IF;

  -- Serialize only the logical membership key. This makes a repeated request
  -- idempotent without an ON CONFLICT branch that could conceal other faults.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_team_id::text || ':' || p_athlete_id::text, 0)
  );

  SELECT membership.* INTO v_membership
  FROM public.team_athlete_memberships AS membership
  WHERE membership.team_id = p_team_id
    AND membership.athlete_id = p_athlete_id;

  IF FOUND THEN
    RETURN QUERY SELECT v_membership.team_id, v_membership.athlete_id;
    RETURN;
  END IF;

  INSERT INTO public.team_athlete_memberships (
    team_id,
    athlete_id,
    created_by_profile_id
  ) VALUES (
    p_team_id,
    p_athlete_id,
    v_actor
  ) RETURNING * INTO v_membership;

  RETURN QUERY SELECT v_membership.team_id, v_membership.athlete_id;
END;
$function$;

ALTER FUNCTION public.add_my_managed_athlete_to_team(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.add_my_managed_athlete_to_team(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_my_managed_athlete_to_team(uuid, uuid)
  TO authenticated;

COMMENT ON FUNCTION public.add_my_managed_athlete_to_team(uuid, uuid) IS
  'Adds an active durable athlete to a team only when the authenticated actor manages both the team roster and that athlete.';

COMMIT;
