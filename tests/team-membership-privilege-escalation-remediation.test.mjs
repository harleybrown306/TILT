import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../supabase/migrations/20261022003825_harden_team_membership_mutations.sql", import.meta.url), "utf8");
const validation = readFileSync(new URL("database/validate_team_membership_privilege_escalation_remediation.sql", import.meta.url), "utf8");

test("membership mutation policies enforce the approved role matrix", () => {
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /DROP POLICY IF EXISTS memberships_insert_roster_manager ON public\.team_memberships/);
  assert.match(migration, /DROP POLICY IF EXISTS memberships_update_roster_manager ON public\.team_memberships/);
  assert.match(migration, /DROP POLICY IF EXISTS memberships_delete_roster_manager ON public\.team_memberships/);
  assert.match(migration, /CREATE POLICY memberships_insert_roster_manager[\s\S]*FOR INSERT[\s\S]*private\.is_team_coach\(team_id\)[\s\S]*'assistant_coach'[\s\S]*'athlete'/);
  assert.match(migration, /CREATE POLICY memberships_update_roster_manager[\s\S]*FOR UPDATE[\s\S]*USING \([\s\S]*WITH CHECK \(/);
  assert.match(migration, /CREATE POLICY memberships_delete_roster_manager[\s\S]*FOR DELETE/);
  assert.equal((migration.match(/private\.is_admin\(\(SELECT auth\.uid\(\)\)\)/g) ?? []).length, 4);
  assert.equal((migration.match(/private\.is_team_coach\(team_id\)/g) ?? []).length, 4);
  assert.equal((migration.match(/private\.is_team_staff\(team_id\)/g) ?? []).length, 4);
  assert.doesNotMatch(migration, /private\.can_manage_roster\(team_id,\s*\(SELECT auth\.uid\(\)\)\)/i);
  assert.match(migration, /COMMIT;\s*$/);
});

test("rollback-only database validation covers direct API attacks, allowed operations, and mirror effects", () => {
  for (const marker of [
    "Assistant self-promotion changed legacy or canonical staff authority",
    "Assistant promoted a same-team athlete to canonical staff authority",
    "Assistant directly created coach authority",
    "Assistant removed coach authority",
    "Assistant crossed a team boundary",
    "Guardian relationship granted team-membership mutation authority",
    "Athlete promoted itself to staff",
    "Coach could not promote an athlete to assistant with an exact mirror",
    "Coach could not demote assistant to athlete without removing the mirror",
    "Assistant could not manage only an athlete membership",
    "Platform admin could not promote assistant to coach",
    "Platform admin could not delete coach authority",
  ]) assert.match(validation, new RegExp(marker));
  assert.match(validation, /SET LOCAL ROLE authenticated/);
  assert.match(validation, /has_table_privilege\('authenticated', 'public\.team_staff_memberships', 'INSERT'\)/);
  assert.match(validation, /ROLLBACK;\s*$/);
});
