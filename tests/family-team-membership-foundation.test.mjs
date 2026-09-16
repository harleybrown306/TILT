import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../docs/database/create_family_first_team_membership_foundation.sql", import.meta.url), "utf8");
const validation = readFileSync(new URL("database/validate_family_first_team_membership_foundation.sql", import.meta.url), "utf8");

test("family-first team membership migration is additive and preserves legacy membership identifiers", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.team_staff_memberships/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.team_athlete_memberships/);
  assert.match(migration, /legacy\.id,[\s\S]*legacy\.team_id,[\s\S]*legacy\.user_id/);
  assert.doesNotMatch(migration, /ALTER TABLE public\.team_memberships/);
  assert.doesNotMatch(migration, /DROP TABLE public\.team_memberships/);
  assert.doesNotMatch(migration, /UPDATE public\.team_memberships/);
  assert.doesNotMatch(migration, /ON CONFLICT(?:\s*\([^)]*\))?\s+DO NOTHING/);
});

test("staff and athlete rows use separate identity references and restrictive foreign keys", () => {
  assert.match(migration, /CREATE TYPE public\.team_staff_role AS ENUM \('coach', 'assistant_coach'\)/);
  assert.match(migration, /profile_id uuid NOT NULL REFERENCES public\.profiles\(id\) ON DELETE RESTRICT/);
  assert.match(migration, /athlete_id uuid NOT NULL REFERENCES public\.athletes\(id\) ON DELETE RESTRICT/);
  assert.match(migration, /team_id uuid NOT NULL REFERENCES public\.teams\(id\) ON DELETE RESTRICT/);
  assert.match(migration, /team_staff_memberships_team_profile_unique UNIQUE \(team_id, profile_id\)/);
  assert.match(migration, /team_athlete_memberships_team_athlete_unique UNIQUE \(team_id, athlete_id\)/);
});

test("athlete backfill refuses to invent missing athlete identities", () => {
  assert.match(migration, /Cannot backfill team athlete memberships/);
  assert.match(migration, /LEFT JOIN public\.athletes AS athlete ON athlete\.id = legacy\.user_id/);
  assert.match(migration, /WHERE legacy\.role = 'athlete' AND athlete\.id IS NULL/);
});

test("backfills require exact one-to-one parity and fail on unexpected conflicts", () => {
  const staffBackfill = migration.slice(
    migration.indexOf("INSERT INTO public.team_staff_memberships"),
    migration.indexOf("INSERT INTO public.team_athlete_memberships")
  );
  const athleteBackfill = migration.slice(
    migration.indexOf("INSERT INTO public.team_athlete_memberships"),
    migration.indexOf("ALTER TABLE public.team_staff_memberships")
  );
  assert.match(staffBackfill, /legacy\.id/);
  assert.match(athleteBackfill, /legacy\.id/);
  assert.doesNotMatch(staffBackfill, /ON CONFLICT/);
  assert.doesNotMatch(athleteBackfill, /ON CONFLICT/);
  assert.match(validation, /Legacy staff backfill mismatch/);
  assert.match(validation, /Legacy athlete backfill mismatch/);
});

test("new membership tables are read-only to clients and do not grant team authority", () => {
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON public\.team_staff_memberships, public\.team_athlete_memberships/);
  assert.match(migration, /GRANT SELECT ON public\.team_staff_memberships, public\.team_athlete_memberships/);
  assert.doesNotMatch(migration, /CREATE POLICY [^\n]+(?:insert|update|delete)/i);
  assert.match(migration, /private\.can_view_athlete_identity\(athlete_id\)/);
  assert.match(migration, /private\.is_admin\(\(SELECT auth\.uid\(\)\)\)/);
});

test("rollback-only validation covers parallel backfill, no-write RLS, and parent-managed athletes", () => {
  assert.match(validation, /Legacy staff backfill mismatch/);
  assert.match(validation, /Legacy athlete backfill mismatch/);
  assert.match(validation, /Duplicate team staff membership was accepted/);
  assert.match(validation, /Duplicate team athlete membership was accepted/);
  assert.match(validation, /Authenticated profile self-promoted to staff/);
  assert.match(validation, /Authenticated profile updated staff membership/);
  assert.match(validation, /Authenticated profile deleted staff membership/);
  assert.match(validation, /Guardian attached child to arbitrary team/);
  assert.match(validation, /Authenticated profile updated athlete membership/);
  assert.match(validation, /Authenticated profile deleted athlete membership/);
  assert.match(validation, /Self-linked athlete joined arbitrary team/);
  assert.match(validation, /Platform admin automatically became team staff/);
  assert.match(validation, /Parent-managed roster athlete/);
  assert.match(validation, /Historical training rows changed during membership validation/);
  assert.match(validation, /ROLLBACK;\s*$/);
});
