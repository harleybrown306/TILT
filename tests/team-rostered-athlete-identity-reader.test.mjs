import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../docs/database/create_team_rostered_athlete_identity_reader.sql", import.meta.url), "utf8");
const validator = readFileSync(new URL("database/validate_team_rostered_athlete_identity_reader.sql", import.meta.url), "utf8");

test("rostered athlete reader is a narrow authenticated, current-actor projection", () => {
  assert.match(sql, /FUNCTION public\.list_my_team_rostered_athlete_identities\(\s*p_team_id uuid/);
  assert.match(sql, /RETURNS TABLE \([\s\S]*athlete_id uuid,[\s\S]*display_name text,[\s\S]*graduation_year integer,[\s\S]*status text/);
  assert.match(sql, /SECURITY DEFINER[\s\S]*SET search_path TO ''/);
  assert.match(sql, /v_actor uuid := \(SELECT auth\.uid\(\)\)/);
  assert.match(sql, /private\.is_team_staff\(p_team_id\)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE[\s\S]*TO authenticated/);
});

test("reader has no write, management, act, relationship, profile, or legacy identity boundary", () => {
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE)\b/);
  assert.doesNotMatch(sql, /can_manage_athlete|can_act_for_training|athlete_profile_relationships|profiles|team_memberships|athlete_user_id|auth\.users/);
  assert.match(sql, /FROM public\.team_athlete_memberships AS roster[\s\S]*JOIN public\.athletes AS athlete/);
});

test("rollback validation covers staff scope, no-auth children, non-escalation, and privacy", () => {
  for (const phrase of [
    "coach could not read rostered no-auth child projection",
    "assistant could not read rostered no-auth child projection",
    "non-staff actor read another team roster",
    "guardian identity view regressed",
    "admin support identity view regressed",
    "staff roster view broadened manage or act",
    "staff roster view broadened session ACT",
    "staff roster view exposed family relationships",
    "No-auth fixture received a profile",
    "self identity view regressed",
  ]) assert.match(validator, new RegExp(phrase));
  assert.match(validator, /v_guardian uuid/);
  assert.match(validator, /v_non_staff_actor uuid/);
  assert.match(validator, /FOR v_non_staff_actor IN SELECT v_guardian UNION ALL SELECT v_other_staff/);
  assert.doesNotMatch(validator, /FOR v_guardian IN/);
  assert.match(validator, /ROLLBACK;\s*$/);
});
