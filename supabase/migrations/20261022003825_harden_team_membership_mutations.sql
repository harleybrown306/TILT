BEGIN;

-- public.team_memberships remains the authoritative write boundary for staff
-- until a separately reviewed cutover. The canonical staff table is an
-- AFTER-triggered mirror, so authorization must reject an invalid legacy row
-- before it can acquire canonical staff authority.
--
-- Platform admins may manage every membership role. A coach may manage only
-- assistant-coach and athlete rows in a team where they are a canonical coach.
-- An assistant coach may manage only athlete rows in a team where they are
-- canonical staff. The UPDATE policy evaluates this matrix once for the old
-- row (USING) and once for the resulting row (WITH CHECK).
DROP POLICY IF EXISTS memberships_insert_roster_manager ON public.team_memberships;
DROP POLICY IF EXISTS memberships_update_roster_manager ON public.team_memberships;
DROP POLICY IF EXISTS memberships_delete_roster_manager ON public.team_memberships;

CREATE POLICY memberships_insert_roster_manager
ON public.team_memberships
FOR INSERT
TO authenticated
WITH CHECK (
  private.is_admin((SELECT auth.uid()))
  OR (
    created_by_user_id = (SELECT auth.uid())
    AND (
      (
        private.is_team_coach(team_id)
        AND role IN ('assistant_coach'::public.team_member_role, 'athlete'::public.team_member_role)
      )
      OR (
        private.is_team_staff(team_id)
        AND role = 'athlete'::public.team_member_role
      )
    )
  )
);

CREATE POLICY memberships_update_roster_manager
ON public.team_memberships
FOR UPDATE
TO authenticated
USING (
  private.is_admin((SELECT auth.uid()))
  OR (
    private.is_team_coach(team_id)
    AND role IN ('assistant_coach'::public.team_member_role, 'athlete'::public.team_member_role)
  )
  OR (
    private.is_team_staff(team_id)
    AND role = 'athlete'::public.team_member_role
  )
)
WITH CHECK (
  private.is_admin((SELECT auth.uid()))
  OR (
    private.is_team_coach(team_id)
    AND role IN ('assistant_coach'::public.team_member_role, 'athlete'::public.team_member_role)
  )
  OR (
    private.is_team_staff(team_id)
    AND role = 'athlete'::public.team_member_role
  )
);

CREATE POLICY memberships_delete_roster_manager
ON public.team_memberships
FOR DELETE
TO authenticated
USING (
  private.is_admin((SELECT auth.uid()))
  OR (
    private.is_team_coach(team_id)
    AND role IN ('assistant_coach'::public.team_member_role, 'athlete'::public.team_member_role)
  )
  OR (
    private.is_team_staff(team_id)
    AND role = 'athlete'::public.team_member_role
  )
);

COMMIT;
