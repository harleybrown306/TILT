BEGIN;

-- Run only after the Preview application using the service-only wrappers has
-- been deployed and validated. This migration intentionally has no app-code
-- compatibility fallback.
DO $preflight$
BEGIN
  IF to_regprocedure('public.server_get_team_invitation_summary(uuid,text,text)') IS NULL
     OR to_regprocedure('public.server_get_family_team_invitation_summary(uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'Expected compatibility-phase server summary wrappers are missing';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc AS procedure
    WHERE procedure.oid IN (
      'public.server_get_team_invitation_summary(uuid,text,text)'::regprocedure,
      'public.server_get_family_team_invitation_summary(uuid,text,text)'::regprocedure
    )
      AND (
        NOT procedure.prosecdef
        OR NOT (coalesce(procedure.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=""']::text[])
        OR pg_get_userbyid(procedure.proowner) <> 'postgres'
        OR NOT has_function_privilege('service_role', procedure.oid, 'EXECUTE')
        OR has_function_privilege('public', procedure.oid, 'EXECUTE')
        OR has_function_privilege('anon', procedure.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
      )
  ) THEN
    RAISE EXCEPTION 'Compatibility-phase server summary wrapper privilege boundary is incorrect';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_team_invitation_summary(text)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_family_team_invitation_summary(text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'Legacy authenticated summary access was already removed';
  END IF;
END;
$preflight$;

REVOKE ALL ON FUNCTION public.get_team_invitation_summary(text), public.get_family_team_invitation_summary(text)
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
