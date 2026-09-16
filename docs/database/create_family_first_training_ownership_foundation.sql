BEGIN;

-- Phase 11B.5 adds durable athlete ownership beside legacy authenticated-user
-- ownership. It deliberately leaves legacy columns, FKs, RLS, policies, RPCs,
-- triggers, and application writers untouched for a later coordinated cutover.

ALTER TABLE public.training_plan_assignments ADD COLUMN athlete_id uuid;
ALTER TABLE public.training_sessions ADD COLUMN athlete_id uuid;
ALTER TABLE public.workout_results ADD COLUMN athlete_id uuid;
ALTER TABLE public.workout_session_attempts ADD COLUMN athlete_id uuid;

-- Do not manufacture durable athletes for historical rows. Every legacy owner
-- must already be an athlete created by Phase 11B.2's controlled backfill.
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.training_plan_assignments AS row
    LEFT JOIN public.athletes AS athlete ON athlete.id = row.athlete_user_id
    WHERE athlete.id IS NULL
  ) THEN RAISE EXCEPTION 'Training assignment legacy athlete owner has no athletes row'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.training_sessions AS row
    LEFT JOIN public.athletes AS athlete ON athlete.id = row.athlete_user_id
    WHERE athlete.id IS NULL
  ) THEN RAISE EXCEPTION 'Training session legacy athlete owner has no athletes row'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.workout_results AS row
    LEFT JOIN public.athletes AS athlete ON athlete.id = row.athlete_user_id
    WHERE athlete.id IS NULL
  ) THEN RAISE EXCEPTION 'Workout result legacy athlete owner has no athletes row'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.workout_session_attempts AS row
    LEFT JOIN public.athletes AS athlete ON athlete.id = row.athlete_user_id
    WHERE athlete.id IS NULL
  ) THEN RAISE EXCEPTION 'Workout attempt legacy athlete owner has no athletes row'; END IF;

  -- This migration is intentionally not idempotent. If it is ever replayed
  -- against pre-populated parallel columns, disagreement is an integrity error.
  IF EXISTS (SELECT 1 FROM public.training_plan_assignments WHERE athlete_id IS NOT NULL AND athlete_id <> athlete_user_id)
    OR EXISTS (SELECT 1 FROM public.training_sessions WHERE athlete_id IS NOT NULL AND athlete_id <> athlete_user_id)
    OR EXISTS (SELECT 1 FROM public.workout_results WHERE athlete_id IS NOT NULL AND athlete_id <> athlete_user_id)
    OR EXISTS (SELECT 1 FROM public.workout_session_attempts WHERE athlete_id IS NOT NULL AND athlete_id <> athlete_user_id)
  THEN RAISE EXCEPTION 'Existing parallel athlete ownership conflicts with legacy athlete owner'; END IF;
END;
$guard$;

-- Same-UUID Phase 11B.2 athletes make this deterministic. No conflict handling
-- is used: a missing or inconsistent row must abort the entire migration.
UPDATE public.training_plan_assignments SET athlete_id = athlete_user_id WHERE athlete_id IS NULL;
UPDATE public.training_sessions SET athlete_id = athlete_user_id WHERE athlete_id IS NULL;
UPDATE public.workout_results SET athlete_id = athlete_user_id WHERE athlete_id IS NULL;
UPDATE public.workout_session_attempts SET athlete_id = athlete_user_id WHERE athlete_id IS NULL;

DO $parity$
BEGIN
  IF EXISTS (SELECT 1 FROM public.training_plan_assignments WHERE athlete_id IS NULL OR athlete_id <> athlete_user_id)
    OR EXISTS (SELECT 1 FROM public.training_sessions WHERE athlete_id IS NULL OR athlete_id <> athlete_user_id)
    OR EXISTS (SELECT 1 FROM public.workout_results WHERE athlete_id IS NULL OR athlete_id <> athlete_user_id)
    OR EXISTS (SELECT 1 FROM public.workout_session_attempts WHERE athlete_id IS NULL OR athlete_id <> athlete_user_id)
  THEN RAISE EXCEPTION 'Training ownership backfill did not achieve exact legacy parity'; END IF;
END;
$parity$;

-- RESTRICT preserves Phase 1 historical-data protections: deleting an athlete
-- must never cascade into assignments, sessions, results, or attempts.
ALTER TABLE public.training_plan_assignments
  ADD CONSTRAINT training_plan_assignments_athlete_id_fkey
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE RESTRICT;
ALTER TABLE public.training_sessions
  ADD CONSTRAINT training_sessions_athlete_id_fkey
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE RESTRICT;
ALTER TABLE public.workout_results
  ADD CONSTRAINT workout_results_athlete_id_fkey
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE RESTRICT;
ALTER TABLE public.workout_session_attempts
  ADD CONSTRAINT workout_session_attempts_athlete_id_fkey
  FOREIGN KEY (athlete_id) REFERENCES public.athletes(id) ON DELETE RESTRICT;

CREATE INDEX training_plan_assignments_athlete_id_idx ON public.training_plan_assignments (athlete_id) WHERE athlete_id IS NOT NULL;
CREATE INDEX training_sessions_athlete_id_idx ON public.training_sessions (athlete_id) WHERE athlete_id IS NOT NULL;
CREATE INDEX workout_results_athlete_id_idx ON public.workout_results (athlete_id) WHERE athlete_id IS NOT NULL;
CREATE INDEX workout_session_attempts_athlete_id_idx ON public.workout_session_attempts (athlete_id) WHERE athlete_id IS NOT NULL;

COMMENT ON COLUMN public.training_plan_assignments.athlete_id IS
  'Durable athlete owner. Nullable only during the legacy athlete_user_id transition.';
COMMENT ON COLUMN public.training_sessions.athlete_id IS
  'Durable athlete owner. Nullable only during the legacy athlete_user_id transition.';
COMMENT ON COLUMN public.workout_results.athlete_id IS
  'Durable athlete owner. Nullable only during the legacy athlete_user_id transition.';
COMMENT ON COLUMN public.workout_session_attempts.athlete_id IS
  'Durable athlete owner. Nullable only during the legacy athlete_user_id transition.';

COMMIT;
