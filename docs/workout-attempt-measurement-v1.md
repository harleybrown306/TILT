# Workout attempt measurement V1

This is a fixture and documentation baseline only. It does not change the player, endpoint, database, or current materializer.

## Authoritative Phase 3 emitter semantics

The checkpoint starts at sequence -1. beginAttempt emits workout_started at sequence 0 in ready, then exercise_started at sequence 1 in work. The checkpoint, attempt ID, and next sequence survive refresh/recovery. An outbox retry repeats the same event UUID and sequence; idempotent storage keeps one event.

All events contain a client event UUID, session ID, attempt ID, sequence, event type, phase, elapsed_ms, and UTC occurred_at. Timed events carry the immutable workout_exercise_id, step position, prescribed phase duration, and cumulative phase elapsed. workout_started is ready and workout_completed is finished; neither has a step snapshot.

| Event | Emission rule |
| --- | --- |
| workout_started | First event, before entering step 0 work. |
| exercise_started / rest_started | After entering a work/rest phase. |
| exercise_completed / rest_completed | From the expiring phase only for one timely, foreground-observed expiration. |
| exercise_skipped / rest_skipped | Before advancing, with current phase elapsed. |
| timer_paused / timer_resumed | Current timed phase. Resume preserves phase progress and adds explicit pause wall time. |
| page_hidden / page_visible | Observational only; neither pauses the timer. |
| workout_completed | Final event after checkpoint finalization; later player commands emit nothing. |

elapsed_ms is attempt wall time since start. It continues through explicit pause, screen lock/background, music playback, and the ordinary interval after timer guidance reaches finished while the athlete reviews the completion screen. phase_elapsed_ms is timer guidance progress: it excludes explicit paused time, resets on phase transition, and may survive recovery.

On a long or suspended recovery gap, the player advances guidance state but deliberately emits no fabricated completion transition. The inferred transition remains only in the checkpoint. A terminal stream can therefore lack observed phase transitions.

## Fixture format and coverage

[The fixture set](/Users/harleybrown/tilt-v2/tests/fixtures/workout-attempt-measurement-v1.json) has 30 scenarios. Its compact arrays expand deterministically in [the fixture harness](/Users/harleybrown/tilt-v2/tests/workout-attempt-fixtures.test.mjs) into all persisted event fields. origin emitter means the current player can produce the stream; origin mutated is deliberately impossible or corrupt input for materialization validation.

Valid streams cover work/rest, skips, pause/resume in both phases, visibility, overlap, zero-length pairs, refresh, idempotent retry, recovery inference, and finalizing active or paused. Mutations cover missing boundaries, gaps, terminal-not-last, duplicate starts/sequences, non-monotonic elapsed time, invalid immutable snapshots, and conflicting completion/skip outcomes.

## Reliable measurement V1

For a complete stream V1 can materialize:

| Field | Derivation |
| --- | --- |
| elapsed_attempt_ms | elapsed_ms on the single terminal workout_completed. It is lifecycle wall time, not a cap on prescribed guidance duration. |
| explicit_pause_ms | Sum of coherent timer_paused to timer_resumed elapsed deltas; no pair means known zero. |
| hidden_ms | Sum of coherent page_hidden to page_visible deltas; no pair means known zero. Observational only. |
| completed/skipped work/rest blocks | Count distinct immutable step IDs carrying each terminal phase outcome. |

Both work_timer_progressed_ms and rest_timer_progressed_ms are intentionally NULL in V1. Summed phase snapshots would falsely imply precision because recovery can advance through phases without durable transition events. Prescribed minutes are immutable prescription data; they are neither actual elapsed time nor proof of physical activity.

Deferred: exact active-timer minutes, inferred recovery duration, actual physical activity, receipt-time history, and reconstructed quality. The persisted V1 event data cannot establish them reliably.

## Quality and finalization eligibility

Quality measures telemetry evidence and is separate from result existence.

* complete: exactly one start at sequence 0; one completion that is final; contiguous unique nonnegative sequences; nondecreasing elapsed_ms; valid immutable ID/position/duration; coherent pause/visibility pairs; no completion/skip contradiction for a step and phase. If terminal wall time exceeds prescribed guidance plus explicit pause, every prescribed work and nonzero-rest block must have an observed completion or skip outcome.
* partial: interpretable but missing a boundary, coherent pair, canonical result, or observed phase evidence. Recovery inference and finalize-while-paused are partial.
* unknown: contradictory/corrupt facts, including terminal-not-last, duplicate start/sequence, non-monotonic elapsed, invalid snapshot, or both completion and skip for one phase block.

An attempt is finalization-eligible only when its quality is complete and exactly one canonical workout_result exists for the same session and athlete. That result must be tied to the attempt by its persisted matching workout_completed event. A result alone and an interpretable partial stream are insufficient.

Sequence defines logical order, not receipt order. Normal retry receipt order may vary. A distinct event with an existing sequence is corruption.

## Current parity gaps

| Area | Current TypeScript builder | V1 fixture contract |
| --- | --- | --- |
| Work/rest progression | Sums maximum phase snapshots for complete streams. | Always NULL in V1. |
| Terminal structure | Detects completion but does not require it to be last. | Completion is singular and last. |
| Completion/skip conflict | Counts both. | Rejects it as unknown. |
| Duplicate sequence | Treats it as a gap only. | Treats it as corrupt/unknown. |
| Eligibility | Encodes missing result as partial quality. | Makes result binding a separate eligibility gate. |

| Area | Current unapplied SQL materializer | V1 fixture contract |
| --- | --- | ---|
| Quality | Contiguous becomes partial; otherwise unknown. | Complete only after all structural checks. |
| Terminal | Requires one or more completion events. | Requires exactly one final completion. |
| Snapshot/outcome validation | Does not validate snapshots or completion/skip conflict. | Required before complete/finalizable. |
| Pause/visibility | Leaves both NULL. | Derives coherent pairs for complete streams. |
| Timer progress | NULL. | NULL; aligned. |

## Recommended Phase 8B.1B

Keep clients unable to submit summaries. Make the TypeScript builder and database-derived materializer consume this fixture contract: validate terminal/sequence/snapshot/outcome structure, materialize only reliable V1 metrics, and make quality and eligibility distinct. Add parity tests from these fixtures. Do not infer activity from hidden time, pause state, or prescribed duration.
