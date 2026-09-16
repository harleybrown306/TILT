import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../docs/database/create_family_first_training_ownership_foundation.sql", import.meta.url), "utf8");
const notes = readFileSync(new URL("../docs/database/create_family_first_training_ownership_foundation.md", import.meta.url), "utf8");
const validation = readFileSync(new URL("database/validate_family_first_training_ownership_foundation.sql", import.meta.url), "utf8");
const owners = ["training_plan_assignments", "training_sessions", "workout_results", "workout_session_attempts"];

test("training ownership foundation is additive and exact-parity guarded", () => {
  for (const table of owners) {
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} ADD COLUMN athlete_id uuid`));
    assert.match(migration, new RegExp(`UPDATE public\\.${table} SET athlete_id = athlete_user_id WHERE athlete_id IS NULL`));
    assert.match(migration, new RegExp(`public\\.${table} WHERE athlete_id IS NULL OR athlete_id <> athlete_user_id`));
  }
  assert.match(migration, /legacy athlete owner has no athletes row/);
  assert.match(migration, /Existing parallel athlete ownership conflicts/);
  assert.doesNotMatch(migration, /ON CONFLICT|DO NOTHING|CREATE TRIGGER|CREATE POLICY|DROP POLICY|CREATE FUNCTION|ALTER COLUMN athlete_user_id|DROP COLUMN/);
});

test("new durable ownership FKs restrict deletion and legacy history stays intact", () => {
  for (const table of owners) {
    assert.match(migration, new RegExp(`CONSTRAINT ${table}_athlete_id_fkey[\\s\\S]*?REFERENCES public\\.athletes\\(id\\) ON DELETE RESTRICT`));
    assert.match(migration, new RegExp(`CREATE INDEX ${table}_athlete_id_idx ON public\\.${table} \\(athlete_id\\) WHERE athlete_id IS NOT NULL`));
  }
  assert.doesNotMatch(migration, /athlete_id[\s\S]{0,160}ON DELETE CASCADE/);
  assert.match(validation, /Historical legacy FK protection changed/);
  assert.match(validation, /Historical athlete ownership cascades are not permitted/);
});

test("derived event and prescription ownership remains nonredundant", () => {
  assert.doesNotMatch(migration, /ALTER TABLE public\.workout_session_events ADD COLUMN athlete_id/);
  assert.doesNotMatch(migration, /ALTER TABLE public\.training_session_prescriptions ADD COLUMN athlete_id/);
  assert.match(notes, /append-only event’s owner is parent session\/attempt/);
  assert.match(notes, /immutable prescription’s owner is parent session/);
});

test("transition keeps legacy writers and future parent-managed ownership explicit", () => {
  assert.doesNotMatch(migration, /ADD COLUMN athlete_id uuid NOT NULL/);
  assert.doesNotMatch(migration, /CHECK \(athlete_id/);
  assert.match(notes, /all current writers supply only non-null `athlete_user_id`/);
  assert.match(notes, /cannot create a complete training row for an athlete without an auth account/);
  assert.match(validation, /Parent-managed athlete fixture unexpectedly has a profile/);
  assert.match(validation, /Parent-managed athlete is not structurally referenceable/);
  assert.match(validation, /ROLLBACK;\s*$/);
});
