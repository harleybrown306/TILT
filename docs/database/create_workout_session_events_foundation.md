# Workout session telemetry foundation — Phase 2

Applied migration `create_workout_session_events_foundation`,
version `20260914205512`. Exact SQL:
[migration record](create_workout_session_events_foundation.sql).

## Database contract

workout_session_events has id/session_id/attempt_id UUIDs, sequence integer,
constrained event_type/phase text, nullable observed workout_exercise_id and
step_position, nullable phase_duration_ms/phase_elapsed_ms bigint, elapsed_ms
bigint, client occurred_at and server created_at timestamps.

session_id references training_sessions with ON DELETE RESTRICT. Identity/team
are derived through the session; neither is duplicated in the event table.
workout_exercise_id is an observed reference without an FK, preserving historical
step identity without blocking content editing or cascading event deletion.
INSERT validates the live step's workout and position.

Primary-key and session/attempt/sequence unique indexes enforce retry identity.
The unique index already supports session and attempt reads in sequence order.
The separate created_at index supports cross-session receipt-time queries and
operational investigation. No redundant session index or cleanup job was added.

RLS SELECT delegates to an EXISTS query on training_sessions, inheriting its
athlete/team-coach/assistant/admin visibility. INSERT requires the assigned
athlete; even authenticated admins cannot submit another athlete's observation.
workout_completed additionally requires an existing owned workout_result.

All ordinary PUBLIC/anon/authenticated table privileges were first revoked.
Authenticated receives SELECT and INSERT on client fields only; not created_at.
No UPDATE, DELETE or TRUNCATE grants/policies exist for ordinary roles.
No new definer helper or service-role application client was introduced.

## Event semantics and reliability

Vocabulary:

- workout_started
- exercise_started, exercise_completed, exercise_skipped
- rest_started, rest_completed, rest_skipped
- timer_paused, timer_resumed
- page_hidden, page_visible
- workout_completed

Exercise and rest completion means timer-guidance block completion, not proven
physical exercise. Skips refer to the observed step and remaining guidance time.
Visibility is context only: an athlete can lock/background the device and keep
training. Backgrounding does not pause or subtract training time.

occurred_at and elapsed fields are client observations; created_at is database
receipt time. Sequence determines attempt order independently of arrival order.
The database does not enforce a whole attempt state machine or authenticate
physical activity. Missing pairs/gaps must remain unknown rather than fabricated
continuous background/pause time. An event log is separate from shareable reports.

Canonical completion remains workout_result INSERT -> existing session trigger.
Missing telemetry does not make a completed workout incomplete. Ingestion writes
only events; it never writes results, sessions, assignments or plans.
No automatic raw-event deletion, surveillance payloads, or retention job exists.

## POST /api/workout-session-events

Uses the existing SSR-cookie Supabase client and auth.getUser().
Requires Origin to equal the request URL origin; if Sec-Fetch-Site is present it
must be same-origin. No forwarded-host trust or cross-origin cookie writes.
Deployment reverse proxies must preserve the browser-facing request origin.

Content-Type must be application/json. Body is bounded while streaming:
64 KiB maximum, 1–25 events. Unknown envelope/event fields, including created_at,
metadata, URLs and identity/device fields, are rejected. All IDs must be UUIDs.
Integer sequence/position are bounded to PostgreSQL integer range.
Timing input bounds: 30 days elapsed; 24 hours per phase. occurred_at must use
canonical UTC ISO format with milliseconds. Client clock accuracy is not implied.

Example request:

```json
{
  "events": [{
    "id": "00000000-0000-4000-8000-000000000001",
    "session_id": "00000000-0000-4000-8000-000000000002",
    "attempt_id": "00000000-0000-4000-8000-000000000003",
    "sequence": 0,
    "event_type": "workout_started",
    "phase": "ready",
    "elapsed_ms": 0,
    "occurred_at": "2026-09-14T12:00:00.000Z"
  }]
}
```

Nullable step/timer fields can be omitted and normalize to NULL.
The whole batch is structurally validated before writes. Every requested session
must be owned by the caller, even if that caller can read it as a coach.
RLS remains the final per-event write authority.

Writes use normal INSERT, with at most four concurrent operations. Per-event
acknowledgements permit partial success if an individual database check rejects
an event. The batch is not atomic.

Successful HTTP 200 response:

```json
{"acknowledgements":[{"id":"00000000-0000-4000-8000-000000000001","status":"accepted"}]}
```

Statuses:

- accepted: INSERT acknowledged.
- duplicate: exactly identical stored client payload found after unique conflict.
- conflict: UUID or session/attempt/sequence reused with different identity/payload.
  Accepted rows are never updated; a different UUID on the same sequence is a
  conflict, not a second observation.
- rejected: definite RLS/constraint rejection.
- retry: uncertain transport/server failure or failed duplicate lookup.

An outbox may remove accepted/duplicate only. It must preserve UUIDs, sequence,
timestamps and payload on retry. Conflicts require review; rejected events should
not be blindly retried. Timeout/lost HTTP responses can safely retry unchanged
events. No raw database error or existing payload is returned.

Request failures: 400 malformed input; 401 unauthenticated; 403 origin/ownership;
413 size limit; 415 content type; 503 verification/transport unavailability.
Responses use Cache-Control: no-store.

## Validation and checks

[Rollback-only integration script](../../tests/database/workout-session-events.sql)
uses the existing development fixture's coach/athlete/admin IDs and two teams.
Run as postgres in a dedicated session; ROLLBACK on unexpected errors.
It changes memberships and inserts a normal assignment/results/events only inside
the transaction. Sessions are created by the existing assignment trigger.

Passed own writes/read, other-athlete/coach/assistant/admin write denial,
coach/assistant/admin read, unrelated-coach denial, UPDATE/DELETE denial,
receipt-column denial, invalid vocabulary/phases/pairs/timing rejection, invalid
step/workout rejection, completion-before-result denial and after-result success,
UUID/key retry immutability, telemetry FK deletion barrier, session visibility and
ordinary TRUNCATE privilege checks.

Endpoint tests exercise actual transpiled handler/validator with a normal-client
mock: auth/origin/ownership, strict fields, body and batch limits, partial success,
identical and conflicting retries, uncertain errors, no privileged credentials,
and absence of history writes. No live HTTP submissions were made.

Historical row hash remains f09f82272cafe633d3ac7c2e5cd5a062, with 15 sessions,
2 results and zero permanent event rows after live tests.
TypeScript, ESLint, all 308 automated tests, and Webpack production build passed.

Security advisor: no errors or new warnings. Known pre-existing warnings:

1. accept_team_invitation: authenticated SECURITY DEFINER RPC.
2. get_team_invitation_summary: authenticated SECURITY DEFINER RPC.
   [Guidance](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable).
3. Leaked-password protection disabled.
   [Guidance](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

## Rollback and next-phase boundaries

Disable/remove the endpoint before dropping workout_session_events in a separately
approved migration. Export real events first; dropping the table deletes them.
No existing table/helper/trigger/policy needs restoration.

No player edits, timer rewrite, recovery checkpoint, event emission, IndexedDB
outbox, audio or coach summaries were implemented. Before player integration,
settle attempt restart/resume identity, timestamp reconciliation, prescription
snapshots, inferred versus observed transitions and outbox acknowledgement handling.
Validate same-origin behavior behind the target deployment proxy and add
deployment-level abuse controls as appropriate. Current request bounds are not a
distributed rate limiter; direct Supabase writes remain governed by RLS/constraints.
