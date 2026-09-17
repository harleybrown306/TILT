import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../docs/database/create_family_first_training_execution_authorization.sql", import.meta.url), "utf8");
const validator = readFileSync(new URL("database/validate_family_first_training_execution_authorization.sql", import.meta.url), "utf8");

test("family execution SQL replaces self-only execution gates with session-scoped ACT", () => {
  for (const signature of [
    "public.complete_my_training_session(p_session_id uuid)",
    "private.register_workout_session_attempt_from_event(",
    "private.materialize_workout_session_attempt(p_attempt_id uuid)"
  ]) assert.match(migration, new RegExp(signature.replace(/[().]/g, "\\$&")));
  assert.match(migration, /private\.can_act_for_training_session\(p_session_id\)/);
  assert.match(migration, /private\.can_act_for_training_session\(v_session\.id\)/);
  assert.doesNotMatch(migration, /Family training completion is not enabled yet/);
  assert.doesNotMatch(migration, /v_session\.athlete_user_id IS NULL\s+OR v_session\.athlete_user_id IS DISTINCT FROM v_actor/);
});

test("attempt and result ownership remain authoritative session values", () => {
  assert.match(migration, /v_session\.athlete_id,\s*\n\s*v_session\.athlete_user_id,/);
  assert.match(migration, /a\.athlete_id IS DISTINCT FROM v_session\.athlete_id/);
  assert.match(migration, /a\.athlete_user_id IS DISTINCT FROM v_session\.athlete_user_id/);
  assert.doesNotMatch(migration, /INSERT INTO public\.workout_results[\s\S]{0,700}v_actor/);
  assert.doesNotMatch(migration, /INSERT INTO public\.workout_session_attempts[\s\S]{0,700}v_actor/);
});

test("documented records use VIEW while operational attempts and raw events require ACT", () => {
  assert.match(migration, /CREATE POLICY training_sessions_select[\s\S]*private\.can_view_athlete/);
  assert.match(migration, /CREATE POLICY training_session_prescriptions_select[\s\S]*private\.can_view_athlete/);
  assert.match(migration, /CREATE POLICY workout_results_select[\s\S]*private\.can_view_athlete/);
  assert.match(migration, /CREATE POLICY workout_session_attempts_select[\s\S]*private\.can_act_for_training_session/);
  assert.match(migration, /CREATE POLICY workout_session_events_select[\s\S]*private\.can_act_for_training_session/);
  assert.match(migration, /CREATE POLICY workout_session_events_insert[\s\S]*private\.can_act_for_training_session/);
  assert.match(migration, /attempt\.training_session_id IS DISTINCT FROM workout_session_events\.session_id/);
});

test("public entrypoints and private helpers retain narrow grants and secure definitions", () => {
  for (const signature of [
    "public.complete_my_training_session(uuid)",
    "public.register_my_workout_session_attempt(uuid, uuid)",
    "public.finalize_my_workout_session_attempt(uuid)",
    "private.register_workout_session_attempt_from_event(uuid, uuid)",
    "private.materialize_workout_session_attempt(uuid)"
  ]) assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION ${signature.replace(/[()]/g, "\\$&")}\\s*\\n?\\s*FROM PUBLIC, anon, authenticated`));
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.complete_my_training_session\(uuid\) TO authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.register_my_workout_session_attempt\(uuid, uuid\) TO authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.finalize_my_workout_session_attempt\(uuid\) TO authenticated/);
  for (const fn of migration.match(/CREATE OR REPLACE FUNCTION (?:public|private)\.(?:complete_my_training_session|register_my_workout_session_attempt|finalize_my_workout_session_attempt|register_workout_session_attempt_from_event|materialize_workout_session_attempt)[\s\S]*?\$function\$;/g) ?? []) {
    assert.match(fn, /SECURITY DEFINER/);
    assert.match(fn, /SET search_path TO ''/);
  }
});

test("rollback validator covers child ownership, role matrix, self regression, and no persistent rows", () => {
  for (const message of [
    "Guardian training=true cannot read child session",
    "Guardian training=false did not remain VIEW-only",
    "Non-family actor unexpectedly received child ACT",
    "Coach+guardian did not receive ACT from explicit guardian relationship",
    "Same-UUID self execution regressed",
    "Guardian actor was stored as athlete owner",
    "Child Measurement V1 finalization failed",
    "Anon received child VIEW"
  ]) assert.ok(validator.includes(message));
  assert.match(validator, /SET LOCAL ROLE authenticated/);
  assert.match(validator, /SET LOCAL ROLE anon/);
  assert.match(validator, /Build the deterministic one-work-block\/no-rest source inside this rollback/);
  assert.match(validator, /INSERT INTO public\.exercises/);
  assert.match(validator, /INSERT INTO public\.workouts/);
  assert.match(validator, /INSERT INTO public\.workout_exercises/);
  assert.match(validator, /ROLLBACK;\s*$/);
});

test("this phase does not alter application authorization", () => {
  const changedApplication = [
    "src/app/training/[sessionId]/page.tsx",
    "src/app/api/workout-session-events/route.ts",
    "src/components/workout/workout-player.tsx"
  ];
  for (const path of changedApplication) assert.equal(readFileSync(new URL(`../${path}`, import.meta.url), "utf8").includes("6C.3B"), false);
});
