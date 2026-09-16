BEGIN;

-- Phase 11B.2 is additive. Existing *_user_id columns and all historical
-- training records remain unchanged while athlete identities are introduced.
CREATE TABLE IF NOT EXISTS public.athletes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 200),
  graduation_year integer CHECK (graduation_year IS NULL OR graduation_year BETWEEN 2000 AND 2100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  archived_at timestamptz,
  CONSTRAINT athletes_archive_state_check CHECK (
    (status = 'active' AND archived_at IS NULL)
    OR (status = 'archived' AND archived_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.athlete_profile_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id uuid NOT NULL REFERENCES public.athletes(id) ON DELETE RESTRICT,
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('guardian', 'self')),
  training_permission boolean NOT NULL DEFAULT false,
  manage_permission boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  created_by_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT athlete_profile_relationships_revocation_check CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX IF NOT EXISTS athletes_status_idx ON public.athletes(status);
CREATE INDEX IF NOT EXISTS athlete_profile_relationships_profile_active_idx
  ON public.athlete_profile_relationships(profile_id, athlete_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS athlete_profile_relationships_athlete_active_idx
  ON public.athlete_profile_relationships(athlete_id, profile_id)
  WHERE revoked_at IS NULL;

-- Active links are unique; revoked rows remain historical/auditable.
CREATE UNIQUE INDEX IF NOT EXISTS athlete_profile_relationships_active_role_unique
  ON public.athlete_profile_relationships(athlete_id, profile_id, role)
  WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS athlete_profile_relationships_active_self_athlete_unique
  ON public.athlete_profile_relationships(athlete_id)
  WHERE revoked_at IS NULL AND role = 'self';
CREATE UNIQUE INDEX IF NOT EXISTS athlete_profile_relationships_active_self_profile_unique
  ON public.athlete_profile_relationships(profile_id)
  WHERE revoked_at IS NULL AND role = 'self';

CREATE OR REPLACE FUNCTION private.set_athlete_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.set_athlete_updated_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS athletes_set_updated_at ON public.athletes;
CREATE TRIGGER athletes_set_updated_at
BEFORE UPDATE ON public.athletes
FOR EACH ROW EXECUTE FUNCTION private.set_athlete_updated_at();

-- These helpers intentionally authorize only the new identity tables. They do
-- not change RLS on current training, roster, or telemetry tables.
CREATE OR REPLACE FUNCTION private.can_view_athlete_identity(p_athlete_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT private.is_admin((SELECT auth.uid()))
    OR EXISTS (
      SELECT 1
      FROM public.athlete_profile_relationships AS relationship
      WHERE relationship.athlete_id = p_athlete_id
        AND relationship.profile_id = (SELECT auth.uid())
        AND relationship.revoked_at IS NULL
    );
$function$;

CREATE OR REPLACE FUNCTION private.can_manage_athlete_identity(p_athlete_id uuid)
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
        AND relationship.manage_permission
    );
$function$;

REVOKE ALL ON FUNCTION private.can_view_athlete_identity(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.can_manage_athlete_identity(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_view_athlete_identity(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_manage_athlete_identity(uuid) TO authenticated;

ALTER TABLE public.athletes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.athlete_profile_relationships ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.athletes, public.athlete_profile_relationships FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.athletes, public.athlete_profile_relationships TO authenticated;

DROP POLICY IF EXISTS athletes_select ON public.athletes;
CREATE POLICY athletes_select ON public.athletes
FOR SELECT TO authenticated
USING (private.can_view_athlete_identity(id));

DROP POLICY IF EXISTS athlete_profile_relationships_select ON public.athlete_profile_relationships;
CREATE POLICY athlete_profile_relationships_select ON public.athlete_profile_relationships
FOR SELECT TO authenticated
USING (
  profile_id = (SELECT auth.uid())
  OR private.can_manage_athlete_identity(athlete_id)
);

-- The only authenticated write surface introduced here creates a new child
-- athlete and grants the calling profile its first guardian relationship.
-- It accepts no existing athlete ID, so it cannot be used to claim an athlete.
CREATE OR REPLACE FUNCTION public.create_my_athlete(p_display_name text, p_graduation_year integer DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_profile_id uuid := (SELECT auth.uid());
  v_athlete_id uuid := gen_random_uuid();
  v_display_name text := nullif(btrim(p_display_name), '');
BEGIN
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF v_display_name IS NULL OR char_length(v_display_name) > 200 THEN
    RAISE EXCEPTION 'Athlete display name is required';
  END IF;

  INSERT INTO public.athletes (id, display_name, graduation_year, created_by_profile_id)
  VALUES (v_athlete_id, v_display_name, p_graduation_year, v_profile_id);

  INSERT INTO public.athlete_profile_relationships (
    athlete_id, profile_id, role, training_permission, manage_permission, created_by_profile_id
  ) VALUES (v_athlete_id, v_profile_id, 'guardian', true, true, v_profile_id);

  RETURN v_athlete_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.create_my_athlete(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_my_athlete(text, integer) TO authenticated;

-- Backfill only profiles currently represented by an athlete team membership.
-- Same UUIDs preserve future compatibility without adding a profiles FK.
INSERT INTO public.athletes (id, display_name, created_by_profile_id)
SELECT DISTINCT
  profile.id,
  coalesce(nullif(btrim(profile.full_name), ''), 'Athlete'),
  profile.id
FROM public.profiles AS profile
JOIN public.team_memberships AS membership
  ON membership.user_id = profile.id
WHERE membership.role = 'athlete'
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.athlete_profile_relationships (
  athlete_id, profile_id, role, training_permission, manage_permission, created_by_profile_id
)
SELECT DISTINCT
  profile.id,
  profile.id,
  'self',
  true,
  true,
  profile.id
FROM public.profiles AS profile
JOIN public.team_memberships AS membership
  ON membership.user_id = profile.id
WHERE membership.role = 'athlete'
ON CONFLICT DO NOTHING;

COMMENT ON TABLE public.athletes IS
  'Durable training subjects. An athlete may exist without an authenticated profile.';
COMMENT ON TABLE public.athlete_profile_relationships IS
  'Auditable profile-to-athlete authorization links; revoke relationships instead of deleting them.';
COMMENT ON FUNCTION public.create_my_athlete(text, integer) IS
  'Creates a parent-managed athlete and an active guardian relationship for the authenticated caller.';

COMMIT;
