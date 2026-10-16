# Account-mode foundation

This first implementation slice adds the database state needed for mutually
exclusive Family and Coaching accounts without changing an existing route,
invitation flow, team workflow, or profile's current behavior.

## What the migration establishes

`public.profiles` receives two initially nullable fields:

- `account_mode`: `family` or `coaching` once the profile has been resolved.
- `account_mode_assigned_at`: assigned atomically with the mode.

The paired-state check prevents a timestamp without a mode or vice versa. A
profile-mode trigger rejects direct changes, including changes made through the
existing self-profile update policy. The only writer is
`private.assign_profile_account_mode(uuid, public.account_mode)`, which has a
fixed empty search path, locks the profile row, is idempotent for the same mode,
rejects a mode transition, and has no `anon`, `authenticated`, `service_role`,
or `PUBLIC` execute grant.

No existing profile is assigned a mode by this migration. It creates no
households, PINs, selector, Director/Training Studio behavior, routing change,
invitation mutation, or automatic backfill.

## Preflight and validation

[account_mode_preflight_audit.sql](../../tests/database/account_mode_preflight_audit.sql)
is an aggregate-only `BEGIN TRANSACTION READ ONLY` report for an approved
read-only clone or disposable database. It reports profile evidence as
Family, Coaching, unresolved, or mixed/manual-review; it also detects pending
cross-mode invitation conflicts and a pending invitation that conflicts with a
verified existing account's inferred mode.

[validate_account_mode_foundation.sql](../../tests/database/validate_account_mode_foundation.sql)
is a rollback-only disposable-database validator. It verifies the helper's
approved owner, `SECURITY DEFINER` flag, exact empty `search_path`, private
schema and function ACLs, and the relevant `profiles` table/column ACL
preconditions. It then simulates Supabase's `authenticated` role plus a JWT
subject and the `service_role` database role: each is denied direct writes to
both account-mode fields and direct helper execution, while the authenticated
profile owner can still update an ordinary profile field. It also checks
one-time Family assignment, same-mode retry stability, transition denial, and
the paired-state constraint.

## Required review gate before the next slice

1. Run the preflight only on an approved read-only clone or disposable target;
   do not use a persistent local or production database for validation.
2. Review every `mixed_manual_review`, unresolved profile, and cross-mode
   pending-invitation conflict. No automatic policy should decide these rows.
3. Approve the exact backfill eligibility rules and the remediation path for
   people who need separate Family and Coaching accounts.
4. Only then integrate narrowly authorized Family and Coaching workflow
   boundaries that call the private assignment helper and gate their existing
   mutation paths.
