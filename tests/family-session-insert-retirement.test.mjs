import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../docs/database/retire_direct_authenticated_session_insert.sql", import.meta.url), "utf8");
const validation = readFileSync(new URL("database/validate_retire_direct_authenticated_session_insert.sql", import.meta.url), "utf8");
const foundation = readFileSync(new URL("../docs/database/create_family_first_assignment_rpc_foundation.sql", import.meta.url), "utf8");

test("retires only ordinary direct training-session INSERT", () => {
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /DROP POLICY training_sessions_insert ON public\.training_sessions;/);
  assert.match(sql, /REVOKE INSERT ON TABLE public\.training_sessions\s+FROM PUBLIC, anon, authenticated;/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.doesNotMatch(sql, /ALTER TABLE|CREATE OR REPLACE FUNCTION|training_plan_assignments|training_assignment_batches/);
});

test("keeps protected canonical and legacy assignment paths intact", () => {
  assert.match(foundation, /CREATE OR REPLACE FUNCTION private\.generate_sessions_for_assignment\(\)[\s\S]*SECURITY DEFINER[\s\S]*SET search_path TO ''/);
  assert.match(foundation, /REVOKE ALL ON FUNCTION private\.generate_sessions_for_assignment\(\)[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(sql, /training_plan_assignments|training_assignment_batches/);
});

test("rollback validation proves canonical generation and direct-insert denial", () => {
  assert.match(validation, /^-- Execute only after[\s\S]*BEGIN;/);
  assert.match(validation, /canonical self-athlete session generation or prescription capture failed/);
  assert.match(validation, /canonical no-auth-child session generation or prescription capture failed/);
  assert.match(validation, /canonical assistant session generation failed/);
  assert.match(validation, /authenticated direct session INSERT succeeded for actor/);
  assert.match(validation, /legacy assignment compatibility generation failed/);
  assert.match(validation, /historical completion or telemetry rows changed during validation/);
  assert.match(validation, /ROLLBACK;\s*$/);
});
