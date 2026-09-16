BEGIN;

-- Canonical sessions are generated only by the postgres-owned
-- SECURITY DEFINER assignment trigger. Ordinary authenticated clients no
-- longer create sessions directly.
DROP POLICY training_sessions_insert ON public.training_sessions;

REVOKE INSERT ON TABLE public.training_sessions
  FROM PUBLIC, anon, authenticated;

COMMIT;
