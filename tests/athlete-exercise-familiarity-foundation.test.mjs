import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase/migrations/20260929090000_create_athlete_exercise_familiarity.sql", import.meta.url), "utf8");

test("familiarity is a deletion-safe athlete plus semantic-exercise projection", () => {
  assert.match(sql, /CREATE TABLE public\.athlete_exercise_familiarity/);
  assert.match(sql, /athlete_id uuid NOT NULL\s+REFERENCES public\.athletes\(id\) ON DELETE RESTRICT/);
  assert.match(sql, /exercise_id uuid NOT NULL/);
  assert.doesNotMatch(sql, /exercise_id uuid[^,;]*REFERENCES public\.exercises/);
  assert.match(sql, /PRIMARY KEY \(athlete_id, exercise_id\)/);
  assert.match(sql, /first_completed_at timestamptz NOT NULL/);
});

test("only completed events from immutable prescription semantics materialize", () => {
  const trigger = sql.slice(sql.indexOf("CREATE FUNCTION private.materialize_athlete_exercise_familiarity"), sql.indexOf("-- Backfill"));
  assert.match(trigger, /OLD\.finalization_state IS DISTINCT FROM 'finalized_completed'/);
  assert.match(trigger, /NEW\.finalization_state = 'finalized_completed'/);
  assert.match(trigger, /event\.event_type = 'exercise_completed'/);
  assert.doesNotMatch(trigger, /exercise_skipped/);
  assert.match(trigger, /training_session_prescriptions/);
  assert.match(trigger, /step\.value->>'exercise_id'/);
  assert.match(trigger, /step\.value->>'workout_exercise_id' = event\.workout_exercise_id::text/);
  assert.match(trigger, /ON CONFLICT \(athlete_id, exercise_id\) DO UPDATE/);
  assert.match(trigger, /LEAST\(\s*public\.athlete_exercise_familiarity\.first_completed_at,\s*EXCLUDED\.first_completed_at\s*\)/);
});

test("projection has bounded established-athlete reads and no client mutations", () => {
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON public\.athlete_exercise_familiarity FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT SELECT ON public\.athlete_exercise_familiarity TO authenticated/);
  assert.match(sql, /USING \(private\.can_view_athlete\(athlete_id\)\)/);
  assert.doesNotMatch(sql, /FOR INSERT TO authenticated|FOR UPDATE TO authenticated|FOR DELETE TO authenticated/);
  assert.match(sql, /SECURITY DEFINER\s+SET search_path TO ''/);
});

test("backfill requires finalized canonical Measurement V1 completion evidence", () => {
  const backfill = sql.slice(sql.indexOf("-- Backfill"));
  for (const fragment of [
    "attempt.finalization_state = 'finalized_completed'",
    "attempt.measurement_version = 1",
    "attempt.measurement_quality = 'complete'",
    "result.id = attempt.workout_result_id",
    "event.event_type = 'exercise_completed'",
    "step.value->>'exercise_id'",
  ]) assert.match(backfill, new RegExp(fragment.replaceAll(".", "\\.")));
  assert.doesNotMatch(backfill, /exercise_skipped/);
  assert.match(backfill, /min\(attempt\.finalized_at\)/);
  assert.match(backfill, /ON CONFLICT \(athlete_id, exercise_id\) DO UPDATE/);
  assert.match(backfill, /LEAST\(\s*public\.athlete_exercise_familiarity\.first_completed_at,\s*EXCLUDED\.first_completed_at\s*\)/);
});

test("rollback-only integration coverage exercises projection, authorization, and deletion", () => {
  const integration = readFileSync(new URL("database/validate_athlete_exercise_familiarity.sql", import.meta.url), "utf8");
  for (const phrase of [
    "completed/skipped or sibling projection semantics are incorrect",
    "retry created duplicate familiarity",
    "team transfer reset familiarity",
    "exercise deletion or replacement incorrectly changed history",
    "guardian could not read athlete familiarity",
    "self read leaked sibling or failed",
    "ordinary authenticated role directly inserted familiarity",
    "ordinary authenticated role directly updated familiarity",
    "ordinary authenticated role directly deleted familiarity",
    "anon directly inserted familiarity",
    "anon directly updated familiarity",
    "anon directly deleted familiarity",
    "public.finalize_my_workout_session_attempt",
    "later-first timestamp order did not retain the earliest trusted value",
  ]) assert.match(integration, new RegExp(phrase));
  assert.match(integration, /ROLLBACK;/);
});
