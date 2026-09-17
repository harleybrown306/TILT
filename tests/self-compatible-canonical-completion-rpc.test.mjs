import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../docs/database/create_self_compatible_canonical_completion_rpc.sql", import.meta.url), "utf8");
const validation = readFileSync(new URL("database/validate_self_compatible_canonical_completion_rpc.sql", import.meta.url), "utf8");
const design = readFileSync(new URL("../docs/database/design_family_first_training_write_cutover.md", import.meta.url), "utf8");

test("completion RPC is narrow, session-derived, and self-compatible only", () => {
  assert.match(sql, /FUNCTION public\.complete_my_training_session\(p_session_id uuid\)[\s\S]*?RETURNS TABLE \(result_id uuid, already_completed boolean\)[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path TO ''/);
  assert.match(sql, /v_session\.athlete_user_id IS NULL OR v_session\.athlete_user_id IS DISTINCT FROM v_actor/);
  assert.match(sql, /private\.can_act_for_training_session\(p_session_id\)/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /athlete_id,[\s\S]*?v_session\.athlete_id,[\s\S]*?v_session\.athlete_user_id/);
  assert.match(sql, /v_prescription\.prescribed_work_ms[\s\S]*?v_prescription\.prescribed_total_ms[\s\S]*?v_prescription\.step_count/);
  assert.match(sql, /clock_timestamp\(\)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.complete_my_training_session\(uuid\)[\s\S]*?FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.complete_my_training_session\(uuid\)[\s\S]*?TO authenticated/);
  assert.doesNotMatch(sql, /p_athlete|p_actor|p_workout|p_started|p_completed|CREATE POLICY|DROP POLICY|workout_results_insert|workout_results_select|register_my_workout_session_attempt|finalize_my_workout_session_attempt|workout_session_events_insert|completed_by_profile_id/i);
});

test("rollback validation covers self completion, retry, and family gate denials", () => {
  for (const phrase of [
    "Self canonical completion did not derive trusted result fields or synchronize session",
    "Canonical completion retry was not idempotent",
    "Transitional completion gate allowed a non-self child execution",
    "Sibling guardian completion was allowed",
    "Missing session completion was allowed",
    "Validation fixture count differs; historical execution rows may have changed",
  ]) assert.match(validation, new RegExp(phrase));
  assert.match(validation, /^-- Execute only after[\s\S]*BEGIN;/);
  assert.match(validation, /ROLLBACK;\s*$/);
});

test("design records the gated completion sequence without enabling family execution", () => {
  assert.match(design, /6C\.2A/);
  assert.match(design, /temporary legacy-self gate/i);
  assert.match(design, /ordinary authenticated\s+`workout_results` INSERT/i);
  assert.match(design, /attempt registration\/finalization,\s+telemetry authorization, and athlete-scoped IndexedDB recovery/i);
});
