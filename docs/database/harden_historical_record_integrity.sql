BEGIN;

REVOKE TRUNCATE ON public.training_sessions, public.workout_results
  FROM authenticated, anon;

REVOKE UPDATE ON public.workout_results FROM authenticated, anon;
REVOKE UPDATE (
  id, training_session_id, athlete_user_id, started_at, completed_at,
  active_minutes, total_duration_minutes, exercises_completed,
  notes, result_data, created_at, updated_at
) ON public.workout_results FROM authenticated, anon;

DROP POLICY workout_results_update ON public.workout_results;

COMMIT;
