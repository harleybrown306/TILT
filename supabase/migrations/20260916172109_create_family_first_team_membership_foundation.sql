BEGIN;

-- Phase 11B.3 is parallel-only. Existing public.team_memberships, its helper
-- functions, and all application/RLS consumers remain authoritative until a
-- separately reviewed cutover.
DO $type$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type AS type
    JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
    WHERE namespace.nspname = 'public' AND type.typname = 'team_staff_role'
  ) THEN
    CREATE TYPE public.team_staff_role AS ENUM ('coach', 'assistant_coach');
  END IF;
END;
$type$;

CREATE TABLE IF NOT EXISTS public.team_staff_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE RESTRICT,
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  role public.team_staff_role NOT NULL,
  created_by_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT team_staff_memberships_team_profile_unique UNIQUE (team_id, profile_id)
);

CREATE TABLE IF NOT EXISTS public.team_athlete_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE RESTRICT,
  athlete_id uuid NOT NULL REFERENCES public.athletes(id) ON DELETE RESTRICT,
  created_by_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT team_athlete_memberships_team_athlete_unique UNIQUE (team_id, athlete_id)
);

CREATE INDEX IF NOT EXISTS team_staff_memberships_profile_team_idx
  ON public.team_staff_memberships(profile_id, team_id);
CREATE INDEX IF NOT EXISTS team_athlete_memberships_athlete_team_idx
  ON public.team_athlete_memberships(athlete_id, team_id);

-- Do not invent an athlete identity. Phase 11B.2 must already have created
-- every same-UUID athlete required by a legacy athlete roster membership.
DO $backfill_guard$
DECLARE v_missing_athletes integer;
BEGIN
  SELECT count(*) INTO v_missing_athletes
  FROM public.team_memberships AS legacy
  LEFT JOIN public.athletes AS athlete ON athlete.id = legacy.user_id
  WHERE legacy.role = 'athlete' AND athlete.id IS NULL;
  IF v_missing_athletes <> 0 THEN
    RAISE EXCEPTION 'Cannot backfill team athlete memberships: % legacy athlete memberships have no athlete identity', v_missing_athletes;
  END IF;
END;
$backfill_guard$;

-- Preserve the legacy membership UUID as the parallel membership UUID. This
-- makes migration review and future controlled cutover mapping deterministic.
INSERT INTO public.team_staff_memberships (
  id, team_id, profile_id, role, created_by_profile_id, created_at
)
SELECT
  legacy.id,
  legacy.team_id,
  legacy.user_id,
  legacy.role::text::public.team_staff_role,
  legacy.created_by_user_id,
  legacy.created_at
FROM public.team_memberships AS legacy
WHERE legacy.role IN ('coach', 'assistant_coach');

INSERT INTO public.team_athlete_memberships (
  id, team_id, athlete_id, created_by_profile_id, created_at
)
SELECT
  legacy.id,
  legacy.team_id,
  legacy.user_id,
  legacy.created_by_user_id,
  legacy.created_at
FROM public.team_memberships AS legacy
WHERE legacy.role = 'athlete';

ALTER TABLE public.team_staff_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_athlete_memberships ENABLE ROW LEVEL SECURITY;

-- No client write path is introduced. A later cutover must supply narrowly
-- authorized staff/invitation workflows before these tables become writable.
REVOKE ALL ON public.team_staff_memberships, public.team_athlete_memberships
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.team_staff_memberships, public.team_athlete_memberships
  TO authenticated;

DROP POLICY IF EXISTS team_staff_memberships_select ON public.team_staff_memberships;
CREATE POLICY team_staff_memberships_select
ON public.team_staff_memberships FOR SELECT TO authenticated
USING (
  profile_id = (SELECT auth.uid())
  OR private.can_manage_roster(team_id, (SELECT auth.uid()))
  OR private.is_admin((SELECT auth.uid()))
);

DROP POLICY IF EXISTS team_athlete_memberships_select ON public.team_athlete_memberships;
CREATE POLICY team_athlete_memberships_select
ON public.team_athlete_memberships FOR SELECT TO authenticated
USING (
  private.can_view_athlete_identity(athlete_id)
  OR private.can_manage_roster(team_id, (SELECT auth.uid()))
  OR private.is_admin((SELECT auth.uid()))
);

COMMENT ON TYPE public.team_staff_role IS
  'Closed account-level staff roles. Athlete is intentionally excluded.';
COMMENT ON TABLE public.team_staff_memberships IS
  'Parallel account-level staff membership foundation. Legacy team_memberships remains authoritative until cutover.';
COMMENT ON TABLE public.team_athlete_memberships IS
  'Parallel durable-athlete roster foundation. Legacy team_memberships remains authoritative until cutover.';

COMMIT;
