BEGIN;

-- Phase 11B.6C.3B.2: a public application boundary for asking only whether
-- the current authenticated actor may ACT for a session. The private helper
-- remains canonical and owns all relationship resolution.
CREATE OR REPLACE FUNCTION public.can_act_for_training_session(p_session_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT (SELECT auth.uid()) IS NOT NULL
    AND COALESCE(private.can_act_for_training_session(p_session_id), false);
$function$;

ALTER FUNCTION public.can_act_for_training_session(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.can_act_for_training_session(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_act_for_training_session(uuid)
  TO authenticated;

COMMENT ON FUNCTION public.can_act_for_training_session(uuid) IS
  'Current authenticated actor ACT capability for one training session. Returns only boolean and delegates subject/relationship authorization to the canonical private helper.';

COMMIT;
