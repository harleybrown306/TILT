BEGIN;

-- Phase 11B.6C.1 is structural only.  The current self-athlete writers,
-- policies, registration RPC, finalizer, telemetry, and completion trigger
-- remain unchanged.  A future no-auth athlete needs a NULL compatibility
-- auth-user reference, while every row must still name either its durable or
-- legacy subject.
ALTER TABLE public.workout_results
  ALTER COLUMN athlete_user_id DROP NOT NULL,
  ADD CONSTRAINT workout_results_owner_present
    CHECK (athlete_id IS NOT NULL OR athlete_user_id IS NOT NULL);

ALTER TABLE public.workout_session_attempts
  ALTER COLUMN athlete_user_id DROP NOT NULL,
  ADD CONSTRAINT workout_session_attempts_owner_present
    CHECK (athlete_id IS NOT NULL OR athlete_user_id IS NOT NULL);

-- Bind the requested session to its durable athlete before asking the existing
-- relationship helper about the current actor.  This is internal policy/RPC
-- infrastructure: callers cannot supply an actor and no client execute grant
-- is needed for a private helper used by database objects.
CREATE OR REPLACE FUNCTION private.can_act_for_training_session(p_session_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.training_sessions AS session
    WHERE session.id = p_session_id
      AND session.athlete_id IS NOT NULL
      AND private.can_act_for_training(session.athlete_id)
  );
$function$;

REVOKE ALL ON FUNCTION private.can_act_for_training_session(uuid)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION private.can_act_for_training_session(uuid) IS
  'Internal session-scoped ACT authorization. Derives auth.uid() through can_act_for_training and never grants execution authority to staff or admins.';

COMMENT ON COLUMN public.workout_results.athlete_user_id IS
  'Optional legacy authenticated-athlete compatibility reference. Durable subject is athlete_id.';
COMMENT ON COLUMN public.workout_session_attempts.athlete_user_id IS
  'Optional legacy authenticated-athlete compatibility reference. Durable subject is athlete_id.';

COMMIT;
