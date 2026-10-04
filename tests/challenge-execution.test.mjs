import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase/migrations/20261004100000_enable_session_challenge_execution.sql", import.meta.url), "utf8");
const player = readFileSync(new URL("../src/app/training/[sessionId]/page.tsx", import.meta.url), "utf8");
const validator = readFileSync(new URL("database/validate_session_challenge_execution.sql", import.meta.url), "utf8");

test("Phase 18B has one snapshot-only performed-prescription resolver", () => {
  assert.match(sql, /CREATE FUNCTION private\.resolve_training_session_performed_prescription\(p_session_id uuid\)/);
  assert.match(sql, /training_session_prescriptions AS assigned/);
  assert.match(sql, /training_session_challenge_prescriptions AS challenge/);
  assert.match(sql, /coalesce\(variant\.selected_variant,'assigned'/);
  assert.doesNotMatch(sql.slice(0, sql.indexOf("DROP TRIGGER")), /public\.workouts AS/);
  assert.doesNotMatch(sql.slice(0, sql.indexOf("DROP TRIGGER")), /public\.workout_exercises AS/);
});

test("Phase 18B serializes selection with the first event and uses performed steps", () => {
  assert.match(sql, /CREATE TRIGGER workout_session_events_lock_execution_variant BEFORE INSERT/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /private\.performed_training_session_step_matches/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION private\.register_workout_session_attempt_from_event/);
  assert.match(sql, /Attempt identity conflict/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION private\.materialize_workout_session_attempt/);
  assert.match(sql, /v_expected_rest/);
  assert.match(sql, /v_completed_work\+v_skipped_work<>a\.prescribed_step_count/);
});

test("Phase 18B does not use a caller-settable GUC to bypass Challenge completion", () => {
  assert.match(sql, /training_session_canonical_completion_permits/);
  assert.match(sql, /private\.arm_canonical_challenge_completion/);
  assert.match(sql, /private\.require_canonical_challenge_completion/);
  assert.match(sql, /DELETE FROM private\.training_session_canonical_completion_permits/);
  assert.doesNotMatch(sql, /current_setting\('tilt\.challenge_canonical_completion/);
  assert.doesNotMatch(sql, /set_config\('tilt\.challenge_canonical_completion/);
});

test("player chooses the locked performed snapshot and leaves Challenge selection to the athlete UX", () => {
  assert.match(player, /training_session_performed_variants/);
  assert.match(player, /selectedChallenge \? "training_session_challenge_prescriptions"/);
  assert.match(player, /performedWorkoutId/);
  assert.match(player, /ChallengeSelection/);
});

test("disposable SQL validator covers Challenge execution, provenance, and bypass boundaries", () => {
  for (const text of [
    "Challenge resolver did not select immutable Challenge snapshot",
    "Assigned-only event was accepted for Challenge",
    "Challenge finalization, result, Measurement, or familiarity is inconsistent",
    "direct Challenge result insert succeeded",
    "direct Challenge status completion succeeded",
    "direct Challenge timestamp completion succeeded",
    "unselected Challenge session did not execute Assigned",
    "plain legacy-style session did not execute Assigned",
    "source edit rewrote immutable snapshot",
  ]) assert.match(validator, new RegExp(text));
});

test("result-attached feedback uses the immutable performed snapshot without exposing the resolver", () => {
  for (const signature of [
    "public.submit_my_workout_feedback",
    "public.get_my_workout_feedback",
    "public.list_my_workout_feedback_exercise_options",
    "public.list_my_team_athlete_workout_feedback",
  ]) assert.match(sql, new RegExp(`CREATE OR REPLACE FUNCTION ${signature.replaceAll(".", "\\.")}`));
  assert.match(sql, /private\.resolve_training_session_performed_prescription\(v_session\.id\)/);
  assert.match(sql, /JOIN LATERAL private\.resolve_training_session_performed_prescription\(session\.id\)/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION private\.resolve_training_session_performed_prescription\(uuid\) TO authenticated/);
  for (const text of [
    "Challenge feedback options did not use the performed snapshot",
    "Assigned-only feedback selection was accepted for Challenge",
    "Challenge feedback submission or label did not use the performed snapshot",
    "active guardian feedback read changed",
    "active guardian feedback submit changed",
    "revoked guardian feedback read succeeded",
    "same-team staff feedback history did not use performed snapshot",
    "unrelated profile read team feedback",
    "Assigned none feedback submission changed",
    "Assigned feedback behavior changed",
  ]) assert.match(validator, new RegExp(text));
});
