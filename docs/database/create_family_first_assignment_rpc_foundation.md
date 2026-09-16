# Phase 11B.6B.1 — Canonical Family-First Assignment RPC Foundation

`create_family_first_assignment_rpc_foundation.sql` is a local, unapplied migration record. It intentionally changes no application writer yet.

## RPC

`public.assign_my_team_training(p_batch_id uuid, p_team_id uuid, p_training_plan_id uuid, p_start_date date, p_notes text, p_athlete_ids uuid[]) RETURNS TABLE(batch_id uuid, recipient_count integer)`.

The function is `SECURITY DEFINER`, has fixed empty `search_path`, derives the actor only from `auth.uid()`, rejects unauthenticated calls, uses no dynamic SQL, revokes all public/anon/authenticated execution first, then grants only `authenticated` execution.

For a **new** batch it validates an active private coach-owned plan, normalizes/deduplicates durable recipients, and checks `private.can_assign_team_athlete_training(team_id, athlete_id)` for every target before inserting anything. Guardians, self relationships, admins, templates, VIEW, MANAGE, and ACT permissions do not independently authorize assignment.

## Transactionality and idempotency

A transaction-scoped advisory lock serializes retries for the caller-supplied batch UUID. A fresh call creates the batch and all assignment rows in the same transaction; the existing assignment trigger creates all sessions and the existing session trigger creates immutable prescriptions. Any failure rolls all of it back.

An existing key is first matched against the original actor, team, plan, start date, normalized notes, writer marker, and normalized durable recipient set. It returns success only after proving all assignments retain the batch’s ownership/provenance fields, every current plan item has exactly one correctly linked/generated session, no unexpected generated session exists, and every generated session has exactly one matching immutable `session_created` prescription for its workout. Missing/corrupt materialization raises `Assignment idempotency integrity failure`; the RPC never repairs it.

That complete exact retry is intentionally independent of later mutable plan/archive or staff/roster changes. It creates nothing, and only the original actor can acknowledge it. A new batch always rechecks current plan lifecycle and team authority. A changed request under an existing key raises an idempotency conflict. No `ON CONFLICT DO NOTHING` is used.

## Compatibility and ownership

Assignments always receive their requested durable `athlete_id`. The optional `athlete_user_id` is set only for an active same-UUID self relationship whose UUID exists in `auth.users`; it is never copied from the coach/guardian actor. A no-auth child and an athlete with a distinct later login receive `NULL` compatibility identity.

The migration makes only assignment/session legacy owner columns nullable. Both gain an owner-presence CHECK requiring at least one owner column. `athlete_id` remains nullable for old-app compatibility. Results and attempts remain unchanged.

The assignment generator now copies both ownership fields into sessions. Its direct `EXECUTE` privilege is explicitly revoked from `PUBLIC`, `anon`, and `authenticated`; the existing postgres-owned `SECURITY DEFINER` trigger still invokes it. The prescription trigger remains unchanged because it derives ownership through the session. Old app assignment inserts still provide legacy owner with `athlete_id NULL`, satisfy the owner-presence checks, and generate legacy sessions/prescriptions. Direct authenticated session insert is restricted to that same legacy shape so an arbitrary durable athlete UUID cannot be supplied outside the RPC/trigger boundary.

## Expected validation

The rollback-only validation creates self and no-auth-child fixtures, verifies canonical ownership propagation and prescription capture, isolated guardian/admin assignment denials, complete and corrupt same-key retries, retries after authority revocation/plan archive, authenticated direct-session RLS behavior, old-path assignment/session trigger compatibility, ownership constraints, historical count preservation, grants, and no persisted fixtures. Controlled corruption is created only as postgres inside the rollback transaction because normal product paths intentionally cannot mutate immutable prescription/history records. It must run only after external review/application.
