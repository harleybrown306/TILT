import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../supabase/migrations/20261016090000_create_account_mode_foundation.sql", import.meta.url),
  "utf8",
);
const validator = readFileSync(new URL("database/validate_account_mode_foundation.sql", import.meta.url), "utf8");
const audit = readFileSync(new URL("database/account_mode_preflight_audit.sql", import.meta.url), "utf8");

test("account-mode foundation is additive, nullable during transition, and has no automatic backfill", () => {
  assert.match(migration, /CREATE TYPE public\.account_mode AS ENUM \('family', 'coaching'\)/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS account_mode public\.account_mode/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS account_mode_assigned_at timestamptz/);
  assert.match(migration, /profiles_account_mode_assignment_consistent/);
  assert.match(
    migration,
    /\(account_mode IS NULL AND account_mode_assigned_at IS NULL\)[\s\S]*\(account_mode IS NOT NULL AND account_mode_assigned_at IS NOT NULL\)/,
  );
  assert.doesNotMatch(migration, /INSERT INTO public\.profiles/i);
  assert.doesNotMatch(migration, /FROM public\.(?:team_memberships|team_staff_memberships|athlete_profile_relationships|team_invitations)/i);
  assert.doesNotMatch(migration, /CREATE(?: OR REPLACE)? FUNCTION public\./i);
});

test("only a fixed-search-path private helper can make the one-time assignment", () => {
  assert.match(migration, /FUNCTION private\.protect_profile_account_mode\(\)[\s\S]*SET search_path TO ''/);
  assert.match(migration, /CREATE TRIGGER profiles_protect_account_mode[\s\S]*BEFORE UPDATE ON public\.profiles/);
  assert.match(
    migration,
    /FUNCTION private\.assign_profile_account_mode\([\s\S]*SECURITY DEFINER[\s\S]*SET search_path TO ''/,
  );
  assert.match(migration, /FOR UPDATE;/);
  assert.match(migration, /Profile account mode is already assigned/);
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION private\.assign_profile_account_mode\(uuid, public\.account_mode\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/,
  );
  assert.doesNotMatch(migration, /GRANT EXECUTE ON FUNCTION private\.assign_profile_account_mode/i);
});

test("rollback-only validator covers catalog protections, Supabase role simulation, and retry safety", () => {
  assert.match(validator, /^BEGIN;/m);
  assert.match(validator, /Account-mode helper owner % is not an approved migration role/);
  assert.match(validator, /Account-mode helper is not SECURITY DEFINER/);
  assert.match(validator, /fixed empty search_path/);
  assert.match(validator, /Private schema usage or create privileges are incorrect/);
  assert.match(validator, /PUBLIC or application-role execute grant/);
  assert.match(validator, /Profile table or account-mode column ACL prerequisites are incorrect/);
  assert.match(validator, /SET LOCAL ROLE authenticated/);
  assert.match(validator, /SET LOCAL ROLE service_role/);
  assert.match(validator, /Authenticated profile owner could write account_mode directly/);
  assert.match(validator, /Authenticated profile owner could write assignment metadata directly/);
  assert.match(validator, /Authenticated profile owner could write the account-mode pair directly/);
  assert.match(validator, /Authenticated profile owner could not perform an ordinary profile update/);
  assert.match(validator, /Authenticated role could execute private account-mode helper/);
  assert.match(validator, /service_role could write account_mode directly/);
  assert.match(validator, /service_role could write assignment metadata directly/);
  assert.match(validator, /service_role could write the account-mode pair directly/);
  assert.match(validator, /service_role could execute private account-mode helper/);
  assert.match(validator, /Private helper did not atomically assign Family mode/);
  assert.match(validator, /Direct privileged profile mode transition was accepted/);
  assert.match(validator, /Same-mode retry changed the original assignment timestamp/);
  assert.match(validator, /Private helper allowed a Family-to-Coaching transition/);
  assert.match(validator, /Account-mode paired-assignment constraint accepted partial state/);
  assert.doesNotMatch(validator, /\bCOMMIT\b/i);
  assert.match(validator, /ROLLBACK;\s*$/);
});

test("preflight audit is read-only and reports both profile and invitation conflicts", () => {
  assert.match(audit, /^BEGIN TRANSACTION READ ONLY;/m);
  assert.match(audit, /mixed_manual_review/);
  assert.match(audit, /platform_admin_evidence/);
  assert.match(audit, /public\.team_staff_memberships/);
  assert.match(audit, /public\.team_memberships/);
  assert.match(audit, /public\.athlete_profile_relationships/);
  assert.match(audit, /public\.(?:team_invitations|family_team_invitations|guardian_invitations|child_login_invitations)/);
  assert.match(audit, /WHERE cardinality\(proposed_modes\) > 1/);
  assert.match(audit, /profile_invitation_conflicts/);
  assert.doesNotMatch(audit, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i);
  assert.match(audit, /ROLLBACK;\s*$/);
});
