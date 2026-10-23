-- Execute only against a disposable local database after both invitation
-- summary privacy migrations. This validator is rollback-only.
BEGIN;

DO $validation$
DECLARE
  v_denied boolean;
  v_rows bigint;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc AS procedure
    WHERE procedure.oid IN (
      'public.get_team_invitation_summary(text)'::regprocedure,
      'public.get_family_team_invitation_summary(text)'::regprocedure
    ) AND (
      has_function_privilege('public', procedure.oid, 'EXECUTE')
      OR has_function_privilege('anon', procedure.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
      OR has_function_privilege('service_role', procedure.oid, 'EXECUTE')
    )
  ) THEN
    RAISE EXCEPTION 'Finalization left a direct invitation-summary execute grant exposed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc AS procedure
    WHERE procedure.oid IN (
      'public.server_get_team_invitation_summary(uuid,text,text)'::regprocedure,
      'public.server_get_family_team_invitation_summary(uuid,text,text)'::regprocedure
    ) AND (
      NOT procedure.prosecdef
      OR NOT (coalesce(procedure.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=""']::text[])
      OR pg_get_userbyid(procedure.proowner) <> 'postgres'
      OR NOT has_function_privilege('service_role', procedure.oid, 'EXECUTE')
      OR has_function_privilege('public', procedure.oid, 'EXECUTE')
      OR has_function_privilege('anon', procedure.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
    )
  ) THEN
    RAISE EXCEPTION 'Final server invitation-summary wrapper boundary is incorrect';
  END IF;

  v_denied := false;
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.get_team_invitation_summary(repeat('a', 64));
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  EXECUTE 'RESET ROLE';
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Authenticated still executed the legacy team summary';
  END IF;

  v_denied := false;
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM public.get_family_team_invitation_summary(repeat('b', 64));
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  EXECUTE 'RESET ROLE';
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Anon still executed the legacy family summary';
  END IF;

  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT count(*) INTO v_rows
  FROM public.server_get_team_invitation_summary(NULL, NULL, repeat('c', 64));
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'Invalid server-wrapper arguments returned a result';
  END IF;
  EXECUTE 'RESET ROLE';
END;
$validation$;

ROLLBACK;
