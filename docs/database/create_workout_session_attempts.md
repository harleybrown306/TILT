# Workout session attempts — external migration preparation

This SQL is **not applied locally**. Apply it through the existing Supabase workflow, then run rollback-only validation before enabling endpoint registration/materialization.

Attempts use the existing client UUID as their primary key. The first accepted `workout_started` registers the UUID idempotently and binds it permanently to one athlete/session while copying immutable prescription aggregates. No rows are fabricated for legacy sessions without telemetry.

The table has `open`, `finalized_completed`, and `finalized_incomplete` states. Measurement quality is `complete`, `partial`, `reconstructed`, or `unknown`; Phase 8A has no materializer yet. The pure TypeScript builder is the intended authority for formulas. Finalization must later use a narrow controlled RPC that verifies result/session/athlete identity and cannot rewrite a finalized completed row.

The migration replaces event validation against mutable `workout_exercises` with snapshot-step validation against `training_session_prescriptions.steps`. It preserves append-only events and result-first completion ordering.

External rollback-only validation must prove: registration idempotency and identity conflict rejection; RLS SELECT inheritance; INSERT/UPDATE/DELETE/TRUNCATE denial; RESTRICT deletion behavior; snapshot validation after a live workout mutation; canonical-result association; delayed completion finalization; and duplicate retry safety.
