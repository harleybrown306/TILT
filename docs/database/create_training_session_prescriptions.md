# Durable training session prescriptions

Applied migration `20260914225416_create_training_session_prescriptions` on September 14, 2026.

Each training session now has one immutable V1 prescription row. New rows are captured atomically by the `training_session_capture_prescription` AFTER INSERT trigger; existing rows were reconstructed at migration time. `session_created` means captured with creation, while `legacy_backfill` is only the best reconstruction from content at migration time.

V1 `steps` is an ordered JSON array (position, then workout-exercise UUID) containing only `workout_exercise_id`, `exercise_id`, `exercise_name`, `position`, `work_ms`, `rest_ms`, `off_hand`, and `notes`. The capture function rejects missing/blank identities or names, negative timing/position, empty workouts, and aggregate mismatches. Table checks enforce V1, array/cardinality, nonnegative totals, and total = work + rest. Video is deliberately excluded.

RLS SELECT inherits visibility through the parent `training_sessions` row. Authenticated has SELECT only. PUBLIC/anon/authenticated have no INSERT, UPDATE, DELETE, TRUNCATE, or direct function EXECUTE. The two SECURITY DEFINER functions have empty search paths and only postgres retains EXECUTE. The snapshot FK is ON DELETE RESTRICT.

## Validation

Preflight found 0 duplicate workout positions and 0 empty/malformed workouts referenced by sessions. After migration all 15 sessions had exactly one snapshot; all 15 were `legacy_backfill`, and aggregate/cardinality validation found 0 invalid rows.

Rollback-only validation cloned an existing assignment. Its database automation created sessions and the same count of `session_created` snapshots. Editing the source workout name and one work duration did not change the captured snapshot. Inserting a session for a cloned empty workout failed and left no session. Role simulation showed the athlete, coach, rollback-simulated assistant coach, and admin could read the same parent-visible 15 rows. A foreign user sees no rows. Only authenticated SELECT is granted; direct mutation and function execution are unavailable by grants.

Application mapping rejects unsupported versions and invalid totals/steps. A pre-existing IndexedDB checkpoint still wins in the Phase 3 hook. For a new attempt, IDs, names, ordering, work/rest, off-hand, and notes come from the server snapshot; current video URL is joined by workout-exercise ID for presentation only.

Historical counts remained 15 sessions, 3 results, and 44 events after rollback validation. No historical rows were rewritten or deleted.

Security advisor added no findings. Known warnings remain the authenticated SECURITY DEFINER invitation functions (`accept_team_invitation`, `get_team_invitation_summary`) and disabled leaked-password protection.

## Rollback

Deploy application code that reads live workouts before rollback. Then drop `training_session_capture_prescription`, both private capture functions, and `training_session_prescriptions`. Dropping the table deliberately discards the new immutable history, so rollback should be used only before relying on snapshots or after preserving them separately.

## Final live validation

The existing athlete began session `6ea9fe12-a92e-4b54-b9d1-f3434bbc9b94` using its five-step server prescription. Refresh resumed work at the correct remaining duration. Normal skip controls reached Finish. The browser was already completed when the explicitly approved final write was revisited, so no duplicate submission was made. Database result `fc2ccc23-0800-45b6-8393-065ad630cea6` exists exactly once; session status is completed; the attempt has 22 events, one start and one completion. Test history is retained. Legacy fields remain prescribed values (active_minutes 14, total_duration_minutes 15, exercises_completed 5), despite skipped work.

Authenticated INSERT/UPDATE/DELETE/TRUNCATE and direct capture-row function calls were attempted in rollback transactions and all raised insufficient_privilege. Anon TRUNCATE was denied. A rollback-simulated unrelated coach saw zero snapshots; an assigned athlete, authorized coach, rollback-simulated assistant coach and admin saw all their parent-visible snapshots. Role mutations were rolled back.

Final application checks: 372 tests passed; TypeScript, lint and Webpack production build passed. Live video loaded during work and its visual control appeared; muted/looping behavior is unchanged and covered by existing media tests.

No Schedule + Attendance Adherence blocker remains in this foundation. Exercise adherence is still intentionally excluded. Existing telemetry INSERT checks still validate step IDs/positions against live workout content; later source step removal/reordering can reject recovered telemetry even while the prescription remains readable. That pre-existing telemetry limitation needs a reviewed follow-up before exercise adherence, without treating events as completion authority.
