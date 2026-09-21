import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase/migrations/20260921164820_add_structured_athlete_identity.sql", import.meta.url), "utf8");
const validator = readFileSync(new URL("database/validate_family_first_athlete_identity_foundation.sql", import.meta.url), "utf8");

test("structured identity is additive and preserves legacy athlete rows", () => {
  assert.match(sql, /ALTER TABLE public\.athletes[\s\S]*ADD COLUMN IF NOT EXISTS first_name text,[\s\S]*ADD COLUMN IF NOT EXISTS last_name text/);
  assert.doesNotMatch(sql, /ALTER COLUMN (?:first_name|last_name|graduation_year) SET NOT NULL/);
  assert.doesNotMatch(sql, /UPDATE public\.athletes/);
  assert.doesNotMatch(sql, /split_part|regexp_split_to|substring\(display_name/i);
  assert.doesNotMatch(sql, /ALTER COLUMN display_name DROP NOT NULL/);
});

test("canonical creator requires trimmed structured names and a bounded graduation year", () => {
  assert.match(sql, /FUNCTION public\.create_my_athlete\([\s\S]*p_first_name text,[\s\S]*p_last_name text,[\s\S]*p_graduation_year integer/);
  assert.doesNotMatch(sql, /p_graduation_year integer DEFAULT/i);
  assert.match(sql, /v_first_name text := nullif\(btrim\(p_first_name\), ''\)/);
  assert.match(sql, /v_last_name text := nullif\(btrim\(p_last_name\), ''\)/);
  assert.match(sql, /IF v_first_name IS NULL/);
  assert.match(sql, /IF v_last_name IS NULL/);
  assert.match(sql, /p_graduation_year IS NULL OR p_graduation_year NOT BETWEEN 2000 AND 2100/);
  assert.match(sql, /v_display_name := v_first_name \|\| ' ' \|\| v_last_name/);
  assert.match(sql, /id, first_name, last_name, display_name, graduation_year, created_by_profile_id/);
});

test("creator remains an authenticated, narrow guardian-creation boundary", () => {
  assert.match(sql, /v_profile_id uuid := \(SELECT auth\.uid\(\)\)/);
  assert.match(sql, /v_athlete_id uuid := gen_random_uuid\(\)/);
  assert.match(sql, /IF v_profile_id IS NULL[\s\S]*ERRCODE = '42501'/);
  assert.match(sql, /athlete_id, profile_id, role, training_permission, manage_permission, created_by_profile_id[\s\S]*v_athlete_id, v_profile_id, 'guardian', true, true, v_profile_id/);
  assert.doesNotMatch(sql, /INSERT INTO (?:auth\.users|public\.profiles|public\.team_athlete_memberships|public\.team_memberships)/);
  assert.match(sql, /SECURITY DEFINER[\s\S]*SET search_path TO ''/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.create_my_athlete\(text, text, integer\)[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.create_my_athlete\(text, text, integer\)[\s\S]*TO authenticated/);
});

test("legacy creator overload is explicitly revoked and dropped", () => {
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.create_my_athlete\(text, integer\)[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /DROP FUNCTION public\.create_my_athlete\(text, integer\)/);
});

test("rollback-only identity validation exercises the replacement creator contract", () => {
  assert.match(validator, /public\.create_my_athlete\([\s\S]*'Validation',[\s\S]*'Structured Child',[\s\S]*2034/);
  assert.doesNotMatch(validator, /public\.create_my_athlete\('Validation RPC child', NULL\)/);
  assert.match(validator, /first_name = 'Validation'[\s\S]*last_name = 'Structured Child'[\s\S]*display_name = 'Validation Structured Child'[\s\S]*graduation_year = 2034/);
  assert.match(validator, /Parent creation RPC did not create its guardian link/);
});

test("roster reader exposes structured fields without broadening its existing boundary", () => {
  const reader = sql.slice(sql.indexOf("CREATE FUNCTION public.list_my_team_rostered_athlete_identities"));
  assert.match(sql, /DROP FUNCTION public\.list_my_team_rostered_athlete_identities\(uuid\)/);
  assert.match(reader, /RETURNS TABLE \([\s\S]*athlete_id uuid,[\s\S]*first_name text,[\s\S]*last_name text,[\s\S]*display_name text,[\s\S]*graduation_year integer,[\s\S]*status text/);
  assert.match(reader, /private\.can_view_team_analytics\(p_team_id\)/);
  assert.doesNotMatch(reader, /can_manage_athlete|can_act_for_training|athlete_profile_relationships|profiles|team_memberships/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.list_my_team_rostered_athlete_identities\(uuid\)[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.list_my_team_rostered_athlete_identities\(uuid\)[\s\S]*TO authenticated/);
});
