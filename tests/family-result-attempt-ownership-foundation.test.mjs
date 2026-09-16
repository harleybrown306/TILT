import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../docs/database/create_family_first_result_attempt_ownership_foundation.sql", import.meta.url), "utf8");
const validation = readFileSync(new URL("database/validate_family_first_result_attempt_ownership_foundation.sql", import.meta.url), "utf8");
const design = readFileSync(new URL("../docs/database/design_family_first_training_write_cutover.md", import.meta.url), "utf8");

test("result and attempt foundation changes only compatibility nullability and internal ACT helper", () => {
  assert.match(sql, /^BEGIN;/);
  for (const table of ["workout_results", "workout_session_attempts"]) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table}[\\s\\S]*?ALTER COLUMN athlete_user_id DROP NOT NULL`));
    assert.match(sql, new RegExp(`${table}_owner_present[\\s\\S]*?CHECK \\(athlete_id IS NOT NULL OR athlete_user_id IS NOT NULL\\)`));
  }
  assert.match(sql, /CREATE OR REPLACE FUNCTION private\.can_act_for_training_session\(p_session_id uuid\)[\s\S]*?STABLE[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path TO ''/);
  assert.match(sql, /session\.athlete_id IS NOT NULL[\s\S]*?private\.can_act_for_training\(session\.athlete_id\)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION private\.can_act_for_training_session\(uuid\)[\s\S]*?FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(sql, /GRANT EXECUTE|CREATE POLICY|DROP POLICY|workout_results_insert|workout_session_events_insert|register_my_workout_session_attempt|finalize_my_workout_session_attempt|sync_session_from_result|CREATE TRIGGER|DROP TRIGGER|actor.*profile/i);
  assert.match(sql, /COMMIT;\s*$/);
});

test("validation preserves legacy execution while proving child execution remains unavailable", () => {
  for (const phrase of [
    "Historical result durable ownership changed or disagrees with session",
    "Current result RLS allowed premature child execution",
    "Current registration RPC allowed premature child execution",
    "Current self-athlete result INSERT or completion synchronization failed",
    "Current self-athlete registration path unavailable",
    "Current finalization RPC unavailable",
    "Historical result or attempt immutability changed",
    "Validation fixture count differs; existing completion or telemetry history may have changed",
    "Guardian with training permission was denied session ACT",
    "Non-guardian actor received session ACT authority",
  ]) assert.match(validation, new RegExp(phrase));
  assert.match(validation, /^-- Execute only after[\s\S]*BEGIN;/);
  assert.doesNotMatch(validation, /\),\s*\(gen_random_uuid\(\), 'Result attempt sibling'[\s\S]*?RETURNING id INTO v_child/);
  assert.match(validation, /ROLLBACK;\s*$/);
});

test("design keeps session-centric execution and requires athlete-scoped recovery before child use", () => {
  assert.match(design, /Player routes are session-centric/);
  assert.match(design, /partition bundles\/checkpoints\/outbox\/flush locks by durable `athleteId`/);
  assert.match(design, /Browser never obtains service-role credentials/);
});
