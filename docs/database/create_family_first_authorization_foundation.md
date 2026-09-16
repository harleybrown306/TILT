# Phase 11B.4 — Family-First Authorization Foundation

`create_family_first_authorization_foundation.sql` is the additive Phase 11B.4 authorization-helper record, applied to Supabase project `bikkjyvoldegbltragzn` as migration `20260916173350_create_family_first_authorization_foundation`. It adds current-actor canonical helper overloads beside existing legacy helpers and does not modify any policy, RPC, trigger, application query, or historical-training table.

## Canonical helpers

| Helper | Meaning |
|---|---|
| `private.is_team_staff(team_id)` | Current profile is coach or assistant coach for the team. |
| `private.is_team_coach(team_id)` | Current profile is the team’s coach. |
| `private.can_manage_team(team_id)` | Current profile is coach; this is team-level authority. |
| `private.can_manage_roster(team_id)` | Current profile is coach or assistant coach. |
| `private.can_manage_team_staff(team_id)` | Current profile is coach. |
| `private.can_view_team_analytics(team_id)` | Current staff profile or explicit platform-admin support visibility. |
| `private.can_assign_team_athlete_training(team_id, athlete_id)` | Current roster manager and the durable athlete is rostered on that team. |
| `private.is_athlete_on_team(team_id, athlete_id)` | Internal durable-athlete roster lookup; no authenticated execute grant. |
| `private.can_view_athlete(athlete_id)` | Current actor has active family visibility, new-team staff/roster scope, or platform-admin support visibility. |
| `private.can_manage_athlete(athlete_id)` | Current actor has an active relationship with `manage_permission`; never team staff or admin alone. |
| `private.can_act_for_training(athlete_id)` | Current actor has active self/guardian relationship with `training_permission`; never team staff or admin alone. |

## Capability semantics

**View** permits active self/guardian relationships, new-table staff membership when the athlete is rostered on that staff member’s team, and explicit admin support visibility.

**Manage** applies only to athlete identity/family settings. It requires active `manage_permission`; it does not follow from team staff, team analytics access, or platform administration.

**Act for training** requires active `training_permission`. Self and guardians may qualify; viewing and identity management do not themselves qualify. Coaches and platform admins never qualify merely through those roles.

## Team authority

Team authority always follows `auth.uid() -> team_staff_memberships.profile_id`. Team-athlete targeting follows `team_athlete_memberships.athlete_id`. Coach manages team/staff; coach or assistant manages roster and may assign only a rostered athlete. No helper infers athlete identity from a profile UUID.

## Admin

Admin is explicit support/read visibility only in `can_view_athlete` and `can_view_team_analytics`. It neither creates a relationship nor satisfies athlete management, training action, team staff, team management, roster management, or assignment authority.

## Security-definer decision

Helpers use `SECURITY DEFINER` with `SET search_path TO ''`, matching current private authorization conventions and allowing safe future RLS use without recursive policy evaluation. Current actor identity is always sourced internally from `auth.uid()`. The sole helper that accepts an athlete identity independent of the actor (`is_athlete_on_team`) has no authenticated execute grant; all current-actor helpers have only authenticated execute grants. No dynamic SQL is used.

## Legacy dependency inventory

Legacy `private.is_team_member`, `is_team_athlete`, `is_team_coach(team_id, user_id)`, `can_manage_team(team_id, user_id)`, `can_manage_roster(team_id, user_id)`, and `handle_new_team` continue to depend on `team_memberships`. Existing RLS uses those helpers for memberships, groups, sessions/results, events, attempts, assignments, and invitations. Server/UI consumers include training-plan helpers, roster/team pages, groups, assignment routes, attendance/analytics, training session access, athlete detail/history, Resume, and invitation workflow. Phase 11B.4 does not redirect any of them.

## External validation

Run [validate_family_first_authorization_foundation.sql](../../tests/database/validate_family_first_authorization_foundation.sql) in an isolated Supabase SQL transaction. It is rollback-only and validates current-actor derivation, family relationships, team staff scope, team athlete identity, parent-managed athletes, admin limits, and revoked relationships.

Applied validation confirmed the VIEW, MANAGE, and ACT-FOR-TRAINING boundaries across self, guardians, staff, assistant coaches, unrelated profiles, and platform admins. It also confirmed revoked relationships lose authority, parent-managed athletes need no profile, internal identity/team lookup is not authenticated-callable, and validation fixtures leave no persistent rows.
