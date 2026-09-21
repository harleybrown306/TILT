import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase/migrations/20260921163231_align_team_roster_identity_reader_analytics_authorization.sql", import.meta.url), "utf8");
const validator = readFileSync(new URL("database/validate_team_rostered_athlete_identity_reader.sql", import.meta.url), "utf8");

test("rostered athlete reader is a narrow authenticated, current-actor projection", () => {
  assert.match(sql, /FUNCTION public\.list_my_team_rostered_athlete_identities\(\s*p_team_id uuid/);
  assert.match(sql, /RETURNS TABLE \([\s\S]*athlete_id uuid,[\s\S]*display_name text,[\s\S]*graduation_year integer,[\s\S]*status text/);
  assert.match(sql, /SECURITY DEFINER[\s\S]*SET search_path TO ''/);
  assert.match(sql, /v_actor uuid := \(SELECT auth\.uid\(\)\)/);
  assert.match(sql, /private\.can_view_team_analytics\(p_team_id\)/);
  assert.doesNotMatch(sql, /private\.is_team_staff\(p_team_id\)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE[\s\S]*TO authenticated/);
});

test("reader has no write, management, act, relationship, profile, or legacy identity boundary", () => {
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE)\b/);
  assert.doesNotMatch(sql, /can_manage_athlete|can_act_for_training|athlete_profile_relationships|profiles|team_memberships|athlete_user_id|auth\.users/);
  assert.match(sql, /FROM public\.team_athlete_memberships AS roster[\s\S]*JOIN public\.athletes AS athlete/);
});

test("rollback validation covers the analytics-view actor matrix, no-auth children, non-escalation, and privacy", () => {
  for (const phrase of [
    "coach could not read rostered no-auth child projection",
    "assistant could not read rostered no-auth child projection",
    "platform admin not on team staff could not read rostered no-auth child projection",
    "guardian not on team staff read team roster",
    "rostered self athlete not on team staff read team roster",
    "unrelated authenticated user read team roster",
    "platform admin roster view broadened roster manage, assignment, or training ACT",
    "No-auth fixture received a profile",
  ]) assert.match(validator, new RegExp(phrase));
  assert.match(validator, /v_unrelated uuid/);
  assert.match(validator, /private\.can_manage_roster\(v_team_a\)/);
  assert.match(validator, /private\.can_assign_team_athlete_training\(v_team_a,v_child\)/);
  assert.match(validator, /private\.can_act_for_training\(v_child\)/);
  assert.match(validator, /ROLLBACK;\s*$/);
});
