BEGIN;

-- Phase 11B.6C.3B.1: the authenticated role evaluates this helper directly
-- from RLS policies. Keep the oracle narrowly callable only by authenticated.
REVOKE ALL ON FUNCTION private.can_act_for_training_session(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.can_act_for_training_session(uuid)
  TO authenticated;

COMMIT;
