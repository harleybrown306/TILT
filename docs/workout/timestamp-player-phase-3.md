# Timestamp workout player — Phase 3

## Scope and canonical completion

No database objects, policies, environment files, audio, or coach reporting UI change in this phase. Canonical completion remains workout_results INSERT followed by the existing database trigger completing training_sessions. Only after a result exists does the client finalize its checkpoint and emit workout_completed. A completed server session never mounts the athlete player. A completed-page delivery component finishes an interrupted local finalization and retries pending telemetry without inserting another result.

## Timer and recovery

The pure transition engine in src/lib/workout-session-state.ts derives phase remaining time from its start timestamp, prescribed duration, and accumulated explicit pauses. A one-second callback refreshes state/display; it does not decrement canonical time. Work expiration enters prescribed rest or the next step; skipping work retains prescribed rest. Skipping rest advances to work. Pause/resume are explicit, idempotent transitions. Rapid controls include the expected phase/index/paused state so an old click cannot skip a newly entered step.

In process, elapsed time uses performance.now() plus bounded forward wall-clock reconciliation. Persisted logical time and saved wall time reconstruct remounts. Negative wall gaps and gaps over 24 hours are treated as uncertain and add no elapsed time. Forward gaps up to 24 hours may represent legitimate absence or a changed clock; these cannot be distinguished on a client alone. Values are clamped and transitions bounded by the snapshot length. This is approximate guidance, never physical-activity evidence.

Only a single timely, visibly observed expiry emits automatic completion/start telemetry. Recovery, visibility callbacks, multiple missed deadlines, and late callbacks reconstruct guidance without inventing observed completion events. Inferred transitions are counted locally. The current server vocabulary has no reconstruction marker; sequence gaps or missing automatic events must not be interpreted as athlete noncompliance. A future cue adapter can observe timely authoritative transition outputs; cue playback must not drive state, and recovery must not replay stale cues.

## Identity, checkpoint, and prescription

IndexedDB tilt-workout-session-v1 stores a user-scoped bundle of session checkpoints and an outbox. First successfully persisted Begin creates one UUID attempt, workout_started, and the first exercise_started. Atomic read/write transactions prevent duplicate Begin across tabs. Refresh keeps the same attempt and sequence. Authentication is checked before loading/Begin/delivery, and account changes stop the previous user's state. Completed local checkpoints are marked finalized; up to 50 finalized markers are retained. Active checkpoints are not automatically deleted.

The versioned checkpoint includes user/session/workout identity, attempt start, logical/wall anchors, ordered step IDs/positions, work/rest durations, display names/notes/off-hand information and video references, phase/index/start/duration, pause state, sequence, timing counters, and finalization. An unfinished attempt uses this snapshot rather than replacement live durations. This is same-device recovery, not a durable server-side historical prescription.

## Telemetry delivery

Checkpoint and events are persisted in one transaction before network delivery. Event UUIDs, sequence, and payload remain identical on retries. Pending events flush on event creation, foreground, online, a 30-second active/completed-page interval, and completion. Timer display ticks do not send HTTP requests. Batches respect 25 events/64 KiB; each flush processes at most four batches. Only accepted/duplicate acknowledgements remove items. Conflict/rejected items remain quarantined; retry/network/unknown acknowledgements preserve pending items. A maximum 2,500 events per user retains existing entries and drops new events on overflow, recording a visible local delivery-gap warning.

Telemetry delivery cannot undo a saved result. Finalization waiting is bounded on the normal result-save path and the completed page can recover it. Storage failure is surfaced instead of silently starting an undurable attempt. Browser storage can be cleared, evicted, or unavailable; same-device durability is best effort, not permanent athlete history. Quarantined records currently have no dedicated review UI. Simultaneous tabs may deliver duplicates; server idempotency handles them.

## Visibility and video

Visibility events are observational, emitted only for a started, unfinalized attempt and actual observed visibility changes. Hidden time does not pause or subtract duration. Background execution and mobile browser suspension cannot guarantee callbacks or delivery; foreground reconstructs timestamps. No audio is implemented. Future web/PWA/Capacitor/native adapters can observe transitions independently of the timer; reliable locked-screen audio and coexistence with another music app require platform-specific review.

The player uses exercises.video_url, with an existing snapshot video reference as fallback. Work video is HTTPS-only, muted, looping, inline and independent of timer state. Play/pause controls affect only media. Missing or failed media is omitted. During rest, the next video's metadata can preload; no video playback telemetry is collected.

## Time metrics and future database review

Existing workout_results total_duration_minutes, active_minutes, exercises_completed, and result_data.completed_steps retain their previous prescribed-duration/full-step-count write semantics. They must not be reported as measured physical activity. The new attempt calculates prescribed duration, elapsed attempt time, explicit pause duration, work-timer progressed duration, skipped steps, and inferred transitions separately. These remain client-derived guidance and may include uncertainty from recovery or clock changes.

Recommend a reviewed immutable server-side attempt/prescription record tied to session, athlete, workout version and attempt, containing ordered work/rest definitions and stable display/exercise references. Record schema version and prescription capture time; copies must remain independent of mutable source templates/workouts. Keep large media content outside telemetry. Add separately named result metrics for elapsed_ms, explicit_pause_ms, work_timer_progress_ms, prescribed_work_ms/rest_ms, skipped_step_count, clock/recovery quality and provenance rather than redefining legacy columns. Decide first which values are authoritative and how interrupted attempts and explicit corrections are represented. Raw events remain separate from eventual athlete summaries/shareable history. No automatic raw-event deletion is introduced.

## Validation

Automated suite: 367 passing tests, including 59 new player/state/storage/media/access tests using real fake-indexeddb transactions and the actual completion handler. TypeScript, lint, and the Webpack production build pass.

Live browser validation on September 14, 2026 used the existing athlete account and scheduled MW Training vol 1 session `cce5f9f3-714e-48ef-a221-4188565db66b`. Begin, visible countdown, work-to-rest expiration, rest expiration, paused refresh, active refresh, explicit resume, exercise skip retaining rest, rest skip, video pause independent of the timer, media switching, Finish, and completed-page reload passed. Actual media was muted and looping, playing with `readyState` 4. Result `4916c8db-be59-4842-bd1f-b49a4deb0f4d` was inserted once; the session became completed. Test history is retained.

The single attempt `44846a29-9f2b-4ed2-990b-e1c769835477` generated 44 events with sequence 0–43. Examples: workout_started (0 ms), timer_paused (5,993 ms), timer_resumed (22,080 ms), exercise_completed (26,087 ms), rest_skipped (40,828 ms), exercise_skipped (46,742 ms), rest_completed (66,742 ms), and workout_completed (109,079 ms). There were 44 distinct sequence values, no elapsed regression, no repeated event-type/step pair, one start, and one completion. Delivery lag was 0.468–2.712 seconds. Concurrent batch insertion means `created_at` order need not equal sequence order; consumers must order an attempt by sequence.

In-app browser tab switching and browser hide/show were attempted; progression continued, but those controls did not produce `document.visibilitychange` events. Real-device screen lock/background/foreground remains unverified. Automated tests cover hook visibility callbacks, recovery after suspension, and no implicit pause. Do not equate browser presentation with mobile lifecycle validation.
