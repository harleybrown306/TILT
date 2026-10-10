BEGIN;

-- public.team_memberships remains the authoritative staff membership ledger.
-- The canonical table is a same-UUID compatibility mirror for existing
-- dashboard readers and canonical one-argument authorization helpers.
-- Lock the parent first so a concurrent team delete cannot hold public.teams
-- while waiting for the membership lock this migration already holds.
LOCK TABLE public.teams,
           public.team_memberships,
           public.team_staff_memberships
  IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION private.reconcile_team_staff_memberships()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  -- This function may be invoked independently for repair. Lock parent to
  -- child, matching parent deletion, so it cannot hold a child lock while
  -- waiting for a team lock held by a concurrent delete.
  LOCK TABLE public.teams,
             public.team_memberships,
             public.team_staff_memberships
    IN SHARE ROW EXCLUSIVE MODE;

  -- A row that claims to represent an authoritative staff UUID must be an
  -- exact mapping. Correcting it silently would destroy the only evidence of
  -- an inconsistent historical mapping.
  IF EXISTS (
    SELECT 1
    FROM public.team_staff_memberships AS staff
    JOIN public.team_memberships AS legacy ON legacy.id = staff.id
    WHERE legacy.role IN ('coach'::public.team_member_role, 'assistant_coach'::public.team_member_role)
      AND (
        staff.team_id IS DISTINCT FROM legacy.team_id
        OR staff.profile_id IS DISTINCT FROM legacy.user_id
        OR staff.role IS DISTINCT FROM legacy.role::text::public.team_staff_role
        OR staff.created_by_profile_id IS DISTINCT FROM legacy.created_by_user_id
        OR staff.created_at IS DISTINCT FROM legacy.created_at
      )
  ) THEN
    RAISE EXCEPTION 'Canonical staff membership mapping is inconsistent';
  END IF;

  -- Matching a staff member by team/profile under a different UUID violates
  -- the deterministic identity boundary and must be repaired deliberately.
  IF EXISTS (
    SELECT 1
    FROM public.team_staff_memberships AS staff
    JOIN public.team_memberships AS legacy
      ON legacy.team_id = staff.team_id
     AND legacy.user_id = staff.profile_id
     AND legacy.role IN ('coach'::public.team_member_role, 'assistant_coach'::public.team_member_role)
    WHERE staff.id <> legacy.id
  ) THEN
    RAISE EXCEPTION 'Canonical staff membership UUID does not match authoritative legacy membership';
  END IF;

  -- Rows without an authoritative staff UUID are stale. This includes an
  -- old staff row after a role change to athlete or a legacy-row removal.
  DELETE FROM public.team_staff_memberships AS staff
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.team_memberships AS legacy
    WHERE legacy.id = staff.id
      AND legacy.role IN ('coach'::public.team_member_role, 'assistant_coach'::public.team_member_role)
  );

  -- The UUID comes from the authoritative legacy row. Intentionally no
  -- conflict handler exists: any conflict is an invariant violation.
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
  LEFT JOIN public.team_staff_memberships AS staff ON staff.id = legacy.id
  WHERE legacy.role IN ('coach'::public.team_member_role, 'assistant_coach'::public.team_member_role)
    AND staff.id IS NULL;

  -- Check both directions after reconciliation. This catches missing rows,
  -- stale rows, and attribute changes that would otherwise look like parity.
  IF EXISTS (
    SELECT legacy.id,
           legacy.team_id,
           legacy.user_id AS profile_id,
           legacy.role::text::public.team_staff_role AS role,
           legacy.created_by_user_id AS created_by_profile_id,
           legacy.created_at
    FROM public.team_memberships AS legacy
    WHERE legacy.role IN ('coach'::public.team_member_role, 'assistant_coach'::public.team_member_role)
    EXCEPT
    SELECT staff.id,
           staff.team_id,
           staff.profile_id,
           staff.role,
           staff.created_by_profile_id,
           staff.created_at
    FROM public.team_staff_memberships AS staff
  ) OR EXISTS (
    SELECT staff.id,
           staff.team_id,
           staff.profile_id,
           staff.role,
           staff.created_by_profile_id,
           staff.created_at
    FROM public.team_staff_memberships AS staff
    EXCEPT
    SELECT legacy.id,
           legacy.team_id,
           legacy.user_id AS profile_id,
           legacy.role::text::public.team_staff_role AS role,
           legacy.created_by_user_id AS created_by_profile_id,
           legacy.created_at
    FROM public.team_memberships AS legacy
    WHERE legacy.role IN ('coach'::public.team_member_role, 'assistant_coach'::public.team_member_role)
  ) THEN
    RAISE EXCEPTION 'Canonical staff membership mirror parity validation failed';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION private.sync_team_staff_membership_mirror()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_row_count bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.role IN ('coach'::public.team_member_role, 'assistant_coach'::public.team_member_role) THEN
      INSERT INTO public.team_staff_memberships (
        id, team_id, profile_id, role, created_by_profile_id, created_at
      ) VALUES (
        NEW.id,
        NEW.team_id,
        NEW.user_id,
        NEW.role::text::public.team_staff_role,
        NEW.created_by_user_id,
        NEW.created_at
      );
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.role IN ('coach'::public.team_member_role, 'assistant_coach'::public.team_member_role)
       AND NEW.role IN ('coach'::public.team_member_role, 'assistant_coach'::public.team_member_role) THEN
      UPDATE public.team_staff_memberships AS staff
      SET team_id = NEW.team_id,
          profile_id = NEW.user_id,
          role = NEW.role::text::public.team_staff_role,
          created_by_profile_id = NEW.created_by_user_id,
          created_at = NEW.created_at
      WHERE staff.id = OLD.id
        AND staff.team_id = OLD.team_id
        AND staff.profile_id = OLD.user_id
        AND staff.role = OLD.role::text::public.team_staff_role
        AND staff.created_by_profile_id IS NOT DISTINCT FROM OLD.created_by_user_id
        AND staff.created_at = OLD.created_at;
      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      IF v_row_count <> 1 THEN
        RAISE EXCEPTION 'Canonical staff membership mirror is missing or inconsistent for legacy membership %', OLD.id;
      END IF;
    ELSIF OLD.role IN ('coach'::public.team_member_role, 'assistant_coach'::public.team_member_role) THEN
      DELETE FROM public.team_staff_memberships AS staff
      WHERE staff.id = OLD.id
        AND staff.team_id = OLD.team_id
        AND staff.profile_id = OLD.user_id
        AND staff.role = OLD.role::text::public.team_staff_role
        AND staff.created_by_profile_id IS NOT DISTINCT FROM OLD.created_by_user_id
        AND staff.created_at = OLD.created_at;
      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      IF v_row_count <> 1 THEN
        RAISE EXCEPTION 'Canonical staff membership mirror is missing or inconsistent for legacy membership %', OLD.id;
      END IF;
    ELSIF NEW.role IN ('coach'::public.team_member_role, 'assistant_coach'::public.team_member_role) THEN
      INSERT INTO public.team_staff_memberships (
        id, team_id, profile_id, role, created_by_profile_id, created_at
      ) VALUES (
        NEW.id,
        NEW.team_id,
        NEW.user_id,
        NEW.role::text::public.team_staff_role,
        NEW.created_by_user_id,
        NEW.created_at
      );
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.role IN ('coach'::public.team_member_role, 'assistant_coach'::public.team_member_role) THEN
    DELETE FROM public.team_staff_memberships AS staff
    WHERE staff.id = OLD.id
      AND staff.team_id = OLD.team_id
      AND staff.profile_id = OLD.user_id
      AND staff.role = OLD.role::text::public.team_staff_role
      AND staff.created_by_profile_id IS NOT DISTINCT FROM OLD.created_by_user_id
      AND staff.created_at = OLD.created_at;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    -- A team delete removes canonical staff in its BEFORE trigger so the
    -- restrictive canonical FK does not block the legacy cascade. By the time
    -- this AFTER DELETE trigger runs, the parent is gone. Direct legacy staff
    -- removal must still fail closed if its exact canonical row is absent.
    IF v_row_count <> 1
       AND EXISTS (
         SELECT 1 FROM public.teams AS team WHERE team.id = OLD.team_id
       ) THEN
      RAISE EXCEPTION 'Canonical staff membership mirror is missing or inconsistent for legacy membership %', OLD.id;
    END IF;
  END IF;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION private.cleanup_team_staff_memberships_before_team_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  -- Serialize the legacy mutation path before taking canonical mirror rows.
  -- The parent row is already locked by DELETE FROM public.teams; these child
  -- locks complete the parent -> legacy -> canonical order used by repair.
  LOCK TABLE public.team_memberships,
             public.team_staff_memberships
    IN SHARE ROW EXCLUSIVE MODE;

  -- Keep the existing restrictive FK: clear only the database-maintained
  -- mirror before a legitimate parent delete cascades legacy memberships.
  DELETE FROM public.team_staff_memberships
  WHERE team_id = OLD.id;
  RETURN OLD;
END;
$function$;

ALTER FUNCTION private.reconcile_team_staff_memberships() OWNER TO postgres;
ALTER FUNCTION private.sync_team_staff_membership_mirror() OWNER TO postgres;
ALTER FUNCTION private.cleanup_team_staff_memberships_before_team_delete() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.reconcile_team_staff_memberships() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.sync_team_staff_membership_mirror() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.cleanup_team_staff_memberships_before_team_delete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS team_memberships_sync_staff_mirror ON public.team_memberships;
CREATE TRIGGER team_memberships_sync_staff_mirror
AFTER INSERT OR UPDATE OR DELETE ON public.team_memberships
FOR EACH ROW EXECUTE FUNCTION private.sync_team_staff_membership_mirror();

DROP TRIGGER IF EXISTS teams_cleanup_staff_mirror ON public.teams;
CREATE TRIGGER teams_cleanup_staff_mirror
BEFORE DELETE ON public.teams
FOR EACH ROW EXECUTE FUNCTION private.cleanup_team_staff_memberships_before_team_delete();

SELECT private.reconcile_team_staff_memberships();

-- Current dashboard readers stay read-only, but their staff-manager branch is
-- evaluated through the canonical current-actor helpers. The legacy table is
-- not a fallback authorization source for either canonical membership reader.
DROP POLICY IF EXISTS team_staff_memberships_select ON public.team_staff_memberships;
CREATE POLICY team_staff_memberships_select
ON public.team_staff_memberships FOR SELECT TO authenticated
USING (
  profile_id = (SELECT auth.uid())
  OR private.can_manage_roster(team_id)
  OR private.is_admin((SELECT auth.uid()))
);

DROP POLICY IF EXISTS team_athlete_memberships_select ON public.team_athlete_memberships;
CREATE POLICY team_athlete_memberships_select
ON public.team_athlete_memberships FOR SELECT TO authenticated
USING (
  private.can_view_athlete_identity(athlete_id)
  OR private.can_manage_roster(team_id)
  OR private.is_admin((SELECT auth.uid()))
);

COMMIT;
