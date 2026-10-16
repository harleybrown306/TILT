BEGIN;

-- This is an additive transition foundation. Existing profiles intentionally
-- remain unresolved until the preflight audit and reconciliation plan have
-- been reviewed; no account mode is inferred or backfilled here.
CREATE TYPE public.account_mode AS ENUM ('family', 'coaching');

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS account_mode public.account_mode,
  ADD COLUMN IF NOT EXISTS account_mode_assigned_at timestamptz;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'profiles_account_mode_assignment_consistent'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_account_mode_assignment_consistent
      CHECK (
        (account_mode IS NULL AND account_mode_assigned_at IS NULL)
        OR (account_mode IS NOT NULL AND account_mode_assigned_at IS NOT NULL)
      );
  END IF;
END;
$constraint$;

-- Do not rely on a profile UPDATE policy for this invariant: existing users
-- can update parts of their own profile. The trigger permits a mode assignment
-- only while the private, fixed-search-path helper is executing.
CREATE OR REPLACE FUNCTION private.protect_profile_account_mode()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  IF NEW.account_mode IS DISTINCT FROM OLD.account_mode
     OR NEW.account_mode_assigned_at IS DISTINCT FROM OLD.account_mode_assigned_at THEN
    IF current_user NOT IN ('postgres', 'supabase_admin')
       OR current_setting('tilt.account_mode_assignment', true)
            IS DISTINCT FROM 'private.assign_profile_account_mode' THEN
      RAISE EXCEPTION 'Account mode may only be assigned by the account-mode boundary'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.protect_profile_account_mode() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS profiles_protect_account_mode ON public.profiles;
CREATE TRIGGER profiles_protect_account_mode
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION private.protect_profile_account_mode();

-- This helper is intentionally private and has no application-role EXECUTE
-- grant. A later reviewed Family or Coaching workflow must call it from its
-- own narrowly authorized database boundary; no browser route can call it.
CREATE OR REPLACE FUNCTION private.assign_profile_account_mode(
  p_profile_id uuid,
  p_account_mode public.account_mode
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_current_mode public.account_mode;
BEGIN
  IF p_profile_id IS NULL OR p_account_mode IS NULL THEN
    RAISE EXCEPTION 'Profile and account mode are required' USING ERRCODE = '22004';
  END IF;

  SELECT profile.account_mode
    INTO v_current_mode
  FROM public.profiles AS profile
  WHERE profile.id = p_profile_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile is unavailable' USING ERRCODE = '23503';
  END IF;

  IF v_current_mode IS NOT NULL THEN
    IF v_current_mode = p_account_mode THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'Profile account mode is already assigned' USING ERRCODE = '23514';
  END IF;

  PERFORM set_config(
    'tilt.account_mode_assignment',
    'private.assign_profile_account_mode',
    true
  );

  UPDATE public.profiles
  SET account_mode = p_account_mode,
      account_mode_assigned_at = pg_catalog.clock_timestamp()
  WHERE id = p_profile_id;
END;
$function$;
REVOKE ALL ON FUNCTION private.assign_profile_account_mode(uuid, public.account_mode)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON COLUMN public.profiles.account_mode IS
  'Unset during the audited transition; once assigned, a profile is permanently Family or Coaching.';
COMMENT ON COLUMN public.profiles.account_mode_assigned_at IS
  'Timestamp set atomically with account_mode by private.assign_profile_account_mode.';
COMMENT ON FUNCTION private.assign_profile_account_mode(uuid, public.account_mode) IS
  'Private one-time account-mode assignment boundary. No application role may execute it directly.';

COMMIT;
