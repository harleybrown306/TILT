import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../docs/database/create_family_first_athlete_identity_foundation.sql", import.meta.url), "utf8");
const validation = readFileSync(new URL("database/validate_family_first_athlete_identity_foundation.sql", import.meta.url), "utf8");

test("family-first athlete identity migration remains additive and preserves the same-UUID athlete backfill", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.athletes/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.athlete_profile_relationships/);
  assert.doesNotMatch(migration, /ALTER TABLE public\.(team_memberships|training_sessions|workout_results|workout_session_events)/);
  assert.match(migration, /JOIN public\.team_memberships AS membership/);
  assert.match(migration, /WHERE membership\.role = 'athlete'/);
  assert.match(migration, /profile\.id,[\s\S]*profile\.id,[\s\S]*'self'/);
  assert.doesNotMatch(migration, /REFERENCES public\.profiles\(id\).*athletes/i);
});

test("migration encodes active-link uniqueness, auditable revocation, and fixed graduation-year validation", () => {
  assert.match(migration, /graduation_year IS NULL OR graduation_year BETWEEN 2000 AND 2100/);
  assert.match(migration, /WHERE revoked_at IS NULL AND role = 'self'/);
  assert.match(migration, /athlete_profile_relationships_active_role_unique/);
  assert.match(migration, /athlete_profile_relationships_active_self_athlete_unique/);
  assert.match(migration, /athlete_profile_relationships_active_self_profile_unique/);
  assert.match(migration, /revoked_at IS NULL OR revoked_at >= created_at/);
});

test("new-table writes are limited to the narrow authenticated parent-create RPC", () => {
  assert.match(migration, /REVOKE ALL ON public\.athletes, public\.athlete_profile_relationships FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(migration, /CREATE POLICY [^\n]+(?:insert|update|delete)/i);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.create_my_athlete\(p_display_name text, p_graduation_year integer DEFAULT NULL\)/);
  assert.match(migration, /IF v_profile_id IS NULL/);
  assert.match(migration, /v_athlete_id uuid := gen_random_uuid\(\)/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.create_my_athlete\(text, integer\) TO authenticated/);
});

test("actor-scoped helpers derive auth.uid internally and keep admin management relationship-only", () => {
  assert.match(migration, /FUNCTION private\.can_view_athlete_identity\(p_athlete_id uuid\)/);
  assert.match(migration, /FUNCTION private\.can_manage_athlete_identity\(p_athlete_id uuid\)/);
  assert.doesNotMatch(migration, /FUNCTION private\.can_(?:view|manage)_athlete_identity\(p_athlete_id uuid, p_profile_id uuid\)/);
  assert.match(migration, /private\.is_admin\(\(SELECT auth\.uid\(\)\)\)/);
  const manageFunction = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION private.can_manage_athlete_identity"), migration.indexOf("REVOKE ALL ON FUNCTION private.can_view_athlete_identity"));
  assert.doesNotMatch(manageFunction, /private\.is_admin/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION private\.can_view_athlete_identity\(uuid\) TO authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION private\.can_manage_athlete_identity\(uuid\) TO authenticated/);
  assert.match(migration, /USING \(private\.can_view_athlete_identity\(id\)\)/);
  assert.match(migration, /private\.can_manage_athlete_identity\(athlete_id\)/);
});

test("rollback-only external validation covers backfill, integrity, preservation, and parent creation", () => {
  assert.match(validation, /\nBEGIN;/);
  assert.match(validation, /Backfill mismatch/);
  assert.match(validation, /Coach-only profiles were backfilled as athletes/);
  assert.match(validation, /Unaffiliated admins were backfilled as athletes/);
  assert.match(validation, /Duplicate active guardian relationship was accepted/);
  assert.match(validation, /A profile received more than one active self athlete/);
  assert.match(validation, /An athlete received more than one active self relationship/);
  assert.match(validation, /Authorization helpers still accept a caller-supplied profile ID/);
  assert.match(validation, /Active guardian manage permission did not grant management/);
  assert.match(validation, /Active self manage permission did not grant management/);
  assert.match(validation, /Platform admin lost intended athlete read visibility/);
  assert.match(validation, /Platform admin received athlete management without an active relationship/);
  assert.match(validation, /Graduation year 1999 was accepted/);
  assert.match(validation, /Graduation year 2101 was accepted/);
  assert.match(validation, /public\.create_my_athlete/);
  assert.match(validation, /Existing historical-record counts changed/);
  assert.match(validation, /ROLLBACK;\s*$/);
});
