BEGIN;

-- Phase 11B.6C.2C: canonical result creation is exclusively the reviewed
-- public.complete_my_training_session SECURITY DEFINER boundary. Ordinary
-- clients must not write a result row directly.
DROP POLICY workout_results_insert ON public.workout_results;

-- Revoke table and column privileges so no inherited or residual ordinary
-- client grant can bypass the absent INSERT policy. postgres and service_role
-- retain their existing internal authority; no public RPC is changed here.
REVOKE INSERT ON public.workout_results
  FROM PUBLIC, anon, authenticated;
REVOKE INSERT (
  id,
  training_session_id,
  athlete_id,
  athlete_user_id,
  started_at,
  completed_at,
  active_minutes,
  total_duration_minutes,
  exercises_completed,
  notes,
  result_data,
  created_at,
  updated_at
) ON public.workout_results
  FROM PUBLIC, anon, authenticated;

COMMIT;
