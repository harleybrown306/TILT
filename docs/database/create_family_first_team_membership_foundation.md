# Phase 11B.3 — Family-First Team Membership Foundation

`create_family_first_team_membership_foundation.sql` is the additive Phase 11B.3 migration record, applied to Supabase project `bikkjyvoldegbltragzn` as migration `20260916172109_create_family_first_team_membership_foundation`. It creates parallel roster foundations only; `public.team_memberships` remains authoritative for every existing application flow, RLS helper, trigger, invitation, group, assignment, attendance, analytics, and historical-training behavior.

## New membership model

- `public.team_staff_memberships` contains authenticated account identities only: `team_id`, `profile_id`, `role`, creator attribution, and timestamps.
- `public.team_athlete_memberships` contains durable athlete identities only: `team_id`, `athlete_id`, creator attribution, and timestamps.
- `public.team_staff_role` is a dedicated enum with `coach` and `assistant_coach`. It deliberately cannot represent `athlete`, avoiding the legacy overloaded role model.

Both tables retain the legacy membership UUID during backfill. That gives a deterministic temporary correspondence without changing the legacy row or making an old foreign key point to a new table.

## Foreign keys and roster lifecycle

All team, profile, and athlete identity references use `ON DELETE RESTRICT`; creator attribution uses `ON DELETE SET NULL`. Removing a current roster membership should remain a hard deletion in a future authorized roster workflow, as it is today: membership is current-roster authorization, while assignments, sessions, results, prescriptions, attempts, and events retain history independently. No lifecycle column is added now because no new write/removal workflow exists and a parallel history model would be misleading.

## Backfill guard

Before creating any athlete roster rows, the migration counts legacy `role = 'athlete'` rows without a same-UUID `public.athletes` row. It raises a clear exception rather than creating a replacement athlete. Neither backfill uses `ON CONFLICT`; an unexpected membership UUID, team/identity uniqueness, or other integrity conflict fails the transaction rather than silently producing incomplete parity. It then maps:

- legacy `coach` → staff `coach`
- legacy `assistant_coach` → staff `assistant_coach`
- legacy `athlete` → team athlete membership using the existing athlete UUID

## New-table RLS

Both tables have RLS enabled. Authenticated users receive SELECT only; there are no INSERT, UPDATE, or DELETE grants or policies.

- Staff may read their own staff row. Legacy roster managers and platform admins may read team staff rows for support/transition visibility.
- An active self/guardian relationship may read its athlete’s roster row. Legacy roster managers and platform admins may read team athlete rows.

No one becomes staff because they are a guardian, athlete, or platform admin. Admin visibility is read-only and does not create a staff row or grant a new write path. Future staff and roster writes require separately designed, authorized RPC/invitation workflows.

## Current legacy dependency inventory

The current `private.is_team_member`, `private.is_team_athlete`, `private.is_team_coach`, `private.can_manage_team`, and `private.can_manage_roster` helpers all read `public.team_memberships`. `private.handle_new_team` inserts a legacy coach row. Existing team creation, roster actions, team groups and group membership checks, multi-recipient assignments, team attendance/analytics, athlete detail/history, workout coaching access, invitations, and team dashboard pages query the legacy table directly. This migration does not alter any of them.

## External validation

Run [validate_family_first_team_membership_foundation.sql](../../tests/database/validate_family_first_team_membership_foundation.sql) in an isolated Supabase SQL transaction. It is rollback-only and requires three existing profiles, a platform admin, and an existing team. It validates parallel backfill, cardinality, non-write RLS, guardian/admin behavior, and a parent-managed athlete with no profile.

Applied validation confirmed exact UUID parity for all legacy staff and athlete memberships, unchanged counts for every legacy and historical table, and no direct authenticated INSERT, UPDATE, or DELETE access. It also confirmed that guardians and self-linked athletes cannot attach an athlete to an arbitrary team, and that platform-admin read visibility does not create staff authority.
