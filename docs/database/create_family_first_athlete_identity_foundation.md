# Phase 11B.2 — Family-First Athlete Identity Foundation

`create_family_first_athlete_identity_foundation.sql` is the additive Phase 11B.2 migration record, applied to Supabase project `bikkjyvoldegbltragzn` as migration `20260916165901_create_family_first_athlete_identity_foundation`. It creates no replacement for existing `athlete_user_id` columns and changes no existing application behavior, RLS, triggers, or historical records.

## New model

- `public.athletes` is the durable training subject. Its UUID is intentionally independent of `profiles`; a child athlete can therefore exist without an account or email.
- `public.athlete_profile_relationships` records the active or revoked connection between an authenticated profile and an athlete. Initial roles are `guardian` and `self`.
- Lifecycle values use constrained text, matching current database records that use checked text for states. Athlete status is `active` or `archived`; archive preserves the athlete ID and history.

## Backfill

The migration selects only profiles with at least one current `team_memberships.role = 'athlete'` row. For each selected profile UUID `X`, it creates `athletes.id = X` and an active self relationship from `X` to `X`.

It deliberately does **not** backfill coach-only profiles, admin-only profiles, or profiles with no athlete membership. Inserts use `ON CONFLICT DO NOTHING`, so rerunning the record does not rename or rewrite a previously created athlete.

Backfilled self links set both `training_permission` and `manage_permission` to `true`. A self-authenticated athlete should be able to manage their own new identity record in the future; that permission is limited to this new identity model and does not grant team staff authority, access to another athlete, or any changed authority over present training tables.

## Integrity and privacy

- `graduation_year` is optional and constrained only to `2000..2100`. This rejects obvious data-entry errors without encoding a current-year-dependent cohort range. It stores no date of birth or age.
- Active self links are unique by athlete and by profile for the current one-self-athlete product model.
- A partial unique index prevents a duplicate active `(athlete_id, profile_id, role)` link, while revoked rows remain available for audit and a later legitimate relationship.
- Athlete and profile references use `RESTRICT` where history depends on them. Creator-attribution references use `SET NULL`, preserving the athlete/relationship if an origin profile is removed by a future dedicated erasure workflow.

## RLS and write surface

- Active self/guardian links and platform admins may read an athlete. Platform admin is intentionally support/read visibility only at this foundation stage.
- A profile may read its own relationship records; only an active manage-permission relationship may read all relationship records for that athlete. Platform admin alone does not receive family-management authority or relationship visibility.
- There are no direct authenticated INSERT, UPDATE, DELETE, or revocation policies on either new table.
- `public.create_my_athlete(text, integer)` is the only public write RPC. It requires `auth.uid()`, creates a fresh athlete UUID, and creates an active guardian relationship for that same caller. It accepts no athlete ID, so it cannot attach a caller to an existing athlete.
- Private helpers are `SECURITY DEFINER`, `STABLE`, and use `SET search_path TO ''`. Their only argument is an athlete UUID; they derive the actor from `auth.uid()` internally, so authenticated callers cannot supply an arbitrary profile ID. Their execute grants are restricted to `authenticated`. The public RPC is also restricted to `authenticated`.

The record assumes the current live helper `private.is_admin(uuid)` and the current `profiles(id, full_name)` / `team_memberships(user_id, role)` shape documented by prior migrations. It intentionally does not create broad future helper families such as `can_act_for_training` or alter legacy training-table RLS.

## External validation

Run [validate_family_first_athlete_identity_foundation.sql](../../tests/database/validate_family_first_athlete_identity_foundation.sql) in an isolated Supabase SQL transaction. It begins a transaction and rolls back all fixtures. It validates backfill coverage, preservation counts, relationship cardinality/history, optional graduation year, the narrow creation RPC, and RLS identity isolation.

Applied validation confirmed the existing athlete-membership profile was backfilled once with a same-UUID athlete and active self relationship; coach-only and unaffiliated admin profiles were excluded. It also confirmed unchanged counts for existing memberships, assignments, sessions, results, attempts, and telemetry events. A separate rollback-only authenticated-access check confirmed that direct INSERT, UPDATE, and DELETE are denied on both new tables, while the narrow RPC creates a new athlete plus guardian relationship.

## Rollback

A separately reviewed rollback migration must first revoke the public RPC execute grant, drop the new RLS policies, functions, trigger, indexes, and tables. Do not delete athlete records merely to reverse a schema decision; the tables are intended to retain historical identities.
