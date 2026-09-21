BEGIN;

-- Phase 13B.1 is additive for historical athlete identities. Legacy records
-- retain their presentation names and may have no structured names or class year.
ALTER TABLE public.athletes
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name text;

-- Replace the legacy display-name creator rather than adding an overload. New
-- creation requires structured names and a graduation year; only this function
-- constructs the compatibility display_name and guardian relationship.
CREATE OR REPLACE FUNCTION public.create_my_athlete(
  p_first_name text,
  p_last_name text,
  p_graduation_year integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_profile_id uuid := (SELECT auth.uid());
  v_athlete_id uuid := gen_random_uuid();
  v_first_name text := nullif(btrim(p_first_name), '');
  v_last_name text := nullif(btrim(p_last_name), '');
  v_display_name text;
BEGIN
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF v_first_name IS NULL THEN
    RAISE EXCEPTION 'Athlete first name is required';
  END IF;
  IF v_last_name IS NULL THEN
    RAISE EXCEPTION 'Athlete last name is required';
  END IF;
  IF p_graduation_year IS NULL OR p_graduation_year NOT BETWEEN 2000 AND 2100 THEN
    RAISE EXCEPTION 'Graduation year must be between 2000 and 2100';
  END IF;

  v_display_name := v_first_name || ' ' || v_last_name;
  IF char_length(v_display_name) > 200 THEN
    RAISE EXCEPTION 'Athlete name must be at most 200 characters';
  END IF;

  INSERT INTO public.athletes (
    id, first_name, last_name, display_name, graduation_year, created_by_profile_id
  ) VALUES (
    v_athlete_id, v_first_name, v_last_name, v_display_name, p_graduation_year, v_profile_id
  );

  INSERT INTO public.athlete_profile_relationships (
    athlete_id, profile_id, role, training_permission, manage_permission, created_by_profile_id
  ) VALUES (
    v_athlete_id, v_profile_id, 'guardian', true, true, v_profile_id
  );

  RETURN v_athlete_id;
END;
$function$;

ALTER FUNCTION public.create_my_athlete(text, text, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_my_athlete(text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_my_athlete(text, text, integer)
  TO authenticated;

-- PostgreSQL overloads functions by argument types. Explicitly retire the
-- former signature so no caller can create an athlete without structured names
-- or graduation year.
REVOKE ALL ON FUNCTION public.create_my_athlete(text, integer)
  FROM PUBLIC, anon, authenticated;
DROP FUNCTION public.create_my_athlete(text, integer);

COMMENT ON FUNCTION public.create_my_athlete(text, text, integer) IS
  'Creates a new parent-managed athlete with required structured names and graduation year, plus an active guardian MANAGE and ACT relationship for the authenticated caller.';

-- Changing a RETURNS TABLE shape requires replacement of the existing function
-- identity. Recreate it with the same current-actor analytics authorization.
REVOKE ALL ON FUNCTION public.list_my_team_rostered_athlete_identities(uuid)
  FROM PUBLIC, anon, authenticated;
DROP FUNCTION public.list_my_team_rostered_athlete_identities(uuid);

CREATE FUNCTION public.list_my_team_rostered_athlete_identities(
  p_team_id uuid
)
RETURNS TABLE (
  athlete_id uuid,
  first_name text,
  last_name text,
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

  IF p_team_id IS NULL OR NOT private.can_view_team_analytics(p_team_id) THEN
    RAISE EXCEPTION 'Team roster is not available' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT athlete.id, athlete.first_name, athlete.last_name, athlete.display_name,
    athlete.graduation_year, athlete.status
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
