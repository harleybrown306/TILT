BEGIN;

CREATE TABLE public.workout_session_events (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL
    CONSTRAINT workout_session_events_session_id_fkey
    REFERENCES public.training_sessions(id) ON DELETE RESTRICT,
  attempt_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 0),
  event_type text NOT NULL CHECK (event_type IN (
    'workout_started', 'exercise_started', 'exercise_completed',
    'exercise_skipped', 'rest_started', 'rest_completed', 'rest_skipped',
    'timer_paused', 'timer_resumed', 'page_hidden', 'page_visible',
    'workout_completed'
  )),
  workout_exercise_id uuid,
  step_position integer CHECK (step_position >= 0),
  phase text NOT NULL CHECK (phase IN ('ready', 'work', 'rest', 'finished')),
  phase_duration_ms bigint CHECK (phase_duration_ms >= 0),
  phase_elapsed_ms bigint CHECK (phase_elapsed_ms >= 0),
  elapsed_ms bigint NOT NULL CHECK (elapsed_ms >= 0),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (session_id, attempt_id, sequence),
  CHECK (
    (workout_exercise_id IS NULL AND step_position IS NULL)
    OR (workout_exercise_id IS NOT NULL AND step_position IS NOT NULL)
  ),
  CHECK (
    phase NOT IN ('work', 'rest')
    OR (
      workout_exercise_id IS NOT NULL
      AND phase_duration_ms IS NOT NULL
      AND phase_elapsed_ms IS NOT NULL
      AND phase_elapsed_ms <= phase_duration_ms
    )
  ),
  CHECK (
    event_type NOT IN ('exercise_started','exercise_completed','exercise_skipped')
    OR phase = 'work'
  ),
  CHECK (
    event_type NOT IN ('rest_started','rest_completed','rest_skipped')
    OR phase = 'rest'
  ),
  CHECK (event_type <> 'workout_started' OR phase = 'ready'),
  CHECK (event_type <> 'workout_completed' OR phase = 'finished'),
  CHECK (
    event_type NOT IN ('timer_paused','timer_resumed')
    OR phase IN ('work','rest')
  )
);

-- Cross-session receipt-time reads; no retention cleanup is introduced.
CREATE INDEX workout_session_events_created_at_idx
  ON public.workout_session_events (created_at);

ALTER TABLE public.workout_session_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workout_session_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.workout_session_events TO authenticated;
GRANT INSERT (
  id, session_id, attempt_id, sequence, event_type, workout_exercise_id,
  step_position, phase, phase_duration_ms, phase_elapsed_ms,
  elapsed_ms, occurred_at
) ON public.workout_session_events TO authenticated;

CREATE POLICY workout_session_events_select
ON public.workout_session_events FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.training_sessions ts
    WHERE ts.id = workout_session_events.session_id
  )
);

CREATE POLICY workout_session_events_insert
ON public.workout_session_events FOR INSERT TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.training_sessions ts
    WHERE ts.id = workout_session_events.session_id
      AND ts.athlete_user_id = (SELECT auth.uid())
      AND (
        workout_session_events.workout_exercise_id IS NULL
        OR EXISTS (
          SELECT 1 FROM public.workout_exercises we
          WHERE we.id = workout_session_events.workout_exercise_id
            AND we.workout_id = ts.workout_id
            AND we.position = workout_session_events.step_position
        )
      )
  )
  AND (
    event_type <> 'workout_completed'
    OR EXISTS (
      SELECT 1 FROM public.workout_results wr
      WHERE wr.training_session_id = workout_session_events.session_id
        AND wr.athlete_user_id = (SELECT auth.uid())
    )
  )
);

COMMIT;
