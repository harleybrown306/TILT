BEGIN;

ALTER TABLE public.workout_results DROP CONSTRAINT workout_results_training_session_id_fkey;
ALTER TABLE public.workout_results ADD CONSTRAINT workout_results_training_session_id_fkey
  FOREIGN KEY (training_session_id) REFERENCES public.training_sessions(id) ON DELETE RESTRICT;

ALTER TABLE public.training_sessions DROP CONSTRAINT training_sessions_assignment_id_fkey;
ALTER TABLE public.training_sessions ADD CONSTRAINT training_sessions_assignment_id_fkey
  FOREIGN KEY (assignment_id) REFERENCES public.training_plan_assignments(id) ON DELETE RESTRICT;

ALTER TABLE public.training_sessions DROP CONSTRAINT training_sessions_team_id_fkey;
ALTER TABLE public.training_sessions ADD CONSTRAINT training_sessions_team_id_fkey
  FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE RESTRICT;

ALTER TABLE public.training_sessions DROP CONSTRAINT training_sessions_athlete_user_id_fkey;
ALTER TABLE public.training_sessions ADD CONSTRAINT training_sessions_athlete_user_id_fkey
  FOREIGN KEY (athlete_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

ALTER TABLE public.workout_results DROP CONSTRAINT workout_results_athlete_user_id_fkey;
ALTER TABLE public.workout_results ADD CONSTRAINT workout_results_athlete_user_id_fkey
  FOREIGN KEY (athlete_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

DROP POLICY training_sessions_delete ON public.training_sessions;
DROP POLICY workout_results_delete ON public.workout_results;
REVOKE DELETE ON public.training_sessions, public.workout_results FROM authenticated;

COMMIT;
