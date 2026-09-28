import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../supabase/migrations/20260928050000_create_team_athlete_feedback_history_reader.sql", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/app/teams/[teamId]/athletes/[athleteId]/page.tsx", import.meta.url), "utf8");
const validator = readFileSync(new URL("database/validate_team_athlete_feedback_history.sql", import.meta.url), "utf8");

test("staff feedback history is a narrowly scoped, hardened projection", () => {
  assert.match(migration, /CREATE FUNCTION public\.list_my_team_athlete_workout_feedback\(\s*p_team_id uuid,\s*p_athlete_id uuid/);
  assert.match(migration, /RETURNS TABLE \(\s*scheduled_date date,\s*workout_name text,\s*q1_response_state text,\s*selected_exercise_label text,\s*coach_note text/);
  assert.match(migration, /SECURITY DEFINER[\s\S]*SET search_path TO ''/);
  assert.match(migration, /v_actor uuid := \(SELECT auth\.uid\(\)\)/);
  assert.match(migration, /team_staff_memberships AS staff[\s\S]*team_athlete_memberships AS roster[\s\S]*staff\.team_id = p_team_id[\s\S]*staff\.profile_id = v_actor[\s\S]*roster\.athlete_id = p_athlete_id/);
  assert.match(migration, /session\.team_id = p_team_id[\s\S]*session\.athlete_id = p_athlete_id[\s\S]*result\.athlete_id = p_athlete_id/);
  assert.match(migration, /result\.athlete_user_id IS NOT DISTINCT FROM session\.athlete_user_id/);
  assert.match(migration, /other_result\.training_session_id = session\.id[\s\S]*other_result\.id <> result\.id/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.list_my_team_athlete_workout_feedback\(uuid, uuid\)[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.list_my_team_athlete_workout_feedback\(uuid, uuid\)[\s\S]*TO authenticated/);
  assert.doesNotMatch(migration, /can_view_team_analytics|is_admin|workout_session_attempts|workout_session_events|result_data|feedback_id/);
});

test("rollback validator covers current staff access, revocation, mismatch, and table isolation", () => {
  assert.match(validator, /^BEGIN;/m);
  assert.match(validator, /VALUES \(v_coach\), \(v_assistant\)/);
  assert.match(validator, /v_former_staff[\s\S]*v_guardian[\s\S]*v_admin[\s\S]*v_self_profile/);
  assert.match(validator, /requested athlete\/team mismatch/);
  assert.match(validator, /projection crossed team or athlete ownership/);
  assert.match(validator, /roster removal did not revoke access while preserving historical feedback/);
  assert.match(validator, /PERFORM 1 FROM public\.workout_result_feedback/);
  assert.match(validator, /set_config\('request\.jwt\.claim\.sub', '', true\)/);
  assert.match(validator, /ROLLBACK;/);
});

test("athlete detail renders only the staff feedback projection and factual feedback states", () => {
  assert.match(page, /rpc\("list_my_team_athlete_workout_feedback", \{[\s\S]*p_team_id: teamId,[\s\S]*p_athlete_id: athleteId/);
  assert.match(page, /Post-workout feedback/);
  assert.match(page, /Most challenging: \$\{item\.selected_exercise_label/);
  assert.match(page, /Most challenging: None/);
  assert.match(page, /Most challenging: Skipped/);
  assert.match(page, /item\.coach_note/);
  assert.doesNotMatch(page, /attention|sentiment|risk score|badge|notification|workout_result_feedback|workout_session_events|workout_session_attempts.*feedback/i);
});
