import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase/migrations/20260927181741_create_workout_result_feedback.sql", import.meta.url), "utf8");
const optionsSql = readFileSync(new URL("../supabase/migrations/20260928042853_list_workout_feedback_exercise_options.sql", import.meta.url), "utf8");

test("feedback remains result-scoped, immutable, and unexposed for direct browser access", () => {
  const table = sql.slice(
    sql.indexOf("CREATE TABLE public.workout_result_feedback"),
    sql.indexOf("ALTER TABLE public.workout_result_feedback ENABLE ROW LEVEL SECURITY"),
  );
  assert.match(sql, /CREATE TABLE public\.workout_result_feedback/);
  assert.match(sql, /workout_result_id uuid NOT NULL UNIQUE[\s\S]*?REFERENCES public\.workout_results\(id\) ON DELETE RESTRICT/);
  assert.match(sql, /submitted_by_profile_id uuid[\s\S]*?REFERENCES public\.profiles\(id\) ON DELETE SET NULL/);
  assert.doesNotMatch(table, /athlete_id uuid|team_id uuid|training_session_id uuid|jsonb/);
  assert.match(sql, /ALTER TABLE public\.workout_result_feedback ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON public\.workout_result_feedback FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(sql, /CREATE POLICY[\s\S]*workout_result_feedback/);
});

test("feedback RPCs derive subject and author and retain narrow ACLs", () => {
  const submit = sql.slice(sql.indexOf("CREATE FUNCTION public.submit_my_workout_feedback"), sql.indexOf("CREATE FUNCTION public.get_my_workout_feedback"));
  assert.match(submit, /SECURITY DEFINER[\s\S]*SET search_path TO ''/);
  assert.match(submit, /v_actor uuid := \(SELECT auth\.uid\(\)\)/);
  assert.match(submit, /private\.can_act_for_training_session\(v_session\.id\)/);
  assert.match(submit, /v_result\.athlete_id IS DISTINCT FROM v_session\.athlete_id/);
  assert.match(submit, /other_result\.training_session_id = v_session\.id[\s\S]*other_result\.id <> v_result\.id/);
  assert.match(submit, /attempt\.finalization_state = 'finalized_completed'/);
  assert.match(submit, /event\.event_type = 'exercise_completed'/);
  assert.match(submit, /ON CONFLICT ON CONSTRAINT workout_result_feedback_workout_result_id_key DO NOTHING/);
  assert.doesNotMatch(submit, /measurement_version|measurement_quality|p_athlete|p_profile|p_team|p_session/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.submit_my_workout_feedback\(uuid, text, uuid, text\)[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.submit_my_workout_feedback\(uuid, text, uuid, text\)[\s\S]*TO authenticated/);
});

test("athlete-side read deliberately excludes staff and admins", () => {
  const helper = sql.slice(sql.indexOf("CREATE FUNCTION private.can_view_athlete_workout_feedback"), sql.indexOf("CREATE FUNCTION public.submit_my_workout_feedback"));
  assert.match(helper, /relationship\.role IN \('self', 'guardian'\)/);
  assert.match(helper, /relationship\.revoked_at IS NULL/);
  assert.doesNotMatch(helper, /is_admin|team_staff_memberships|can_view_team_analytics/);
  const read = sql.slice(sql.indexOf("CREATE FUNCTION public.get_my_workout_feedback"), sql.indexOf("ALTER FUNCTION private.can_view_athlete_workout_feedback"));
  assert.match(read, /other_result\.training_session_id = v_session\.id[\s\S]*other_result\.id <> v_result\.id/);
  assert.match(sql, /NULLIF\(regexp_replace\(p_coach_note, '\^\[\[:space:\]\]\+\|\[\[:space:\]\]\+\$', '', 'g'\), ''\)/);
});

test("performed-exercise options are ACT-gated, immutable, and event-minimal", () => {
  assert.match(optionsSql, /CREATE FUNCTION public\.list_my_workout_feedback_exercise_options\(\s*p_workout_result_id uuid/);
  assert.doesNotMatch(optionsSql, /p_athlete|p_profile|p_team|p_session|p_attempt/);
  assert.match(optionsSql, /private\.can_act_for_training_session\(v_session\.id\)/);
  assert.match(optionsSql, /attempt\.finalization_state = 'finalized_completed'/);
  assert.match(optionsSql, /event\.event_type = 'exercise_completed'/);
  assert.match(optionsSql, /step\.value->>'exercise_name'/);
  assert.match(optionsSql, /ORDER BY \(step\.value->>'position'\)::integer/);
  assert.match(optionsSql, /char_length\(step\.value->>'position'\) > 10/);
  assert.match(optionsSql, /step\.value->>'position' > '2147483647'/);
  assert.doesNotMatch(optionsSql, /measurement_version|measurement_quality/);
  assert.match(optionsSql, /REVOKE ALL ON FUNCTION public\.list_my_workout_feedback_exercise_options\(uuid\)[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(optionsSql, /GRANT EXECUTE ON FUNCTION public\.list_my_workout_feedback_exercise_options\(uuid\)[\s\S]*TO authenticated/);
});
