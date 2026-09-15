# Finalize workout session attempts

This unapplied Phase 8B migration implements [Measurement V1](/Users/harleybrown/tilt-v2/docs/workout-attempt-measurement-v1.md). It creates no browser-controlled summary input: registration accepts only attempt/session IDs and derives started_at from the one persisted sequence-0 workout_started event; finalization accepts only attempt ID.

For a complete attempt it derives terminal elapsed from workout_completed, sums coherent paused-to-resumed and hidden-to-visible elapsed intervals, and counts distinct immutable step IDs by completion/skip outcome. Known absent pause/hidden intervals are stored as zero. Work and rest timer progression remain NULL; prescribed aggregates and legacy result durations are never used as measured telemetry.

Finalization requires athlete ownership, immutable prescription, exactly one workout_result for that athlete/session, exactly one terminal workout_completed for the same attempt, sequence zero through last without gaps, nondecreasing elapsed time, valid snapshot identity/position/duration, coherent pause/visibility pairs, no same-phase completion/skip conflict, and no unobserved non-paused time beyond prescribed total. Incomplete streams are rejected; corrupt streams are rejected; no reconstructed quality is inferred.

Finalized_completed rows are immutable. An identical retry recomputes the same persisted facts and succeeds. Any changed event range, metrics, result, or late logical event is rejected. A trigger rejects a new logical event after finalization while allowing the existing endpoint's exact UUID/sequence duplicate path to reach its normal uniqueness/idempotency handling.

The public wrappers are SECURITY DEFINER with empty search_path, revoke PUBLIC and anon, and grant authenticated only. Private helpers revoke PUBLIC, anon, and authenticated. There is no general UPDATE RPC and no service-role requirement.

The live database already has workout_results_training_session_id_key, a UNIQUE constraint on workout_results(training_session_id), and its four existing rows contain no duplicate athlete/session result pairs. No additional athlete/session uniqueness constraint is needed. Finalization still verifies exactly one result and verifies that its athlete and training session match the attempt.

Run [the rollback-only validation plan](/Users/harleybrown/tilt-v2/docs/database/validate_finalize_workout_session_attempts.sql) as a privileged test transaction after external application. It must finish with ROLLBACK and leave no test data.
