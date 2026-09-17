import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const repair = readFileSync(
  new URL("../docs/database/grant_family_training_rls_helper_execute.sql", import.meta.url),
  "utf8"
);

test("RLS ACT helper is callable only by authenticated", () => {
  assert.match(
    repair,
    /REVOKE ALL ON FUNCTION private\.can_act_for_training_session\(uuid\)\s+FROM PUBLIC, anon, authenticated;/
  );
  assert.match(
    repair,
    /GRANT EXECUTE ON FUNCTION private\.can_act_for_training_session\(uuid\)\s+TO authenticated;/
  );
  assert.doesNotMatch(repair, /TO PUBLIC|TO anon/);
});

test("repair changes no definitions, policies, table privileges, or unrelated helpers", () => {
  assert.doesNotMatch(repair, /CREATE OR REPLACE FUNCTION|CREATE POLICY|DROP POLICY|GRANT .* ON TABLE|REVOKE .* ON TABLE/);
  const functions = repair.match(/ON FUNCTION ([^(]+\([^)]*\))/g) ?? [];
  assert.equal(functions.length, 2);
  for (const statement of functions) {
    assert.match(statement, /private\.can_act_for_training_session\(uuid\)/);
  }
});
