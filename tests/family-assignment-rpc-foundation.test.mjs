import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../docs/database/create_family_first_assignment_rpc_foundation.sql", import.meta.url), "utf8");
const validation = readFileSync(new URL("database/validate_family_first_assignment_rpc_foundation.sql", import.meta.url), "utf8");

test("canonical assignment RPC has a narrow authenticated, current-actor signature", () => {
  assert.match(sql, /FUNCTION public\.assign_my_team_training\([\s\S]*p_batch_id uuid[\s\S]*p_athlete_ids uuid\[\]/);
  assert.match(sql, /SECURITY DEFINER[\s\S]*SET search_path TO ''/);
  assert.match(sql, /v_actor uuid := \(SELECT auth\.uid\(\)\)/);
  assert.match(sql, /IF v_actor IS NULL[\s\S]*Authentication required/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.assign_my_team_training[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.assign_my_team_training[\s\S]*TO authenticated/);
  assert.doesNotMatch(sql, /p_(?:actor|profile|assigned_by)_id/);
});

test("transition supports old rows while refusing ownerless assignment and session rows", () => {
  for (const table of ["training_plan_assignments", "training_sessions"]) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table}[\\s\\S]*ALTER COLUMN athlete_user_id DROP NOT NULL[\\s\\S]*${table}_owner_present[\\s\\S]*athlete_id IS NOT NULL OR athlete_user_id IS NOT NULL`));
  }
  assert.doesNotMatch(sql, /ALTER TABLE public\.(workout_results|workout_session_attempts)[\s\S]*DROP NOT NULL/);
  assert.doesNotMatch(sql, /SET NOT NULL|athlete_id\s*=\s*athlete_user_id|CREATE TRIGGER/);
  assert.match(sql, /athlete_id IS NULL[\s\S]*athlete_user_id IS NOT NULL/);
});

test("generator is trigger-only and propagates both ownership fields", () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION private\.generate_sessions_for_assignment\(\)[\s\S]*SECURITY DEFINER[\s\S]*SET search_path TO ''/);
  assert.match(sql, /REVOKE ALL ON FUNCTION private\.generate_sessions_for_assignment\(\)[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION private\.generate_sessions_for_assignment/);
  assert.match(sql, /INSERT INTO public\.training_sessions \([\s\S]*athlete_id, athlete_user_id/);
  assert.match(sql, /NEW\.athlete_id, NEW\.athlete_user_id/);
  assert.doesNotMatch(sql, /ALTER TABLE public\.training_session_prescriptions ADD COLUMN athlete_id/);
  assert.match(validation, /legacy assignment trigger generation failed/);
  assert.match(validation, /legacy-shaped authenticated direct session did not generate prescription/);
});

test("existing retries require complete immutable materialization before success", () => {
  const existing = sql.indexOf("IF FOUND THEN");
  const newBatchAuthorization = sql.indexOf("Only a new batch is authorized");
  assert.ok(existing > 0 && existing < newBatchAuthorization, "existing batches must be recognized before mutable authorization");
  assert.match(sql, /Assignment idempotency integrity failure/);
  assert.match(sql, /count\(session\.id\) <> 1/);
  assert.match(sql, /session\.athlete_id IS DISTINCT FROM assignment\.athlete_id/);
  assert.match(sql, /session\.athlete_user_id IS DISTINCT FROM assignment\.athlete_user_id/);
  assert.match(sql, /session\.workout_id IS DISTINCT FROM item\.workout_id/);
  assert.match(sql, /session\.scheduled_date IS DISTINCT FROM assignment\.start_date \+ item\.day_offset/);
  assert.match(sql, /count\(prescription\.session_id\) <> 1/);
  assert.match(sql, /prescription\.workout_id IS DISTINCT FROM session\.workout_id/);
  for (const message of [
    "corrupt retry with missing session succeeded",
    "corrupt retry with missing prescription succeeded",
    "corrupt retry with inconsistent session ownership succeeded",
    "retry after authority revocation created new work",
    "retry after plan archive created new work",
    "retry with different request succeeded",
  ]) assert.match(validation, new RegExp(message));
});

test("rollback validation isolates authority and executes direct session checks as authenticated", () => {
  assert.match(validation, /UPDATE public\.training_plans SET owner_user_id = v_guardian/);
  assert.match(validation, /UPDATE public\.training_plans SET owner_user_id = v_admin/);
  assert.match(validation, /guardian received team assignment authority/);
  assert.match(validation, /admin received team assignment authority/);
  assert.match(validation, /SET LOCAL ROLE authenticated/);
  assert.match(validation, /authenticated direct durable session bypass succeeded/);
  assert.match(validation, /ROLLBACK;\s*$/);
});
