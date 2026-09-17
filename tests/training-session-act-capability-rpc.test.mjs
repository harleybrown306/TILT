import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../docs/database/create_training_session_act_capability_rpc.sql", import.meta.url), "utf8");
const validator = readFileSync(new URL("database/validate_training_session_act_capability_rpc.sql", import.meta.url), "utf8");

test("public ACT capability is a narrow current-actor boolean wrapper", () => {
  assert.match(sql, /FUNCTION public\.can_act_for_training_session\(p_session_id uuid\)\s+RETURNS boolean/);
  assert.match(sql, /LANGUAGE sql\s+STABLE\s+SECURITY DEFINER\s+SET search_path TO ''/);
  assert.match(sql, /auth\.uid\(\)/);
  assert.match(sql, /private\.can_act_for_training_session\(p_session_id\)/);
  assert.doesNotMatch(sql, /p_(actor|profile|athlete|team|role|permission)/);
});

test("public ACT capability has only authenticated execution and changes no policies", () => {
  assert.match(sql, /ALTER FUNCTION public\.can_act_for_training_session\(uuid\) OWNER TO postgres/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.can_act_for_training_session\(uuid\)\s+FROM PUBLIC, anon, authenticated;/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.can_act_for_training_session\(uuid\)\s+TO authenticated;/);
  assert.doesNotMatch(sql, /CREATE POLICY|DROP POLICY|ALTER TABLE|GRANT .* ON TABLE|REVOKE .* ON TABLE|private\.can_act_for_training_session\(uuid\).*OWNER/);
});

test("rollback validator covers capability matrix, view-versus-act, and no side effects", () => {
  for (const message of [
    "Self or null/nonexistent capability result incorrect",
    "Guardian capability result incorrect",
    "VIEW-only guardian did not remain VIEW-only",
    "Non-family role received ACT capability",
    "Distinct-login self relationship did not receive ACT",
    "Coach retained ACT after guardian relationship revocation",
    "Anon executed ACT capability",
    "Capability calls changed execution or documented training rows"
  ]) assert.ok(validator.includes(message));
  assert.match(validator, /BEGIN;[\s\S]*ROLLBACK;\s*$/);
});
