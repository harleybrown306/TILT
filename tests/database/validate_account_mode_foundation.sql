-- Run only after the account-mode foundation migration on a disposable local
-- Supabase-compatible database. This test rolls back both its fixtures and
-- assertions; it must never be run against a persistent or remote database.
BEGIN;

DO $validation$
DECLARE
  v_profile_id uuid := gen_random_uuid();
  v_marker text := 'account-mode-foundation-' || replace(gen_random_uuid()::text, '-', '');
  v_assigned_at timestamptz;
  v_rejected boolean := false;
  v_updated_rows integer;
  v_helper regprocedure;
  v_guard regprocedure;
  v_helper_owner name;
BEGIN
  IF (
    SELECT count(*)
    FROM pg_catalog.pg_roles
    WHERE rolname IN ('anon', 'authenticated', 'service_role')
  ) <> 3 THEN
    RAISE EXCEPTION 'Supabase application roles are missing';
  END IF;
  IF to_regtype('public.account_mode') IS NULL THEN
    RAISE EXCEPTION 'Account-mode enum is missing';
  END IF;
  IF (
    SELECT array_agg(enumlabel ORDER BY enumsortorder)
    FROM pg_catalog.pg_enum
    WHERE enumtypid = 'public.account_mode'::regtype
  ) <> ARRAY['family', 'coaching'] THEN
    RAISE EXCEPTION 'Account-mode enum labels are incorrect';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
      AND column_name = 'account_mode'
      AND udt_schema = 'public'
      AND udt_name = 'account_mode'
      AND is_nullable = 'YES'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
      AND column_name = 'account_mode_assigned_at'
      AND data_type = 'timestamp with time zone'
      AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'Profile account-mode columns are missing or not transition-nullable';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'profiles_account_mode_assignment_consistent'
      AND conrelid = 'public.profiles'::regclass
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'Account-mode paired-assignment constraint is missing';
  END IF;
  IF to_regprocedure('private.protect_profile_account_mode()') IS NULL
     OR to_regprocedure('private.assign_profile_account_mode(uuid,public.account_mode)') IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger
       WHERE tgrelid = 'public.profiles'::regclass
         AND tgname = 'profiles_protect_account_mode'
         AND NOT tgisinternal
     ) THEN
    RAISE EXCEPTION 'Account-mode mutation boundary is missing';
  END IF;
  v_guard := 'private.protect_profile_account_mode()'::regprocedure;
  v_helper := 'private.assign_profile_account_mode(uuid,public.account_mode)'::regprocedure;

  -- The helper must run with a role the trigger explicitly permits. The
  -- migration intentionally does not take ownership of pre-existing objects,
  -- so this catches a nonstandard migration executor before deployment.
  SELECT role.rolname
    INTO v_helper_owner
  FROM pg_catalog.pg_proc AS function
  JOIN pg_catalog.pg_roles AS role ON role.oid = function.proowner
  WHERE function.oid = v_helper::oid;
  IF v_helper_owner NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Account-mode helper owner % is not an approved migration role', v_helper_owner;
  END IF;
  IF NOT COALESCE((
    SELECT function.prosecdef
    FROM pg_catalog.pg_proc AS function
    WHERE function.oid = v_helper::oid
  ), false) THEN
    RAISE EXCEPTION 'Account-mode helper is not SECURITY DEFINER';
  END IF;
  IF (
    SELECT function.proconfig
    FROM pg_catalog.pg_proc AS function
    WHERE function.oid = v_helper::oid
  ) IS DISTINCT FROM ARRAY['search_path=""']::text[] THEN
    RAISE EXCEPTION 'Account-mode helper does not have the fixed empty search_path';
  END IF;
  IF (
    SELECT function.proconfig
    FROM pg_catalog.pg_proc AS function
    WHERE function.oid = v_guard::oid
  ) IS DISTINCT FROM ARRAY['search_path=""']::text[] THEN
    RAISE EXCEPTION 'Account-mode trigger guard does not have the fixed empty search_path';
  END IF;

  -- private is not an API schema. Authenticated and service roles retain
  -- USAGE for existing private RLS helpers, but none of the application roles
  -- may create there or execute either account-mode boundary function.
  IF to_regnamespace('private') IS NULL THEN
    RAISE EXCEPTION 'Private schema is missing';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS namespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
    ) AS privilege(grantor oid, grantee oid, privilege_type text, is_grantable boolean)
    WHERE namespace.oid = 'private'::regnamespace
      AND privilege.grantee = 0
      AND privilege.privilege_type IN ('USAGE', 'CREATE')
  ) OR has_schema_privilege('anon', 'private', 'USAGE')
    OR has_schema_privilege('anon', 'private', 'CREATE')
    OR NOT has_schema_privilege('authenticated', 'private', 'USAGE')
    OR NOT has_schema_privilege('service_role', 'private', 'USAGE')
    OR has_schema_privilege('authenticated', 'private', 'CREATE')
    OR has_schema_privilege('service_role', 'private', 'CREATE') THEN
    RAISE EXCEPTION 'Private schema usage or create privileges are incorrect';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
    ) AS privilege(grantor oid, grantee oid, privilege_type text, is_grantable boolean)
    WHERE function.oid IN (v_helper::oid, v_guard::oid)
      AND privilege.privilege_type = 'EXECUTE'
      AND (
        privilege.grantee = 0
        OR privilege.grantee IN (
          SELECT role.oid
          FROM pg_catalog.pg_roles AS role
          WHERE role.rolname IN ('anon', 'authenticated', 'service_role')
        )
      )
  ) OR has_function_privilege('anon', v_helper, 'EXECUTE')
    OR has_function_privilege('authenticated', v_helper, 'EXECUTE')
    OR has_function_privilege('service_role', v_helper, 'EXECUTE')
    OR has_function_privilege('anon', v_guard, 'EXECUTE')
    OR has_function_privilege('authenticated', v_guard, 'EXECUTE')
    OR has_function_privilege('service_role', v_guard, 'EXECUTE') THEN
    RAISE EXCEPTION 'Account-mode boundary has a PUBLIC or application-role execute grant';
  END IF;

  -- These table and column grants deliberately remain broad for current
  -- profile behavior. The trigger, rather than ACL revocation, must stop mode
  -- metadata writes for both client and server application roles.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.profiles'::regclass
      AND relation.relrowsecurity
  ) OR NOT has_table_privilege('authenticated', 'public.profiles', 'SELECT')
    OR NOT has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
    OR NOT has_table_privilege('service_role', 'public.profiles', 'UPDATE')
    OR has_table_privilege('anon', 'public.profiles', 'SELECT')
    OR has_table_privilege('anon', 'public.profiles', 'UPDATE')
    OR NOT has_column_privilege('authenticated', 'public.profiles', 'account_mode', 'UPDATE')
    OR NOT has_column_privilege('authenticated', 'public.profiles', 'account_mode_assigned_at', 'UPDATE')
    OR NOT has_column_privilege('service_role', 'public.profiles', 'account_mode', 'UPDATE')
    OR NOT has_column_privilege('service_role', 'public.profiles', 'account_mode_assigned_at', 'UPDATE') THEN
    RAISE EXCEPTION 'Profile table or account-mode column ACL prerequisites are incorrect';
  END IF;

  INSERT INTO auth.users (
    id, aud, role, email, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) VALUES (
    v_profile_id, 'authenticated', 'authenticated', v_marker || '@example.test',
    pg_catalog.clock_timestamp(), '{}'::jsonb, '{}'::jsonb,
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
  );

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = v_profile_id
      AND account_mode IS NULL
      AND account_mode_assigned_at IS NULL
  ) THEN
    RAISE EXCEPTION 'New profile was assigned an account mode implicitly';
  END IF;

  -- SET LOCAL ROLE plus request.jwt.claim.sub mirrors the database role and
  -- JWT claims applied by Supabase PostgREST for an authenticated caller.
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_profile_id::text, true);
  v_rejected := false;
  BEGIN
    UPDATE public.profiles
    SET account_mode = 'family'::public.account_mode
    WHERE id = v_profile_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'Authenticated profile owner could write account_mode directly';
  END IF;
  v_rejected := false;
  BEGIN
    UPDATE public.profiles
    SET account_mode_assigned_at = pg_catalog.clock_timestamp()
    WHERE id = v_profile_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'Authenticated profile owner could write assignment metadata directly';
  END IF;
  v_rejected := false;
  BEGIN
    UPDATE public.profiles
    SET account_mode = 'family'::public.account_mode,
        account_mode_assigned_at = pg_catalog.clock_timestamp()
    WHERE id = v_profile_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'Authenticated profile owner could write the account-mode pair directly';
  END IF;
  UPDATE public.profiles
  SET full_name = v_marker
  WHERE id = v_profile_id;
  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
  IF v_updated_rows <> 1 THEN
    RAISE EXCEPTION 'Authenticated profile owner could not perform an ordinary profile update';
  END IF;
  v_rejected := false;
  BEGIN
    PERFORM private.assign_profile_account_mode(v_profile_id, 'family'::public.account_mode);
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'Authenticated role could execute private account-mode helper';
  END IF;
  EXECUTE 'RESET ROLE';

  -- service_role is privileged for ordinary server work and bypasses RLS, so
  -- this proves the trigger boundary is not accidentally limited to RLS.
  EXECUTE 'SET LOCAL ROLE service_role';
  v_rejected := false;
  BEGIN
    UPDATE public.profiles
    SET account_mode = 'family'::public.account_mode
    WHERE id = v_profile_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'service_role could write account_mode directly';
  END IF;
  v_rejected := false;
  BEGIN
    UPDATE public.profiles
    SET account_mode_assigned_at = pg_catalog.clock_timestamp()
    WHERE id = v_profile_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'service_role could write assignment metadata directly';
  END IF;
  v_rejected := false;
  BEGIN
    UPDATE public.profiles
    SET account_mode = 'family'::public.account_mode,
        account_mode_assigned_at = pg_catalog.clock_timestamp()
    WHERE id = v_profile_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'service_role could write the account-mode pair directly';
  END IF;
  v_rejected := false;
  BEGIN
    PERFORM private.assign_profile_account_mode(v_profile_id, 'family'::public.account_mode);
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'service_role could execute private account-mode helper';
  END IF;
  EXECUTE 'RESET ROLE';

  PERFORM private.assign_profile_account_mode(v_profile_id, 'family'::public.account_mode);
  SELECT account_mode_assigned_at
    INTO v_assigned_at
  FROM public.profiles
  WHERE id = v_profile_id AND account_mode = 'family'::public.account_mode;
  IF v_assigned_at IS NULL THEN
    RAISE EXCEPTION 'Private helper did not atomically assign Family mode';
  END IF;

  -- The helper uses a transaction-local setting. Clear it before testing that
  -- no direct privileged update can reuse the helper's authority accidentally.
  PERFORM pg_catalog.set_config('tilt.account_mode_assignment', '', true);
  v_rejected := false;
  BEGIN
    UPDATE public.profiles
    SET account_mode = 'coaching'::public.account_mode,
        account_mode_assigned_at = pg_catalog.clock_timestamp()
    WHERE id = v_profile_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'Direct privileged profile mode transition was accepted';
  END IF;

  PERFORM private.assign_profile_account_mode(v_profile_id, 'family'::public.account_mode);
  IF (SELECT account_mode_assigned_at FROM public.profiles WHERE id = v_profile_id) <> v_assigned_at THEN
    RAISE EXCEPTION 'Same-mode retry changed the original assignment timestamp';
  END IF;

  v_rejected := false;
  BEGIN
    PERFORM private.assign_profile_account_mode(v_profile_id, 'coaching'::public.account_mode);
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'Private helper allowed a Family-to-Coaching transition';
  END IF;

  PERFORM pg_catalog.set_config('tilt.account_mode_assignment', 'private.assign_profile_account_mode', true);
  v_rejected := false;
  BEGIN
    UPDATE public.profiles
    SET account_mode = NULL,
        account_mode_assigned_at = pg_catalog.clock_timestamp()
    WHERE id = v_profile_id;
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'Account-mode paired-assignment constraint accepted partial state';
  END IF;
END;
$validation$;

ROLLBACK;
