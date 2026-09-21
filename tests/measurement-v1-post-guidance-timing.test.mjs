import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(new URL("../docs/database/fix_measurement_v1_post_guidance_timing.sql", import.meta.url), "utf8");
const note = readFileSync(new URL("../docs/database/fix_measurement_v1_post_guidance_timing.md", import.meta.url), "utf8");

test("Measurement V1 migration preserves structural validation but does not cap terminal wall time at prescription", () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION private\.materialize_workout_session_attempt/);
  assert.match(sql, /v_completed_work \+ v_skipped_work <> a\.prescribed_step_count/);
  assert.match(sql, /v_completed_rest \+ v_skipped_rest/);
  for (const term of ["Attempt telemetry is structurally invalid", "Attempt telemetry is incomplete", "Canonical result unavailable", "private.can_act_for_training_session"]) assert.match(sql, new RegExp(term));
  assert.match(note, /wall time since/i);
  assert.match(note, /Measurement V1 bug fix/i);
});
