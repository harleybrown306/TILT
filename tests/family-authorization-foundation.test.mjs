import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../docs/database/create_family_first_authorization_foundation.sql", import.meta.url), "utf8");
const validation = readFileSync(new URL("database/validate_family_first_authorization_foundation.sql", import.meta.url), "utf8");

test("canonical authorization helpers are additive current-actor overloads", () => {
  for (const signature of [
    "is_team_staff(p_team_id uuid)", "is_team_coach(p_team_id uuid)", "can_manage_team(p_team_id uuid)",
    "can_manage_roster(p_team_id uuid)", "can_view_athlete(p_athlete_id uuid)",
    "can_manage_athlete(p_athlete_id uuid)", "can_act_for_training(p_athlete_id uuid)"
  ]) assert.match(migration, new RegExp(`FUNCTION private\\.${signature.replace(/[()]/g, "\\$&")}`));
  assert.doesNotMatch(migration, /ALTER FUNCTION private\.(is_team_coach|can_manage_team|can_manage_roster)\(uuid, uuid\)/);
  assert.doesNotMatch(migration, /ALTER POLICY|DROP POLICY|CREATE POLICY/);
});

test("family capabilities remain distinct and source the actor from auth.uid", () => {
  assert.match(migration, /FUNCTION private\.can_view_athlete\(p_athlete_id uuid\)/);
  assert.match(migration, /FUNCTION private\.can_manage_athlete\(p_athlete_id uuid\)/);
  assert.match(migration, /FUNCTION private\.can_act_for_training\(p_athlete_id uuid\)/);
  assert.doesNotMatch(migration, /FUNCTION private\.can_(?:view|manage)_athlete\(p_athlete_id uuid, p_profile_id uuid\)/);
  assert.match(migration, /relationship\.profile_id = \(SELECT auth\.uid\(\)\)/);
  const action = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION private.can_act_for_training"));
  assert.doesNotMatch(action, /is_admin|team_staff_memberships/);
});

test("team authority uses profiles for staff and athletes for roster targeting", () => {
  assert.match(migration, /team_staff_memberships AS membership[\s\S]*membership\.profile_id = \(SELECT auth\.uid\(\)\)/);
  assert.match(migration, /team_athlete_memberships AS membership[\s\S]*membership\.athlete_id = p_athlete_id/);
  assert.match(migration, /can_manage_roster\(p_team_id\)[\s\S]*is_athlete_on_team\(p_team_id, p_athlete_id\)/);
  assert.match(migration, /can_view_team_analytics[\s\S]*private\.is_admin/);
});

test("internal identity lookup is not authenticated-callable and helpers use secure conventions", () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION private\.is_athlete_on_team\(uuid, uuid\) FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(migration, /GRANT EXECUTE ON FUNCTION private\.is_athlete_on_team/);
  const callable = [
    "is_team_staff(uuid)", "is_team_coach(uuid)", "can_manage_team(uuid)", "can_manage_roster(uuid)",
    "can_manage_team_staff(uuid)", "can_view_team_analytics(uuid)",
    "can_assign_team_athlete_training(uuid, uuid)", "can_view_athlete(uuid)",
    "can_manage_athlete(uuid)", "can_act_for_training(uuid)"
  ];
  for (const signature of callable) {
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION private\\.${signature.replace(/[()]/g, "\\$&")} FROM PUBLIC, anon, authenticated`));
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION private\\.${signature.replace(/[()]/g, "\\$&")} TO authenticated`));
  }
  const helpers = migration.match(/CREATE OR REPLACE FUNCTION private\.[\s\S]*?\$function\$;/g) ?? [];
  assert.equal(helpers.length, 11);
  for (const helper of helpers) {
    assert.match(helper, /SECURITY DEFINER/);
    assert.match(helper, /SET search_path TO ''/);
  }
  assert.doesNotMatch(migration, /p_(?:profile|actor|user)_id/);
  assert.doesNotMatch(migration, /EXECUTE\s+['"]/);
});

test("rollback-only validation covers the family, staff, admin, revocation, and parent-managed matrix", () => {
  for (const message of [
    "Self-linked athlete lacks own view or training action", "Authorized guardian lacks expected child authority",
    "Guardian acted for child without training permission", "Unrelated profile received athlete authority",
    "Coach authority did not remain team-scoped", "Coach viewed or assigned unrelated athlete",
    "Assistant authority did not follow intended team scope", "Platform admin exceeded explicit support visibility",
    "Revoked relationship retained authority", "Parent-managed fixture unexpectedly has a profile",
    "Authenticated authorization helper accepts a caller-supplied profile ID"
  ]) assert.match(validation, new RegExp(message));
  assert.match(validation, /ROLLBACK;\s*$/);
});
