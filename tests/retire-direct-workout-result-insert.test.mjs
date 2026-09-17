import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../docs/database/retire_direct_authenticated_workout_result_insert.sql", import.meta.url), "utf8");
const validation = readFileSync(new URL("database/validate_retire_direct_workout_result_insert.sql", import.meta.url), "utf8");
const completion = readFileSync(new URL("../docs/database/create_self_compatible_canonical_completion_rpc.sql", import.meta.url), "utf8");
const design = readFileSync(new URL("../docs/database/design_family_first_training_write_cutover.md", import.meta.url), "utf8");

test("direct authenticated workout result INSERT is retired without changing writers", () => {
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /DROP POLICY workout_results_insert ON public\.workout_results/);
  assert.match(sql, /REVOKE INSERT ON public\.workout_results[\s\S]*?FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /REVOKE INSERT \([\s\S]*?athlete_id,[\s\S]*?athlete_user_id,[\s\S]*?result_data,[\s\S]*?updated_at[\s\S]*?\) ON public\.workout_results[\s\S]*?FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(sql, /CREATE OR REPLACE FUNCTION|CREATE POLICY|workout_results_select|workout_session_attempt|workout_session_events/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.match(completion, /CREATE OR REPLACE FUNCTION public\.complete_my_training_session/);
});

test("rollback validator proves denial matrix and retained canonical self pipeline", () => {
  for (const phrase of [
    "Authenticated direct workout result INSERT was allowed",
    "Anon direct workout result INSERT was allowed",
    "Canonical self completion failed after direct INSERT retirement",
    "Canonical completion retry was not idempotent",
    "Guardian child completion was allowed before family cutover",
    "Guardian child attempt registration was allowed before family cutover",
    "Late event was accepted after finalization",
    "Ordinary result privilege hardening failed",
    "Historical result constraint protection changed",
    "Validation fixture count differs; historical results, attempts, or events may have changed",
  ]) assert.match(validation, new RegExp(phrase));
  assert.match(validation, /public\.register_my_workout_session_attempt/);
  assert.match(validation, /public\.finalize_my_workout_session_attempt/);
  assert.match(validation, /measurement_quality='complete'/);
  assert.match(validation, /^-- Execute only after[\s\S]*BEGIN;/);
  assert.match(validation, /ROLLBACK;\s*$/);
});

test("design records canonical-only result creation without family cutover", () => {
  assert.match(design, /6C\.2C — retire direct authenticated result INSERT/);
  assert.match(design, /Ordinary authenticated clients cannot[\s\S]{0,40}create `workout_results` directly/);
  assert.match(design, /Child execution[\s\S]{0,30}disabled/);
});
