BEGIN;

-- Phase 11B.6B.1 establishes a dual-path database boundary. Legacy assignment
-- inserts remain valid; the canonical RPC below is the only durable-subject
-- writer. Results, attempts, player, telemetry, and read paths are unchanged.

ALTER TABLE public.training_plan_assignments
  ALTER COLUMN athlete_user_id DROP NOT NULL,
  ADD CONSTRAINT training_plan_assignments_owner_present
    CHECK (athlete_id IS NOT NULL OR athlete_user_id IS NOT NULL);
ALTER TABLE public.training_sessions
  ALTER COLUMN athlete_user_id DROP NOT NULL,
  ADD CONSTRAINT training_sessions_owner_present
    CHECK (athlete_id IS NOT NULL OR athlete_user_id IS NOT NULL);

-- Keep the existing generator and plan-item ordering, but copy both subject
-- fields. Old app assignments have athlete_id NULL and continue to work.
CREATE OR REPLACE FUNCTION private.generate_sessions_for_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  INSERT INTO public.training_sessions (
    assignment_id, plan_item_id, athlete_id, athlete_user_id, coach_user_id,
    team_id, workout_id, scheduled_date, scheduled_time, status
  )
  SELECT NEW.id, item.id, NEW.athlete_id, NEW.athlete_user_id,
         NEW.assigned_by_user_id, NEW.team_id, item.workout_id,
         NEW.start_date + item.day_offset, item.scheduled_time,
         'scheduled'::public.training_session_status
  FROM public.training_plan_items AS item
  WHERE item.training_plan_id = NEW.training_plan_id
  ORDER BY item.day_offset, item.position;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.generate_sessions_for_assignment()
  FROM PUBLIC, anon, authenticated;

-- Direct session creation is legacy-only during this phase. Canonical durable
-- sessions are created by the SECURITY DEFINER assignment trigger, never by an
-- authenticated client choosing an athlete UUID.
DROP POLICY training_sessions_insert ON public.training_sessions;
CREATE POLICY training_sessions_insert
ON public.training_sessions FOR INSERT TO authenticated
WITH CHECK (
  athlete_id IS NULL
  AND athlete_user_id IS NOT NULL
  AND (
    private.is_team_coach(team_id, (SELECT auth.uid()))
    OR private.is_admin((SELECT auth.uid()))
  )
);

CREATE OR REPLACE FUNCTION public.assign_my_team_training(
  p_batch_id uuid,
  p_team_id uuid,
  p_training_plan_id uuid,
  p_start_date date,
  p_notes text,
  p_athlete_ids uuid[]
)
RETURNS TABLE (batch_id uuid, recipient_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_athlete_ids uuid[];
  v_notes text := NULLIF(btrim(p_notes), '');
  v_snapshot jsonb;
  v_existing public.training_assignment_batches;
  v_existing_ids uuid[];
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_batch_id IS NULL OR p_team_id IS NULL OR p_training_plan_id IS NULL OR p_start_date IS NULL THEN
    RAISE EXCEPTION 'Assignment request is incomplete';
  END IF;

  SELECT coalesce(array_agg(DISTINCT athlete_id ORDER BY athlete_id), ARRAY[]::uuid[])
  INTO v_athlete_ids
  FROM unnest(coalesce(p_athlete_ids, ARRAY[]::uuid[])) AS recipient(athlete_id);
  IF cardinality(v_athlete_ids) = 0 THEN
    RAISE EXCEPTION 'At least one athlete is required';
  END IF;

  v_snapshot := jsonb_build_object(
    'writer', 'family_first_assignment_rpc_v1',
    'resolved_unique_athlete_ids', to_jsonb(v_athlete_ids)
  );

  -- Serialize concurrent retries of the same caller-provided batch key before
  -- inspecting or creating the batch; conflicts are compared explicitly.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_batch_id::text, 0));

  -- Existing batches are checked before mutable current plan or roster state.
  -- A matching complete write belongs to its original actor and is safe to
  -- acknowledge after a later archive or staff/roster change; it never creates
  -- new work. Any semantic mismatch or incomplete materialization is rejected.
  SELECT batch.* INTO v_existing
  FROM public.training_assignment_batches AS batch
  WHERE batch.id = p_batch_id
  FOR UPDATE;

  IF FOUND THEN
    SELECT coalesce(array_agg(assignment.athlete_id ORDER BY assignment.athlete_id), ARRAY[]::uuid[])
    INTO v_existing_ids
    FROM public.training_plan_assignments AS assignment
    WHERE assignment.assignment_batch_id = p_batch_id;

    IF v_existing.assigned_by_user_id IS DISTINCT FROM v_actor
       OR v_existing.team_id IS DISTINCT FROM p_team_id
       OR v_existing.training_plan_id IS DISTINCT FROM p_training_plan_id
       OR v_existing.start_date IS DISTINCT FROM p_start_date
       OR v_existing.notes IS DISTINCT FROM v_notes
       OR v_existing.selection_snapshot IS DISTINCT FROM v_snapshot
       OR v_existing_ids IS DISTINCT FROM v_athlete_ids
    THEN
      RAISE EXCEPTION 'Assignment idempotency conflict';
    END IF;

    -- An idempotent acknowledgement proves the original transaction fully
    -- materialized assignments, generated sessions, and immutable snapshots.
    -- It never attempts to repair a damaged historical write.
    IF EXISTS (
      SELECT 1
      FROM public.training_plan_assignments AS assignment
      WHERE assignment.assignment_batch_id = p_batch_id
        AND (
          assignment.team_id IS DISTINCT FROM v_existing.team_id
          OR assignment.training_plan_id IS DISTINCT FROM v_existing.training_plan_id
          OR assignment.assigned_by_user_id IS DISTINCT FROM v_existing.assigned_by_user_id
          OR assignment.start_date IS DISTINCT FROM v_existing.start_date
          OR assignment.notes IS DISTINCT FROM v_existing.notes
          OR assignment.athlete_id IS NULL
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.training_plan_assignments AS assignment
      JOIN public.training_plan_items AS item
        ON item.training_plan_id = assignment.training_plan_id
      LEFT JOIN public.training_sessions AS session
        ON session.assignment_id = assignment.id
       AND session.plan_item_id = item.id
      WHERE assignment.assignment_batch_id = p_batch_id
      GROUP BY assignment.id, item.id, assignment.athlete_id,
               assignment.athlete_user_id, assignment.assigned_by_user_id,
               assignment.team_id, assignment.start_date, item.workout_id,
               item.day_offset, item.scheduled_time
      HAVING count(session.id) <> 1
          OR bool_or(
            session.assignment_id IS DISTINCT FROM assignment.id
            OR session.athlete_id IS DISTINCT FROM assignment.athlete_id
            OR session.athlete_user_id IS DISTINCT FROM assignment.athlete_user_id
            OR session.coach_user_id IS DISTINCT FROM assignment.assigned_by_user_id
            OR session.team_id IS DISTINCT FROM assignment.team_id
            OR session.workout_id IS DISTINCT FROM item.workout_id
            OR session.scheduled_date IS DISTINCT FROM assignment.start_date + item.day_offset
            OR session.scheduled_time IS DISTINCT FROM item.scheduled_time
          )
    )
    OR EXISTS (
      SELECT 1
      FROM public.training_sessions AS session
      JOIN public.training_plan_assignments AS assignment
        ON assignment.id = session.assignment_id
      WHERE assignment.assignment_batch_id = p_batch_id
        AND NOT EXISTS (
          SELECT 1
          FROM public.training_plan_items AS item
          WHERE item.training_plan_id = assignment.training_plan_id
            AND item.id = session.plan_item_id
        )
    )
    OR (
      SELECT count(*)
      FROM public.training_sessions AS session
      JOIN public.training_plan_assignments AS assignment
        ON assignment.id = session.assignment_id
      WHERE assignment.assignment_batch_id = p_batch_id
    ) <> (
      SELECT count(*)
      FROM public.training_plan_assignments AS assignment
      JOIN public.training_plan_items AS item
        ON item.training_plan_id = assignment.training_plan_id
      WHERE assignment.assignment_batch_id = p_batch_id
    )
    OR EXISTS (
      SELECT 1
      FROM public.training_sessions AS session
      JOIN public.training_plan_assignments AS assignment
        ON assignment.id = session.assignment_id
      LEFT JOIN public.training_session_prescriptions AS prescription
        ON prescription.session_id = session.id
      WHERE assignment.assignment_batch_id = p_batch_id
      GROUP BY session.id, session.workout_id
      HAVING count(prescription.session_id) <> 1
          OR bool_or(
            prescription.workout_id IS DISTINCT FROM session.workout_id
            OR prescription.schema_version IS DISTINCT FROM 1
            OR prescription.capture_basis IS DISTINCT FROM 'session_created'
            OR prescription.step_count <= 0
          )
    )
    THEN
      RAISE EXCEPTION 'Assignment idempotency integrity failure';
    END IF;

    RETURN QUERY SELECT v_existing.id, cardinality(v_athlete_ids);
    RETURN;
  END IF;

  -- Only a new batch is authorized against current plan lifecycle and current
  -- roster/staff authority. Revoked authority cannot create new work.
  IF NOT EXISTS (
    SELECT 1 FROM public.training_plans AS plan
    WHERE plan.id = p_training_plan_id
      AND plan.owner_user_id = v_actor
      AND plan.kind = 'coach'::public.training_plan_kind
      AND plan.visibility = 'private'::public.training_plan_visibility
      AND plan.status = 'active'::public.training_plan_status
  ) THEN
    RAISE EXCEPTION 'Assignable coach plan unavailable';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(v_athlete_ids) AS recipient(athlete_id)
    WHERE NOT private.can_assign_team_athlete_training(p_team_id, recipient.athlete_id)
  ) THEN
    RAISE EXCEPTION 'Recipient is not authorized for this team assignment';
  END IF;

  INSERT INTO public.training_assignment_batches (
    id, team_id, training_plan_id, assigned_by_user_id, start_date, notes, selection_snapshot
  ) VALUES (
    p_batch_id, p_team_id, p_training_plan_id, v_actor, p_start_date, v_notes, v_snapshot
  );

  INSERT INTO public.training_plan_assignments (
    training_plan_id, team_id, athlete_id, athlete_user_id, assigned_by_user_id,
    start_date, status, notes, assignment_batch_id
  )
  SELECT p_training_plan_id, p_team_id, recipient.athlete_id,
    CASE WHEN EXISTS (
      SELECT 1
      FROM auth.users AS legacy_user
      JOIN public.athlete_profile_relationships AS relationship
        ON relationship.profile_id = legacy_user.id
      WHERE legacy_user.id = recipient.athlete_id
        AND relationship.athlete_id = recipient.athlete_id
        AND relationship.profile_id = recipient.athlete_id
        AND relationship.role = 'self'
        AND relationship.revoked_at IS NULL
    ) THEN recipient.athlete_id ELSE NULL END,
    v_actor, p_start_date, 'active'::public.training_assignment_status,
    v_notes, p_batch_id
  FROM unnest(v_athlete_ids) AS recipient(athlete_id);

  RETURN QUERY SELECT p_batch_id, cardinality(v_athlete_ids);
END;
$function$;

REVOKE ALL ON FUNCTION public.assign_my_team_training(uuid, uuid, uuid, date, text, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_my_team_training(uuid, uuid, uuid, date, text, uuid[])
  TO authenticated;

COMMENT ON FUNCTION public.assign_my_team_training(uuid, uuid, uuid, date, text, uuid[]) IS
  'Canonical transactional team assignment. Actor derives from auth.uid(); durable athletes are independently roster-authorized.';

COMMIT;
