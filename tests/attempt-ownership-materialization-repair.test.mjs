import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../docs/database/repair_workout_session_attempt_ownership_materialization.sql", import.meta.url), "utf8");
const validation = readFileSync(new URL("database/validate_attempt_ownership_materialization_repair.sql", import.meta.url), "utf8");
const design = readFileSync(new URL("../docs/database/design_family_first_training_write_cutover.md", import.meta.url), "utf8");

test("attempt ownership repair reconciles only proven session/result ownership", () => {
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /Attempt ownership preflight found an ambiguous or inconsistent session\/result relationship/);
  assert.match(sql, /attempt\.athlete_user_id IS DISTINCT FROM session\.athlete_user_id/);
  assert.match(sql, /result\.training_session_id IS DISTINCT FROM session\.id/);
  assert.match(sql, /result\.athlete_id IS DISTINCT FROM session\.athlete_id/);
  assert.match(sql, /result\.athlete_user_id IS DISTINCT FROM session\.athlete_user_id/);
  assert.match(sql, /UPDATE public\.workout_session_attempts AS attempt[\s\S]*?SET athlete_id = session\.athlete_id,[\s\S]*?athlete_user_id = session\.athlete_user_id/);
  assert.match(sql, /attempt\.athlete_id IS NULL[\s\S]*?session\.athlete_id IS NOT NULL/);
  assert.doesNotMatch(sql, /SET\s+athlete_id\s*=\s*\(SELECT auth\.uid\(\)\)/);
  assert.match(sql, /VALIDATE CONSTRAINT workout_session_attempts_owner_present/);
  assert.match(sql, /convalidated/);
});

test("trusted registration derives both attempt owners from the locked session", () => {
  const registration = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION private.register_workout_session_attempt_from_event"), sql.indexOf("CREATE OR REPLACE FUNCTION private.materialize_workout_session_attempt"));
  assert.match(registration, /v_session public\.training_sessions/);
  assert.match(registration, /FROM public\.training_sessions AS session[\s\S]*?FOR KEY SHARE/);
  assert.match(registration, /v_session\.athlete_user_id IS DISTINCT FROM v_actor/);
  assert.match(registration, /athlete_id,[\s\S]*?athlete_user_id,[\s\S]*?v_session\.athlete_id,[\s\S]*?v_session\.athlete_user_id/);
  assert.match(registration, /v_existing\.athlete_id IS DISTINCT FROM v_session\.athlete_id/);
  assert.match(registration, /v_existing\.athlete_user_id IS DISTINCT FROM v_session\.athlete_user_id/);
  assert.doesNotMatch(registration, /VALUES\s*\([^)]*auth\.uid\(\)/);
  assert.match(registration, /REVOKE ALL ON FUNCTION private\.register_workout_session_attempt_from_event\(uuid, uuid\)[\s\S]*?FROM PUBLIC, anon, authenticated/);
});

test("finalization preserves Measurement V1 and rejects ownership disagreement before mutation", () => {
  const materialization = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION private.materialize_workout_session_attempt"));
  assert.match(materialization, /a\.athlete_id IS DISTINCT FROM v_session\.athlete_id/);
  assert.match(materialization, /a\.athlete_user_id IS DISTINCT FROM v_session\.athlete_user_id/);
  assert.match(materialization, /r\.athlete_id IS DISTINCT FROM a\.athlete_id/);
  assert.match(materialization, /r\.athlete_user_id IS DISTINCT FROM a\.athlete_user_id/);
  for (const term of ["workout_started", "workout_completed", "timer_paused", "page_hidden", "Finalized attempt cannot be rewritten", "work_timer_progressed_ms = NULL", "rest_timer_progressed_ms = NULL"]) assert.match(materialization, new RegExp(term));
  assert.match(materialization, /REVOKE ALL ON FUNCTION private\.materialize_workout_session_attempt\(uuid\)[\s\S]*?FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /COMMIT;\s*$/);
});

test("repair changes no public authorization, result writer, or application boundary", () => {
  assert.doesNotMatch(sql, /CREATE OR REPLACE FUNCTION public\./);
  assert.doesNotMatch(sql, /complete_my_training_session|workout_results_insert|CREATE POLICY|DROP POLICY|GRANT EXECUTE/);
  assert.match(sql, /v_session\.athlete_user_id IS DISTINCT FROM v_actor/);
  assert.match(sql, /WHERE id = p_attempt_id[\s\S]*?athlete_user_id = \(SELECT auth\.uid\(\)\)/);
});

test("rollback validation covers self ownership, reconciliation guards, and denied family execution", () => {
  for (const phrase of [
    "Attempt registration did not derive both ownership columns from its session",
    "Finalization changed or lost durable attempt ownership",
    "Reconciliation did not copy the durable owner from the session",
    "Reconciliation guard accepted a missing durable session owner",
    "Reconciliation guard accepted a mismatched linked result",
    "Reconciliation guard accepted a result from another session",
    "Guardian registration was allowed before family execution cutover",
    "Owner-presence constraint did not reject both owners as NULL",
    "Validation fixture count differs; historical execution rows may have changed",
  ]) assert.match(validation, new RegExp(phrase));
  assert.match(validation, /^-- Execute only after[\s\S]*BEGIN;/);
  assert.match(validation, /ROLLBACK;\s*$/);
  assert.match(design, /6C\.2B\.1 — attempt ownership materialization repair/);
});
