# Phase 11B.6 — Family-First Training Write + Authorization Cutover

This is a design record only. It does not apply a migration, alter application code, or change live behavior. Phase 11B.5 remains the current database state: `athlete_id` is nullable parallel ownership, while `athlete_user_id` is current-write authoritative.

## 1. Current dependency map

| Durable record | Current owner assumption | New durable owner | Dependent ownership chain |
|---|---|---|---|
| `training_plan_assignments` | `athlete_user_id -> auth.users`, required | `athlete_id -> athletes`, nullable | assignment expands to sessions |
| `training_sessions` | required `athlete_user_id`; required `coach_user_id` | nullable `athlete_id` | session captures prescription; parents results, attempts, events |
| `workout_results` | required `athlete_user_id`; one result per session | nullable `athlete_id` | canonical completion truth; session is completed by existing automation |
| `workout_session_attempts` | required `athlete_user_id` | nullable `athlete_id` | one canonical result link; derives immutable prescription metrics |
| `workout_session_events` | no athlete column | none | owner derives from immutable session and attempt parents |
| `training_session_prescriptions` | no athlete column | none | owner derives from one session parent |

`assigned_by_user_id` and `training_assignment_batches.assigned_by_user_id` are authenticated actor/provenance. `training_sessions.coach_user_id` is coach/provenance. None should become an athlete ID.

Historical protections remain: sessions, results, attempts, events, and prescriptions use restrictive parent deletion chains. The Phase 11B.5 athlete FKs are also `ON DELETE RESTRICT`. Existing assignment `athlete_user_id` FK is a pre-existing cascade and is not changed by this design.

## 2. Current writes

1. **Assignment:** the coach server action validates durable roster recipients and calls `assign_my_team_training` once with a stable batch UUID. The canonical RPC writes the batch and durable `training_plan_assignments`; the protected `SECURITY DEFINER` trigger generates sessions and the immutable prescription capture trigger records each snapshot. This is the only current production session-creation path.
2. **Player/start:** `/training/[sessionId]` and `WorkoutPlayer` require `session.athlete_user_id === auth user`. The browser creates the attempt UUID and sequence-zero event.
3. **Registration:** after persisted `workout_started`, the browser invokes `register_my_workout_session_attempt`. The RPC verifies `training_sessions.athlete_user_id = auth.uid()`, then snapshots prescription aggregates into an attempt with `athlete_user_id = auth.uid()`.
4. **Telemetry:** the same-origin endpoint verifies the authenticated actor owns every session by `athlete_user_id`, then appends event rows. Event RLS repeats session ownership and immutable prescription/result checks. Sequence, idempotency, conflicts, and finalized-attempt late-event rejection stay database-enforced.
5. **Completion:** player verifies session ownership, inserts canonical `workout_results(athlete_user_id = auth.uid())`, then emits `workout_completed` and best-effort finalizes. A telemetry/materialization failure never undoes a successful result.
6. **Finalization:** the RPC locks an attempt by `athlete_user_id = auth.uid()`, confirms exactly one canonical same-athlete result, validates events against the immutable prescription, and materializes only database-derived metrics.

Attendance, adherence, Resume, dashboards, coach analytics, and athlete history are durable reads only. They currently select/map `athlete_user_id`; none creates athlete-owned history. Assignment batches are provenance/selection snapshots, not athlete-owned records.

## 3. Current reads and future authority

| Surface/operation | Current assumption | Required future authority |
|---|---|---|
| Athlete dashboard, Resume, player session read, results/attempts/prescription read | `athlete_user_id = auth.uid()` | `private.can_view_athlete(athlete_id)`; player action separately needs ACT |
| Guardian acting in player, registration, telemetry, canonical completion | impossible | `private.can_act_for_training(athlete_id)` |
| Coach/assistant assignment to a rostered athlete | legacy team membership and `athlete_user_id` | `private.can_assign_team_athlete_training(team_id, athlete_id)` |
| Coach athlete history / attendance / analytics | legacy staff membership | staff/team analytics helper plus athlete roster scope; never ACT solely from staff |
| Athlete identity/family configuration | not in training paths | `private.can_manage_athlete(athlete_id)` |
| Admin | legacy admin read paths | explicit support visibility only; never ACT/MANAGE merely through admin |

The existing Phase 11B.4 helpers are sufficient for these concepts. No new general authorization helper is required before the first write cutover. A narrowly scoped session-action helper may later be justified only if repeat SQL joins make it necessary; it must derive the caller with `auth.uid()` and bind the requested `session_id` to its `athlete_id` internally.

## 4. Recommended staged cutover

Do **not** use a long-lived trigger to invent durable ownership from a login ID. It masks missing application/RPC work, cannot represent no-auth athletes, and creates ambiguous authority.

### Stage 0 — transition-readiness migration

Create a reviewed migration that makes only the legacy athlete-owner columns nullable where a no-auth subject must be stored, while retaining legacy FKs and all historical rows. Add checks only where they allow either a valid compatibility identity or durable ownership; never require UUID equality. This stage must be paired with audited database writers/RLS because old direct browser inserts currently require the legacy fields. Do not make `athlete_id NOT NULL` yet.

### Stage 1 — assignment and generated-session authority

Replace the coach assignment action with a database-authorized write boundary that receives `team_id`, selected durable athlete IDs, plan, date, and notes. It verifies each target with `can_assign_team_athlete_training`; writes `athlete_id`; writes `athlete_user_id` only for legacy self-linked athletes when a compatibility profile relationship exists. Session generation must propagate `assignment.athlete_id`, preserve `coach_user_id` as provenance, and capture the same immutable prescription. This is the first stage that can assign a no-auth child.

A single transactional RPC is preferable to exposing direct browser table writes, because it atomically validates roster targets, writes batch/assignments, and relies on existing session generation. It is a new reviewed capability, not a general service-role route.

### Stage 2 — durable session action / completion boundary

Change session read/action RLS and player access to authorize `can_view_athlete(session.athlete_id)` and `can_act_for_training(session.athlete_id)` respectively. Move canonical result creation behind a narrowly scoped authenticated RPC or route-backed transaction that verifies session owner, actor authorization, existing canonical result, and only accepts non-authoritative legacy completion fields already accepted today. It writes `workout_results.athlete_id`; compatibility `athlete_user_id` is the actor only if that column’s final meaning remains explicitly documented, otherwise it must be nullable. Result remains canonical.

### Stage 3 — attempts and telemetry

Registration establishes the attempt’s durable owner from the session, never from browser input. The public RPC receives only `attempt_id` and `session_id`; it verifies `can_act_for_training(session.athlete_id)`, a persisted sequence-zero start event, then inserts `attempt.athlete_id = session.athlete_id`. It must not accept browser timestamps or summaries.

Telemetry may include selected athlete context only as an optional routing aid; endpoint/RLS must ignore it for authority. They load the session, verify `can_act_for_training(session.athlete_id)`, and require any existing attempt’s durable owner to equal the session owner. Events continue deriving ownership through session/attempt. Finalization locks the attempt, verifies actor ACT authority for the session athlete, verifies canonical result/session/attempt athlete IDs agree, and preserves all Measurement V1 validation and idempotency rules.

### Stage 4 — reads and analytics

Migrate dashboard, Resume, athlete detail, attendance, adherence, team analytics, and schedule selectors to durable `athlete_id`. Use `athletes` display identity and parallel roster tables. Do not query raw events for dashboards. Preserve weighted adherence aggregation and legacy N/A behavior.

### Stage 5 — enforce durable ownership

Only after Stage 1–4 are deployed and production validation shows every new row has `athlete_id`, make `athlete_id NOT NULL` on the four owner tables. Keep legacy columns nullable compatibility fields until all old readers, RLS, group membership, invitations, and historical support paths are retired. Final removal/redefinition of legacy fields is a separate irreversible cleanup after a long stable period.

### Stage 1 retirement note

After production validation of the canonical assignment writer, ordinary authenticated direct `training_sessions` INSERT is retired. The assignment generator remains a postgres-owned `SECURITY DEFINER` trigger and continues to create sessions and immutable prescriptions. Direct batch and assignment INSERT remain temporarily for a rollback to the prior application, which can still create legacy-only rows with `athlete_id = NULL`.

`athlete_user_id` remains compatibility metadata for current downstream reads and authorization. The no-auth-child production boundary has not been crossed, and legacy `team_group_memberships.athlete_user_id` remains a separate future groups/roster cutover.

## 5. Dual-write and deployment compatibility

Recommended strategy is **coordinated writer cutover**, not application-only dual write and not a synchronization trigger.

- **Old app + Phase 11B.5 DB:** safe today because new columns are nullable.
- **Transition DB + old app:** only safe if it still accepts current legacy writes; do not make `athlete_id NOT NULL` or remove legacy fields.
- **New writer + transition DB:** new assignment/session/result/attempt writers populate `athlete_id`; legacy self-linked subjects may retain matching `athlete_user_id`; no-auth subjects use `NULL` legacy athlete user.
- **Rollback before no-auth writes:** revert app to legacy behavior while retaining additive columns; do not delete data.
- **Rollback after no-auth writes:** never revert to an app/RLS version that cannot read those rows. Forward-fix from the transition DB; history must not be copied, deleted, or reattributed.

Tightly coordinate Stage 0 with Stage 1 because relaxing legacy nullability without replacing direct writers/RLS creates a window where old assumptions can reject valid no-auth work. Prefer deploy database compatibility first, then application/RPC, then enable the new writer atomically behind a server-controlled capability.

## 6. Active-athlete contract

The active athlete is explicit request/session context, never inferred from browser state alone.

- Server action or route receives an `athleteId` only where subject selection is needed.
- It verifies the actor through current-actor helpers on every request; a URL or cookie value never grants access.
- Player routes are session-centric: resolve athlete from `training_sessions.athlete_id`, then verify VIEW or ACT depending on operation. Do not trust a player-supplied athlete ID.
- Dashboard and Resume accept an active athlete selector only after server-side VIEW verification. Assignment uses durable roster athlete IDs and TEAM ASSIGNMENT verification.
- Stale/unauthorized context returns no data / forbidden, never falls back to another sibling.

No UI, cookie, or active-athlete persistence is introduced in this phase.

## 7. Browser recovery / offline migration

Current IndexedDB database `tilt-workout-session-v1` uses object store `users`, `Bundle.userId`, checkpoint `userId`, a `Map` of flushes by `userId`, and completed-delivery/flush authorization by the logged-in user. That partitions by actor and is unsafe for siblings.

A future versioned store must partition bundles/checkpoints/outbox/flush locks by durable `athleteId`, with checkpoint identity requiring `(athleteId, sessionId, attemptId)`. The bundle must additionally record its authenticated actor only as a revalidation hint, not as owner authority. Before recovery/delivery, verify current actor has `can_act_for_training(athleteId)` and that the session resolves to the same athlete. Do not migrate records by guessing: retain the v1 store read-only as recoverable legacy state for self-linked UUID parity, clear it only after explicit successful delivery or after a documented safe expiry. A guardian context must never load or flush a sibling’s bundle merely because the parent is the same actor.

## 8. Actor attribution

| Field/operation | Decision | Reason |
|---|---|---|
| `assigned_by_user_id`, batch assigner, `coach_user_id` | retain | already material provenance |
| `started_by_profile_id` | useful later | start event can be guardian-assisted, but existing history cannot truthfully backfill it |
| `completed_by_profile_id` | useful later | separates athlete ownership from guardian-assisted completion/support |
| `recorded_by_profile_id` | unnecessary now | telemetry auth and immutable parents already establish accepted event scope |

No new actor fields are required for the first durable ownership cutover. If added later, they must be populated server-side/RPC-side from `auth.uid()`, never browser input.

## 9. Integrity requirements

- Preserve sessions, results, attempts, events, prescriptions, analytics, attendance, adherence, and Resume history in place.
- No delete/reinsert backfill; same-UUID athletes keep existing history attached.
- No ordinary authenticated UPDATE/DELETE/TRUNCATE on canonical historical rows.
- Preserve immutable prescriptions, append-only event validation, event sequence/idempotency/conflict behavior, late-event protection, one canonical result/session, one result-linked attempt, and Measurement V1 null work/rest progression metrics.
- Browser never obtains service-role credentials or submits authoritative attempt summaries.
- Result remains canonical; telemetry failure must not block or undo canonical completion.

## 10. Test matrix

For self-linked athlete, guardian/no-auth child, guardian/two children, unrelated actor, coach, assistant, admin, and later-linked athlete login, test:

- team assignment / generated session durable ownership;
- VIEW versus ACT versus MANAGE boundaries;
- player read/start/result/attempt registration/event delivery/finalization;
- telemetry rejects arbitrary athlete IDs and session/attempt/result ownership disagreement;
- result canonicality survives telemetry failure and retry;
- Resume, attendance, adherence, athlete history, and analytics use durable owner and weighted aggregation;
- staff may view assigned roster scope but cannot ACT; admin does not ACT; guardian lacking training permission cannot ACT; guardian lacking manage permission cannot manage;
- direct URL and stale active context authorization; and
- sibling server and IndexedDB/outbox isolation, recovery, delivery, and actor revalidation.

Use rollback-only SQL fixtures for database authorization/integrity and focused browser/unit tests for storage keys and request payloads. Include a later-login test proving a new profile relationship to an existing athlete reveals the same historical records without UUID reassignment.

## 11. Proposed Phase 11B.6 subphases

1. Inspect/approve the exact legacy-nullability, assignment/session-generation, and RLS/RPC migration boundary.
2. Implement/validate transactional durable assignment and session generation.
3. Implement/validate durable player completion, registration, telemetry, and finalization authorization.
4. Implement active-athlete server contract and durable read-path migration.
5. Version/validate athlete-scoped IndexedDB/outbox recovery.
6. Production-like role matrix and rollback validation; only then enforce `athlete_id NOT NULL` for new durable writes.
7. Defer legacy cleanup until all consumers and historical support paths have been stable in production.

---

## Phase 11B.6C — Player, completion, attempt, and telemetry design

Phase 11B.6B is complete: the canonical assignment RPC creates durable
assignments, sessions, and immutable prescriptions. Execution remains legacy
self-athlete-only until its own coordinated cutover.

- A player route is session-centric. It resolves `session.athlete_id`, uses
  `can_view_athlete` for display, and separately requires
  `can_act_for_training` to start, resume, submit telemetry, create a result,
  register an attempt, or finalize an attempt. Staff and platform support
  visibility never conveys completion authority.
- Results and attempts belong to `session.athlete_id`. `athlete_user_id` is an
  optional compatibility reference only; it is NULL for a no-auth child and is
  never populated with a guardian actor UUID. A trusted completion writer must
  derive the subject from the session, not browser input.
- No global active-athlete cookie or selector is needed for `/training/[id]`.
  Future selector UI is a read-context concern and must be authorized on every
  request.
- Events retain no redundant athlete column. Their durable subject derives from
  the session and, once registered, the matching attempt. Event submission and
  RLS must require ACT for that session’s durable athlete.
- Browser recovery cannot be enabled for real parent-managed child execution
  until IndexedDB partitions bundles/checkpoints/outbox/flush locks by durable
  `athleteId` and validates `{ athleteId, sessionId, attemptId }`. The current
  actor-keyed v1 storage may only be recovered under self-linked UUID parity.
- Actor provenance fields are deferred. Existing result, session, and attempt
  correctness comes from server-side actor authorization plus durable athlete
  ownership; future provenance fields must be server-derived.

### Phase 11B.6C.1 foundation

The first executable artifact makes `workout_results.athlete_user_id` and
`workout_session_attempts.athlete_user_id` optional and adds owner-presence
checks. It adds the internal session-scoped ACT helper. It deliberately does
not alter result/event RLS, registration/finalization RPCs, completion sync,
or browser code, so child execution remains blocked. Cross-table durable
agreement is enforced by the future trusted completion, registration, and
finalization writers rather than fragile synchronization triggers.

The forward-only boundary remains the first committed result or attempt with
`athlete_id IS NOT NULL AND athlete_user_id IS NULL`. Before that boundary,
legacy-only rollback remains structurally possible; after it, old player and
read/authorization paths must never be restored.

### Phase 11B.6C.2 — canonical completion sequence

**6C.2A** introduces `complete_my_training_session(session_id)` as a narrow
canonical result writer. It locks the session, derives athlete ownership and
prescription compatibility values from immutable parents, lets the existing
result trigger synchronize session completion, and returns the existing result
for an idempotent retry. The function has a temporary legacy-self gate:
`session.athlete_user_id` must be non-null and equal the authenticated actor.
That gate deliberately blocks a guardian from creating a child result through
the public RPC before the entire execution pipeline is family-ready.

`started_at` remains nullable in this RPC because no trusted start observation
is supplied. `completed_at` is database-generated. Stored active/total minutes
and step counts are prescription compatibility values, not measured timing.
Actor provenance remains deferred.

**6C.2B** integrates this self-compatible RPC into the player. **6C.2C** runs
self-athlete production validation and then retires ordinary authenticated
`workout_results` INSERT. Removing the temporary gate is a later coordinated
release with family player authorization, attempt registration/finalization,
telemetry authorization, and athlete-scoped IndexedDB recovery. Until then the
forward-only no-auth-child boundary remains uncrossed.

---

## Phase 11B.6A — Transition Database Boundary

### Current nullability and structural blockers

All four legacy owner columns are `uuid NOT NULL` with no default, and all four Phase 11B.5 durable owner columns are nullable `uuid` with no default:

| Table | Legacy `athlete_user_id` | Durable `athlete_id` | Owner-related unique constraints | Current owner FKs/indexes |
|---|---|---|---|---|
| `training_plan_assignments` | NOT NULL | nullable | none | legacy -> `auth.users` CASCADE; durable -> `athletes` RESTRICT; partial durable index |
| `training_sessions` | NOT NULL | nullable | `(assignment_id, plan_item_id)` | legacy -> `auth.users` RESTRICT; durable -> `athletes` RESTRICT; partial durable index |
| `workout_results` | NOT NULL | nullable | `UNIQUE(training_session_id)` | legacy -> `auth.users` RESTRICT; durable -> `athletes` RESTRICT; partial durable index |
| `workout_session_attempts` | NOT NULL | nullable | `UNIQUE(workout_result_id)` | legacy -> `auth.users` RESTRICT; durable -> `athletes` RESTRICT; partial durable index |

There is no CHECK involving either ownership column today. The immediate blocker for `athlete_id = child` with `athlete_user_id = NULL` is the legacy `NOT NULL` constraint on all four tables. Even after relaxing it, the current policies, functions, RPCs, and browser writers would reject or fail to populate durable ownership.

### Legacy dependencies

| Object/path | Dependency classification | Why it blocks independent nullability relaxation |
|---|---|---|
| `private.generate_sessions_for_assignment` and assignment-expansion trigger | D, propagates owner | reads assignment `athlete_user_id` and creates legacy-owned sessions |
| prescription capture trigger | inherited session ownership | does not carry athlete identity itself, but depends on a valid session parent |
| assignment INSERT/SELECT policy | B/C | validates legacy roster and authorizes via legacy user subject |
| session INSERT/SELECT/UPDATE policies | A/C | SELECT maps user to athlete; INSERT allows coach/admin but does not require a durable owner |
| result INSERT/SELECT policy | B/C | requires result and parent session `athlete_user_id = auth.uid()` |
| event INSERT policy | C | requires parent session ownership by `auth.uid()` and canonical result ownership for completion |
| `private.register_workout_session_attempt*` and public registration RPC | B/C/D | session lookup and attempt insert require/propagate `athlete_user_id = auth.uid()` |
| `private.materialize_workout_session_attempt` and public finalization RPC | B/C | locks attempt and locates canonical result by matching legacy athlete identity |
| player, telemetry endpoint, checkpoint/outbox | C | compare actor auth user to session legacy owner; browser storage partitions by actor |
| dashboard, Resume, athlete detail, attendance/adherence/analytics | A | reads and maps legacy owner/profile IDs |

The existing explicit database functions that reference `athlete_user_id` are `private.generate_sessions_for_assignment`, `private.register_workout_session_attempt`, `private.register_workout_session_attempt_from_event`, and `private.materialize_workout_session_attempt`. Event and result RLS add further direct actor comparisons.

### Temporary compatibility semantics

During the future transition, `athlete_id` is the only canonical training subject. `athlete_user_id` remains an optional legacy compatibility reference to `auth.users`; it must **not** be repointed to `athletes` or treated as a self-login link. A later login attaches to an existing athlete through `athlete_profile_relationships`, even when the profile UUID differs from the athlete UUID.

For old same-UUID history, `(athlete_id, athlete_user_id) = (A, A)` remains valid. For a parent-managed athlete, `(C, NULL)` is valid only after coordinated writer/RLS/RPC cutover. Do not add `athlete_user_id = athlete_id` as a CHECK: it would falsely make UUID equality a permanent account-link model and block a later distinct profile UUID.

### Owner-consistency rule

The desired eventual row invariant is:

```sql
athlete_id IS NOT NULL
```

No equality CHECK with `athlete_user_id` is appropriate. Cross-table agreement cannot be expressed with a normal CHECK and should be guaranteed at the existing authoritative boundaries:

- assignment/session: session-generation function copies the assignment durable athlete;
- session/result: canonical completion RPC verifies and writes the session durable athlete;
- session/attempt: registration copies from session after ACT authorization;
- attempt/result/session: finalizer verifies all durable athlete IDs agree before linking/materializing;
- prescription/event: retain parent-session/attempt derivation and existing immutable parent FKs rather than redundant athlete columns.

These are database function/RPC responsibilities, not browser validation. No new synchronization trigger is recommended.

### Deployment decision: Option 3

**Option 3 — nullability/constraint work must be tightly coordinated with the 11B.6B writer cutover.** No Phase 11B.6A executable migration is drafted.

- **Do not drop `athlete_user_id NOT NULL` independently.** Although old application writers continue supplying it, the current session INSERT policy permits coach/admin inserts without a durable owner requirement. Relaxing the column first would make ambiguous ownerless sessions structurally possible.
- **Do not make `athlete_id NOT NULL` independently.** Old assignment/session/result/attempt writers omit it, so this breaks old application behavior and assignment automation.
- **Coordinated transaction boundary:** the migration that relaxes legacy owner nullability must simultaneously establish the durable-owner constraint and replace all affected direct-write/RPC/policy paths with reviewed durable ownership writers. It must be deployed only when the matching 11B.6B application boundary is ready.

Thus `OLD APP + CURRENT DB` remains current-safe. `OLD APP + an independently relaxed DB` is unsafe. `OLD APP + athlete_id NOT NULL DB` fails. `NEW 11B.6B writer + coordinated transition DB` is the first valid no-auth-child state.

### Rollback boundary

The exact legacy-only rollback boundary is crossed when any owner table contains:

```sql
athlete_id IS NOT NULL AND athlete_user_id IS NULL
```

Before that point, legacy application rollback remains structurally possible because every historical owner retains an auth-user compatibility value. After the first such row, reverting to legacy-only RLS, RPCs, player code, or analytics is unsafe because those consumers cannot authorize or resolve the durable subject.

Operational detection query:

```sql
SELECT table_name, count(*) AS no_auth_durable_rows
FROM (
  SELECT 'training_plan_assignments'::text AS table_name, athlete_id, athlete_user_id FROM public.training_plan_assignments
  UNION ALL SELECT 'training_sessions', athlete_id, athlete_user_id FROM public.training_sessions
  UNION ALL SELECT 'workout_results', athlete_id, athlete_user_id FROM public.workout_results
  UNION ALL SELECT 'workout_session_attempts', athlete_id, athlete_user_id FROM public.workout_session_attempts
) AS owners
WHERE athlete_id IS NOT NULL AND athlete_user_id IS NULL
GROUP BY table_name;
```

After a nonzero result, rollback is forward-fix only. No delete/reinsert, reassignment, or historical data rewrite is acceptable.

### Historical integrity retained

The eventual coordinated migration must retain every existing `ON DELETE RESTRICT` durable ownership FK, immutable prescription/event behavior, session/result/attempt restrictions, result canonicality, event idempotency/conflict/late-event protection, and normal historical mutability restrictions. The pre-existing legacy assignment cascade should be separately addressed only in a reviewed historical-integrity phase; it is not changed as part of this boundary.

---

## Phase 11B.6B — Transactional Assignment + Session Generation

### Current assignment transaction architecture

The only production assignment entry point is the coach/assistant server action at `src/app/teams/[teamId]/assign/actions.ts`, called by the assignment form. It accepts plan/date/notes plus individual and group IDs, but does not trust a client-resolved recipient list.

1. It derives actor/provenance from `auth.getUser()` and uses `user.id` for `assigned_by_user_id`.
2. It validates legacy staff membership (`coach` or `assistant_coach`), an active/private/coach-owned plan, individual legacy athlete roster membership, selected groups belonging to the team, and group member IDs against the current team roster.
3. It deterministically deduplicates individual and group recipients, preserving only current roster members. A group may overlap another group or an individual without creating another assignment.
4. It sends a generated batch UUID and selection snapshot in one request to `training_assignment_batches`.
5. It then sends one bulk `training_plan_assignments` INSERT in a separate request. Each row carries `training_plan_id`, `team_id`, legacy `athlete_user_id`, actor `assigned_by_user_id`, date, active status, notes, and the batch ID.

The assignment bulk INSERT is all-or-nothing at the database request boundary: its per-row session/prescription triggers are in the same transaction. The batch INSERT is separate. A definite assignment rejection triggers a narrow delete of the newly empty batch; an uncertain response produces `review_required` and deliberately avoids retry/cleanup because the insert may have committed. UI action state blocks immediate resubmission but does not create durable cross-request idempotency.

Team/group assignment does not use a different writer; it is selection logic feeding the same deduplicated bulk insert. Coaches and assistant coaches currently both assign their own active private library plans. Guardians and self-athletes have no current assignment writer. Admin/template lifecycle code does not assign training; public templates must first be copied into the coach’s private library.

### Current session and prescription generation

`training_plan_assignment_generate_sessions` is an `AFTER INSERT` trigger on `training_plan_assignments`, invoking `private.generate_sessions_for_assignment()` under `SECURITY DEFINER` with empty search path. It expands every `training_plan_item` ordered by `day_offset, position`, creating a scheduled session with:

- `assignment_id = NEW.id`;
- `plan_item_id = item.id`;
- `athlete_user_id = NEW.athlete_user_id`;
- `coach_user_id = NEW.assigned_by_user_id` as provenance;
- `team_id`, workout, date `NEW.start_date + day_offset`, scheduled time, and scheduled status.

The existing unique `(assignment_id, plan_item_id)` prevents duplicate generated sessions per assignment item. Any error while generating a session aborts the assignment insert transaction.

A separate `AFTER INSERT` trigger on `training_sessions` invokes `private.capture_training_session_prescription()`, which snapshots the workout and ordered workout exercises into exactly one immutable `training_session_prescriptions` row. It validates nonempty workout/steps, duration/position values, and aggregate parity before inserting. A prescription failure aborts the session and therefore the originating assignment transaction. Prescription ownership remains inherited exclusively through `session_id`; no prescription `athlete_id` is warranted.

### Recommended canonical writer: RPC plus existing triggers

Use **one authenticated, narrowly scoped `SECURITY DEFINER` RPC** for an entire resolved recipient set, while retaining and updating the existing assignment/session/prescription trigger chain.

The RPC receives a caller-supplied request/batch UUID, team ID, coach-plan ID, date, nullable notes, selected group/individual IDs or already-resolved durable athlete IDs only if it independently revalidates them. It must derive actor identity solely from `auth.uid()` and, in one transaction:

1. validates active/private/coach-owned plan and date/notes bounds;
2. validates each durable target through `private.can_assign_team_athlete_training(team_id, athlete_id)`;
3. resolves/deduplicates selection deterministically if groups are accepted at the RPC boundary;
4. inserts or idempotently recognizes the batch with actor/team/plan/date/selection equality;
5. inserts all assignment rows with canonical `athlete_id` and compatibility `athlete_user_id` according to the rule below;
6. relies on the updated assignment trigger to create matching durable sessions, which in turn invoke existing immutable prescription capture;
7. returns only a concise success/result payload.

This preserves database authorization, avoids browser service-role access, makes batch/assignments/sessions/prescriptions atomic, and prevents a partial successful 19-of-20 team assignment. Any invalid/unrostered target fails the entire request before permanent rows are created, matching current validation semantics.

Direct authenticated INSERT for assignments should eventually be revoked once the server action uses this RPC. Direct session INSERT should be unavailable to ordinary authenticated users; sessions are generated by the protected trigger. These are RLS changes for the coordinated writer phase, not Phase 11B.6B design-only work.

### Authorization matrix

| Actor/scenario | Future assignment authorization |
|---|---|
| Coach on requested team | `private.can_assign_team_athlete_training(team_id, athlete_id)` for every recipient |
| Assistant coach on requested team | same helper; current canonical helper intentionally grants roster-manager assignment authority |
| Guardian/self athlete | no assignment authority in current product; `can_manage_athlete` and `can_act_for_training` do not imply plan assignment |
| Admin | no assignment solely through admin/support status |
| Coach plan/template | only active, private, coach-owned plan is assignable; public master must still be copied first |

The assignment row contains team, plan, batch, actor provenance, and durable athlete owner, sufficient for later support/audit and roster validation. No new provenance column is required.

### Compatibility field rule

For every durable recipient, the writer sets `athlete_id` from the authorized target. It must **never** set `athlete_user_id = auth.uid()` merely because a guardian/coach initiated the request.

During compatibility:

- Set `athlete_user_id = athlete_id` only when `athletes.id` has the same UUID as an existing `auth.users.id` and the athlete has an active self relationship for that same profile. This is the explicit legacy same-UUID subject model.
- Otherwise set `athlete_user_id = NULL`, including every parent-managed child and any athlete later attached to a distinct profile UUID.

The updated session generator copies both ownership columns from the assignment; it never derives legacy owner from the assigner. The later player/result/attempt phase will apply the equivalent canonical subject rule to its new rows.

### Nullability, constraint, and old-app rollout

The first implementation migration must support both old and durable writes without ownerless records:

- make `training_plan_assignments.athlete_user_id` and `training_sessions.athlete_user_id` nullable;
- retain their `auth.users` FKs as optional compatibility references;
- add a transition CHECK on each table requiring at least one subject identity: `athlete_id IS NOT NULL OR athlete_user_id IS NOT NULL`;
- update the assignment generation trigger to copy both columns;
- keep `athlete_id` nullable while old assignment writers remain supported.

The CHECK permits old app rows (`athlete_user_id` only) and canonical rows (`athlete_id` with optional legacy value), while preventing the ownerless-session window identified in 11B.6A. It does not impose equality. Results and attempts retain their legacy `NOT NULL athlete_user_id` in this subphase because Phase 11B.6C has not changed player/completion/attempt writers.

The accompanying RLS must preserve a legacy INSERT branch for valid old subject rows and add a canonical branch that authorizes durable roster targets. This is safe only when carefully reviewed with the RPC. An `athlete_id NOT NULL` constraint waits until the old direct writer is retired and durable writer coverage is validated.

Recommended rollout:

1. Deploy the transition DB/RPC/trigger/RLS migration that supports both paths and prevents ownerless rows.
2. Deploy the server action using the RPC; old deployed application remains structurally functional through the legacy branch during rollout.
3. Observe durable parity and assignment/session/prescription success.
4. Revoke legacy direct assignment INSERT only after all active app versions use the RPC; later make durable owner required.

This avoids an availability break while preferring a constraint failure to silent misattribution.

### Batch idempotency

Use existing `training_assignment_batches.id` as an explicit idempotency key. The caller must preserve the same generated UUID for a retry of the same logical request. On an existing batch ID, the RPC verifies actor, team, plan, start date, normalized notes, and normalized/deduplicated resolved athlete set match exactly. It then proves the persisted assignments, generated sessions, and immutable session prescriptions are complete and internally consistent before returning the prior result. Any semantic mismatch is an idempotency conflict; missing or corrupted materialization is an integrity/idempotency failure and is detected rather than repaired.

A complete exact retry may be acknowledged after later plan archival or loss of current roster/staff authority because it creates no rows and remains restricted to the original actor. A new batch always validates current plan lifecycle and team authority. A new batch and all assignment rows are committed atomically. This replaces the current cross-request uncertain-write/review behavior with deterministic same-key retry, without adding a new table or a browser-authoritative result. The server action must retain the key through retryable delivery; a new user-initiated submission receives a new key.

### RLS/read transition

Later assignment/session SELECT policies should use durable ownership and distinct capabilities:

- athlete/guardian reads: `private.can_view_athlete(athlete_id)`;
- staff reads: team staff/roster scope, not ACT authority;
- assignment write: only canonical RPC, validating `can_assign_team_athlete_training` per recipient;
- generated session write: trigger-owned only;
- direct browser INSERT: revoked once the RPC is active.

Do not cut player action, result, attempt, events, dashboards, or analytics over here. Their legacy assumptions must remain internally consistent until Phase 11B.6C and later read migration.

### Focused implementation checkpoints and tests

1. **11B.6B.1 — transition RPC/database foundation:** reviewed nullability/check/trigger/RLS/RPC migration. Rollback-only tests cover old legacy assignment generation, durable no-auth child generation, prescription capture, ownership propagation, invalid roster/plan rejection, and no ownerless rows.
2. **11B.6B.2 — server action RPC integration:** keep UI selection semantics; translate legacy roster/group selector inputs to durable targets; preserve one-batch all-or-nothing behavior and idempotency-key retry.
3. **11B.6B.3 — production compatibility validation:** old/new writer coexistence, assistant authority, guardian/admin/unrelated denial, duplicate groups, replay/same-key retry, mismatched-key conflict, no partial rows, unchanged historical counts and restrictive deletion.
4. **11B.6B.4 — retire legacy assignment direct insert:** only after rollout coverage; defer durable `NOT NULL` tightening until results/attempts and read paths can follow.

---

## Phase 11B.6B.1 — Canonical Assignment RPC Foundation

The local foundation is `public.assign_my_team_training(batch_id, team_id, training_plan_id, start_date, notes, athlete_ids)`. It establishes the first transactional durable-subject writer without changing the application action. The migration is deliberately dual-path: assignments/sessions can have a legacy owner or durable owner but never neither; results/attempts remain legacy-only.

The function uses the existing batch UUID as a same-request idempotency key, serializes concurrent same-key calls with a transaction advisory lock, validates the exact immutable request shape, and creates batch/assignments/session trigger/prescription trigger in one transaction. It accepts already-resolved durable athlete IDs only; future group selection continues to resolve in a trusted server action before invoking it and must preserve the existing selection snapshot semantics when integrated.

The existing assignment generator is changed only to copy `NEW.athlete_id` alongside `NEW.athlete_user_id`. The immutable prescription trigger remains unchanged. An owner-presence CHECK on assignments and sessions prevents the ownerless write window while retaining old app writes. The legacy direct session INSERT policy is limited to the old shape (`athlete_id IS NULL`, legacy owner present); the canonical RPC/SECURITY DEFINER trigger is the durable writer.

This is not yet a player/result/attempt/telemetry/read cutover. It must be externally reviewed, applied, and validated before Phase 11B.6B.2 changes the server action.
