BEGIN;

-- Group membership is a durable training-subject relationship.  The legacy
-- profile subject can only be translated through the preserved legacy roster
-- membership UUID, never through UUID equality or a profile relationship.
LOCK TABLE public.team_group_memberships,
           public.team_groups,
           public.team_memberships,
           public.team_athlete_memberships
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
BEGIN
  IF EXISTS (
    WITH mapped AS (
      SELECT
        membership.id,
        group_row.team_id AS group_team_id,
        legacy_roster.id AS legacy_roster_id,
        durable_roster.id AS durable_roster_id,
        durable_roster.team_id AS durable_team_id,
        durable_roster.athlete_id
      FROM public.team_group_memberships AS membership
      LEFT JOIN public.team_groups AS group_row
        ON group_row.id = membership.team_group_id
      LEFT JOIN public.team_memberships AS legacy_roster
        ON legacy_roster.team_id = group_row.team_id
       AND legacy_roster.user_id = membership.athlete_user_id
       AND legacy_roster.role = 'athlete'::public.team_member_role
      LEFT JOIN public.team_athlete_memberships AS durable_roster
        ON durable_roster.id = legacy_roster.id
       AND durable_roster.team_id = group_row.team_id
    )
    SELECT 1
    FROM mapped
    GROUP BY id
    HAVING count(*) <> 1
       OR count(legacy_roster_id) <> 1
       OR count(durable_roster_id) <> 1
       OR count(athlete_id) <> 1
       OR bool_or(group_team_id IS NULL OR durable_team_id IS DISTINCT FROM group_team_id)
  ) THEN
    RAISE EXCEPTION
      'Cannot map legacy team group memberships to exactly one same-team durable roster athlete';
  END IF;

  -- A valid one-to-one legacy mapping must not collapse distinct rows into one
  -- durable group membership before the new uniqueness constraint is created.
  IF EXISTS (
    SELECT 1
    FROM public.team_group_memberships AS membership
    JOIN public.team_groups AS group_row
      ON group_row.id = membership.team_group_id
    JOIN public.team_memberships AS legacy_roster
      ON legacy_roster.team_id = group_row.team_id
     AND legacy_roster.user_id = membership.athlete_user_id
     AND legacy_roster.role = 'athlete'::public.team_member_role
    JOIN public.team_athlete_memberships AS durable_roster
      ON durable_roster.id = legacy_roster.id
     AND durable_roster.team_id = group_row.team_id
    GROUP BY membership.team_group_id, durable_roster.athlete_id
    HAVING count(*) <> 1
  ) THEN
    RAISE EXCEPTION
      'Legacy team group memberships would collapse into duplicate durable athlete memberships';
  END IF;
END;
$preflight$;

ALTER TABLE public.team_group_memberships
  ADD COLUMN team_id uuid,
  ADD COLUMN athlete_id uuid;

UPDATE public.team_group_memberships AS membership
SET
  team_id = group_row.team_id,
  athlete_id = durable_roster.athlete_id
FROM public.team_groups AS group_row,
     public.team_memberships AS legacy_roster,
     public.team_athlete_memberships AS durable_roster
WHERE group_row.id = membership.team_group_id
  AND legacy_roster.team_id = group_row.team_id
  AND legacy_roster.user_id = membership.athlete_user_id
  AND legacy_roster.role = 'athlete'::public.team_member_role
  AND durable_roster.id = legacy_roster.id
  AND durable_roster.team_id = group_row.team_id;

DO $backfill_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.team_group_memberships AS membership
    LEFT JOIN public.team_groups AS group_row
      ON group_row.id = membership.team_group_id
    LEFT JOIN public.team_athlete_memberships AS durable_roster
      ON durable_roster.team_id = membership.team_id
     AND durable_roster.athlete_id = membership.athlete_id
    WHERE membership.team_id IS NULL
       OR membership.athlete_id IS NULL
       OR membership.team_id IS DISTINCT FROM group_row.team_id
       OR durable_roster.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Durable team group membership backfill did not preserve same-team roster containment';
  END IF;
END;
$backfill_guard$;

ALTER TABLE public.team_groups
  ADD CONSTRAINT team_groups_id_team_id_unique UNIQUE (id, team_id);

ALTER TABLE public.team_group_memberships
  ALTER COLUMN team_id SET NOT NULL,
  ALTER COLUMN athlete_id SET NOT NULL,
  ADD CONSTRAINT team_group_memberships_athlete_id_fkey
    FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE RESTRICT,
  ADD CONSTRAINT team_group_memberships_group_team_fkey
    FOREIGN KEY (team_group_id, team_id)
    REFERENCES public.team_groups(id, team_id) ON DELETE CASCADE,
  ADD CONSTRAINT team_group_memberships_team_athlete_fkey
    FOREIGN KEY (team_id, athlete_id)
    REFERENCES public.team_athlete_memberships(team_id, athlete_id) ON DELETE RESTRICT,
  ADD CONSTRAINT team_group_memberships_group_athlete_unique
    UNIQUE (team_group_id, athlete_id);

CREATE INDEX team_group_memberships_team_athlete_idx
  ON public.team_group_memberships(team_id, athlete_id);

DROP POLICY team_group_memberships_insert_roster_manager
  ON public.team_group_memberships;
DROP POLICY team_group_memberships_delete_roster_manager
  ON public.team_group_memberships;

CREATE POLICY team_group_memberships_insert_roster_manager
ON public.team_group_memberships
FOR INSERT TO authenticated
WITH CHECK (
  created_by_user_id = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1
    FROM public.team_groups AS group_row
    JOIN public.team_athlete_memberships AS roster
      ON roster.team_id = group_row.team_id
     AND roster.athlete_id = team_group_memberships.athlete_id
    WHERE group_row.id = team_group_memberships.team_group_id
      AND group_row.team_id = team_group_memberships.team_id
      AND private.can_manage_roster(group_row.team_id, (SELECT auth.uid()))
  )
);

CREATE POLICY team_group_memberships_delete_roster_manager
ON public.team_group_memberships
FOR DELETE TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.team_groups AS group_row
    WHERE group_row.id = team_group_memberships.team_group_id
      AND group_row.team_id = team_group_memberships.team_id
      AND private.can_manage_roster(group_row.team_id, (SELECT auth.uid()))
  )
);

-- SELF selects the capability when SELF and GUARDIAN coexist for one
-- profile/athlete. Scalar subqueries intentionally fail closed if corruption
-- somehow permits duplicate active rows of one role.
CREATE OR REPLACE FUNCTION private.can_manage_athlete_identity(p_athlete_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT coalesce(
    (
      SELECT relationship.manage_permission
      FROM public.athlete_profile_relationships AS relationship
      WHERE relationship.athlete_id = p_athlete_id
        AND relationship.profile_id = (SELECT auth.uid())
        AND relationship.role = 'self'
        AND relationship.revoked_at IS NULL
    ),
    (
      SELECT relationship.manage_permission
      FROM public.athlete_profile_relationships AS relationship
      WHERE relationship.athlete_id = p_athlete_id
        AND relationship.profile_id = (SELECT auth.uid())
        AND relationship.role = 'guardian'
        AND relationship.revoked_at IS NULL
    ),
    false
  );
$function$;

CREATE OR REPLACE FUNCTION private.can_act_for_training(p_athlete_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT coalesce(
    (
      SELECT relationship.training_permission
      FROM public.athlete_profile_relationships AS relationship
      WHERE relationship.athlete_id = p_athlete_id
        AND relationship.profile_id = (SELECT auth.uid())
        AND relationship.role = 'self'
        AND relationship.revoked_at IS NULL
    ),
    (
      SELECT relationship.training_permission
      FROM public.athlete_profile_relationships AS relationship
      WHERE relationship.athlete_id = p_athlete_id
        AND relationship.profile_id = (SELECT auth.uid())
        AND relationship.role = 'guardian'
        AND relationship.revoked_at IS NULL
    ),
    false
  );
$function$;

ALTER TABLE public.team_group_memberships
  DROP COLUMN athlete_user_id;

DO $final_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.team_group_memberships AS membership
    LEFT JOIN public.team_groups AS group_row
      ON group_row.id = membership.team_group_id
     AND group_row.team_id = membership.team_id
    LEFT JOIN public.team_athlete_memberships AS roster
      ON roster.team_id = membership.team_id
     AND roster.athlete_id = membership.athlete_id
    WHERE group_row.id IS NULL OR roster.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Durable team group membership containment invariant failed';
  END IF;
END;
$final_guard$;

COMMIT;
