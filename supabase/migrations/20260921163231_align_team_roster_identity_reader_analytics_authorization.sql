BEGIN;

-- Align this read-only analytics roster projection with the existing
-- team-analytics VIEW boundary. This preserves its projection and all other
-- execution behavior while allowing platform-admin support visibility.
CREATE OR REPLACE FUNCTION public.list_my_team_rostered_athlete_identities(
  p_team_id uuid
)
RETURNS TABLE (
  athlete_id uuid,
  display_name text,
  graduation_year integer,
  status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  -- Authorize before querying the team or roster. A guessed team UUID gives
  -- no roster/athlete-existence detail to a caller without analytics access.
  IF p_team_id IS NULL OR NOT private.can_view_team_analytics(p_team_id) THEN
    RAISE EXCEPTION 'Team roster is not available' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT athlete.id, athlete.display_name, athlete.graduation_year, athlete.status
  FROM public.team_athlete_memberships AS roster
  JOIN public.athletes AS athlete ON athlete.id = roster.athlete_id
  WHERE roster.team_id = p_team_id
  ORDER BY athlete.display_name, athlete.id;
END;
$function$;

ALTER FUNCTION public.list_my_team_rostered_athlete_identities(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_my_team_rostered_athlete_identities(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_my_team_rostered_athlete_identities(uuid)
  TO authenticated;

COMMENT ON FUNCTION public.list_my_team_rostered_athlete_identities(uuid) IS
  'Read-only, current-actor roster identity projection for callers authorized to view analytics for the requested team. It grants neither family relationship visibility nor athlete management, assignment, or training action authority.';

COMMIT;
