import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../docs/database/create_family_first_team_athlete_roster_writer.sql", import.meta.url), "utf8");
const validator = readFileSync(new URL("database/validate_family_first_team_athlete_roster_writer.sql", import.meta.url), "utf8");

test("family roster writer is a narrow current-actor SECURITY DEFINER RPC", () => {
  assert.match(sql, /FUNCTION public\.add_my_managed_athlete_to_team\(\s*p_team_id uuid,\s*p_athlete_id uuid/);
  assert.match(sql, /RETURNS TABLE \(team_id uuid, athlete_id uuid\)/);
  assert.match(sql, /SECURITY DEFINER[\s\S]*SET search_path TO ''/);
  assert.match(sql, /ALTER FUNCTION public\.add_my_managed_athlete_to_team\(uuid, uuid\) OWNER TO postgres/);
  assert.match(sql, /v_actor uuid := \(SELECT auth\.uid\(\)\)/);
  assert.match(sql, /IF v_actor IS NULL[\s\S]*Authentication required/);
  assert.doesNotMatch(sql, /p_(?:actor|profile|guardian|coach|role|permission|athlete_user)_id/);
});

test("writer requires independent team-roster and athlete-management authority", () => {
  assert.match(sql, /NOT private\.can_manage_roster\(p_team_id\)[\s\S]*OR NOT private\.can_manage_athlete\(p_athlete_id\)/);
  assert.match(sql, /Roster addition is not authorized/);
  assert.match(sql, /athlete\.status = 'active'/);
  assert.match(sql, /FROM public\.teams AS team WHERE team\.id = p_team_id/);
  assert.match(validator, /roster-managing coach claimed an unmanaged athlete by UUID/);
  assert.match(validator, /coach guardian with manage=false added athlete/);
  assert.match(validator, /assistant without guardian relationship added sibling athlete/);
  assert.match(validator, /inactive athlete was rostered/);
  assert.match(validator, /NULL team was accepted/);
  assert.match(validator, /unknown athlete was accepted/);
  assert.match(validator, /guardian without roster authority added athlete/);
  assert.match(validator, /admin alone added athlete/);
  assert.match(validator, /revoked guardian added athlete/);
});

test("writer is the only new write boundary and has hardened grants", () => {
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.add_my_managed_athlete_to_team\(uuid, uuid\)[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.add_my_managed_athlete_to_team\(uuid, uuid\)[\s\S]*TO authenticated/);
  assert.doesNotMatch(sql, /GRANT INSERT ON public\.team_athlete_memberships/);
  assert.doesNotMatch(sql, /auth\.users|public\.profiles|public\.team_memberships|athlete_user_id/);
  assert.doesNotMatch(sql, /CREATE POLICY|DROP POLICY|ALTER TABLE|training_plan_assignments|training_sessions|workout_results|workout_session_attempts|workout_session_events/);
  assert.match(validator, /authenticated direct roster insert bypass succeeded/);
});

test("duplicate additions are serialized and preserve durable-only child identity", () => {
  const executableSql = sql.replace(/--.*$/gm, "");
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /SELECT membership\.\* INTO v_membership/);
  assert.match(sql, /IF FOUND THEN[\s\S]*RETURN QUERY SELECT v_membership\.team_id, v_membership\.athlete_id/);
  assert.doesNotMatch(executableSql, /ON CONFLICT/);
  assert.match(sql, /created_by_profile_id[\s\S]*v_actor/);
  assert.match(validator, /No-auth validation athlete unexpectedly has a profile/);
  assert.match(validator, /coach guardian create or retry was not idempotent/);
  assert.match(validator, /canonical assignment did not preserve no-auth child ownership/);
  assert.match(validator, /ROLLBACK;\s*$/);
});
