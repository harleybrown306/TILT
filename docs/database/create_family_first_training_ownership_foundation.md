# Phase 11B.5 — Family-First Training Ownership Foundation

`create_family_first_training_ownership_foundation.sql` is a **local design record only**. It has not been applied to Supabase project `bikkjyvoldegbltragzn`.

## Decision

Use an additive parallel-column transition. Add nullable `athlete_id` to the four rows that independently record durable athlete ownership:

| Table | Durable owner | Legacy column retained | New FK delete action |
|---|---|---|---|
| `training_plan_assignments` | assignment recipient | `athlete_user_id` | `athletes(id) ON DELETE RESTRICT` |
| `training_sessions` | session athlete | `athlete_user_id` | `athletes(id) ON DELETE RESTRICT` |
| `workout_results` | canonical result athlete | `athlete_user_id` | `athletes(id) ON DELETE RESTRICT` |
| `workout_session_attempts` | interpreted attempt athlete | `athlete_user_id` | `athletes(id) ON DELETE RESTRICT` |

The migration first rejects any legacy owner without a corresponding `public.athletes` row, rejects a pre-existing mismatch, backfills by UUID, then verifies exact parity. It intentionally has no `ON CONFLICT` suppression and no automatic athlete creation.

`athlete_id` remains nullable during transition because all current writers supply only non-null `athlete_user_id`. Making it `NOT NULL` now would break assignment creation, session-generation triggers, canonical completion, and the attempt RPC. No compatibility trigger is proposed: a trigger would conceal missing dual-write cutover work and couple old authenticated-user writes to family identity before authorization/context is designed.

No equality CHECK between the two columns is installed. Exact parity is required for legacy rows at migration time, but a permanent equality rule would prevent the later parent-managed-athlete transition. The legacy `athlete_user_id` constraints still mean that this foundation alone cannot create a complete training row for an athlete without an auth account; that needs a later coordinated writer/constraint/RLS cutover.

## Ownership dependency map and classifications

| Location | Current identity assumption | Classification | Phase 11B.5 action |
|---|---|---|---|
| `training_plan_assignments.athlete_user_id` | recipient auth user | A, athlete owner | parallel `athlete_id` |
| `training_plan_assignments.assigned_by_user_id` | assigning authenticated profile | D, provenance | retain |
| `training_assignment_batches.assigned_by_user_id` | batch creator | D, provenance | retain; no athlete column |
| `training_sessions.athlete_user_id` | session owner | A, athlete owner | parallel `athlete_id` |
| `training_sessions.coach_user_id` | coach attribution | C/D, staff/provenance | retain |
| `workout_results.athlete_user_id` | canonical result owner | A, athlete owner | parallel `athlete_id` |
| `workout_session_attempts.athlete_user_id` | materialized attempt owner | A, athlete owner | parallel `athlete_id` |
| `workout_session_events.session_id` / `attempt_id` | append-only event’s owner is parent session/attempt | derived A | no redundant athlete column |
| `training_session_prescriptions.session_id` | immutable prescription’s owner is parent session | derived A | no redundant athlete column |
| `auth.uid()` in player, event endpoint, RPCs and RLS | logged-in person who acts | B, actor | retain until future `can_act_for_training(athlete_id)` cutover |
| `training_sessions.coach_user_id`, batch creator and assignment creator | authenticated staff/history attribution | C/D | retain |

The event table’s unique `(session_id, attempt_id, sequence)` and the prescription table’s one-row-per-session FK remain canonical ownership chains. Duplicating athlete identity there risks disagreement without a query or integrity benefit.

## Existing integrity and deletion chains

Existing historical FKs remain untouched: sessions restrict assignment/team/auth-user deletion; results restrict session/auth-user deletion; attempts restrict session/result/auth-user deletion; events and prescriptions restrict session deletion. The new athlete FKs are also `RESTRICT`. No CASCADE is added. Existing unique result-per-session, attempt-per-result, event sequence, and prescription-per-session constraints remain unchanged.

## Current write paths and effect

- Coach assignment action writes `training_plan_assignments.athlete_user_id`; its database automation generates sessions. Nullable new columns leave this structurally usable.
- Athlete player writes canonical `workout_results.athlete_user_id` after verifying session ownership; no change.
- Event endpoint and event RLS authorize through `training_sessions.athlete_user_id`; events themselves carry no owner column; no change.
- `register_my_workout_session_attempt` and `finalize_my_workout_session_attempt` derive identity from the current session/auth user and write/read `workout_session_attempts.athlete_user_id`; no change.
- Existing training-session prescription capture trigger, attendance/adherence, Resume, athlete dashboard, coach history, team analytics, and group/assignment selectors retain legacy identifiers and query shape; no change.
- Browser IndexedDB uses `Bundle.userId`, the `users` object-store key, checkpoint `userId`, `flushEvents(userId, ...)`, and completed-delivery `userId`; it is authenticated-account partitioning today, not durable athlete partitioning.

## Later consumer cutover

A later coordinated phase must dual-write each proposed column, select active athlete context, and transition authorization from `athlete_user_id = auth.uid()` to `athlete_id = active athlete context` plus `private.can_act_for_training(athlete_id)` for acting or `private.can_view_athlete(athlete_id)` for read. Team assignment must use `private.can_assign_team_athlete_training(team_id, athlete_id)`. RLS, RPCs, session-generation trigger, completion flow, endpoint, dashboards, analytics, and IndexedDB/outbox must cut over together before legacy nullability/FKs are relaxed or removed.

The offline partition must become athlete-scoped (for example `athleteId` in bundle/checkpoint keys) while retaining a separately verified actor identity. This is required so one guardian account cannot mix Jack’s outbox/checkpoint with Luke’s after switching active athlete.

Potential future actor fields such as `started_by_profile_id`, `completed_by_profile_id`, or `recorded_by_profile_id` should wait. Existing rows cannot supply trustworthy values, and Phase 11B.5 needs no new actor provenance to preserve ownership.

## Why not repoint `athlete_user_id`

Directly repointing legacy FKs would change RLS, RPC identity checks, application selects/inserts, browser recovery keys, historical auth-user semantics, and parent-managed behavior at once. It also gives no clean rollback point. Parallel ownership isolates the database backfill and durable FK addition while preserving every established login-bound path.

## External validation

Run [validate_family_first_training_ownership_foundation.sql](../../tests/database/validate_family_first_training_ownership_foundation.sql) only after an eventual application. It uses `BEGIN` / `ROLLBACK`, verifies parity/counts/FK metadata/delete actions/legacy constraints, and makes no persistent fixture data.
