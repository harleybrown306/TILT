import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { localUrl } from "./database/run_team_staff_membership_mirror_concurrency.mjs";

const migration = readFileSync(new URL("../supabase/migrations/20261009000000_sync_team_staff_membership_mirror.sql", import.meta.url), "utf8");
const validation = readFileSync(new URL("database/validate_team_staff_membership_mirror.sql", import.meta.url), "utf8");
const harness = readFileSync(new URL("database/run_team_staff_membership_mirror_concurrency.mjs", import.meta.url), "utf8");

test("the staff mirror has one authoritative legacy-to-canonical database boundary", () => {
  assert.match(migration, /LOCK TABLE public\.teams,[\s\S]*public\.team_memberships,[\s\S]*public\.team_staff_memberships[\s\S]*SHARE ROW EXCLUSIVE MODE/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION private\.sync_team_staff_membership_mirror\(\)/);
  assert.match(migration, /AFTER INSERT OR UPDATE OR DELETE ON public\.team_memberships/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION private\.cleanup_team_staff_memberships_before_team_delete\(\)/);
  const parentCleanup = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION private.cleanup_team_staff_memberships_before_team_delete"));
  assert.match(parentCleanup, /LOCK TABLE public\.team_memberships,\s*public\.team_staff_memberships\s*IN SHARE ROW EXCLUSIVE MODE[\s\S]*DELETE FROM public\.team_staff_memberships/);
  assert.match(migration, /BEFORE DELETE ON public\.teams/);
  assert.match(migration, /CREATE POLICY team_staff_memberships_select[\s\S]*private\.can_manage_roster\(team_id\)/);
  assert.match(migration, /CREATE POLICY team_athlete_memberships_select[\s\S]*private\.can_manage_roster\(team_id\)/);
  assert.doesNotMatch(migration, /private\.can_manage_roster\(team_id,\s*\(SELECT auth\.uid\(\)\)\)/);
  assert.match(migration, /NEW\.id,[\s\S]*NEW\.team_id,[\s\S]*NEW\.user_id/);
  assert.match(migration, /staff\.id = OLD\.id[\s\S]*staff\.team_id = OLD\.team_id[\s\S]*staff\.profile_id = OLD\.user_id/);
  assert.doesNotMatch(migration, /ALTER TABLE public\.team_staff_memberships DISABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(migration, /GRANT (?:ALL|INSERT|UPDATE|DELETE) ON public\.team_staff_memberships TO authenticated/);
  assert.doesNotMatch(migration, /ON CONFLICT\s*(?:\([^)]*\))?\s*DO NOTHING/i);
});

test("reconciliation is exact, fail-closed, and safe to rerun", () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION private\.reconcile_team_staff_memberships\(\)/);
  const reconciliation = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION private.reconcile_team_staff_memberships"));
  assert.match(reconciliation, /LOCK TABLE public\.teams,\s*public\.team_memberships,\s*public\.team_staff_memberships\s*IN SHARE ROW EXCLUSIVE MODE/);
  assert.match(migration, /Canonical staff membership mapping is inconsistent/);
  assert.match(migration, /UUID does not match authoritative legacy membership/);
  assert.match(migration, /DELETE FROM public\.team_staff_memberships AS staff[\s\S]*NOT EXISTS/);
  assert.match(migration, /Canonical staff membership mirror parity validation failed/);
  assert.match(migration, /SELECT private\.reconcile_team_staff_memberships\(\);/);
  assert.equal((validation.match(/PERFORM private\.reconcile_team_staff_memberships\(\);/g) ?? []).length, 3);
  assert.match(validation, /Staff mirror reconciliation accepted an inconsistent UUID mapping/);
  assert.match(validation, /ROLLBACK;\s*$/);
});

test("rollback-only validation covers creation, invitation acceptance, role changes, removal, and revocation", () => {
  for (const marker of [
    "Team creation did not create an exact canonical coach mirror",
    "Team creation did not preserve canonical staff authorization",
    "Assistant invitation acceptance did not create an exact canonical mirror",
    "Assistant invitation acceptance did not preserve canonical authorization",
    "Staff role update did not update the canonical mirror",
    "Staff role update did not update canonical authorization",
    "Staff removal did not remove the canonical mirror",
    "Staff removal retained canonical authorization",
    "Assistant invitation revocation changed staff mirror state",
    "Staff mirror reconciliation is not rerun-safe",
    "Team deletion did not remove mirrored staff memberships",
    "Unrelated team did not create an exact canonical staff mirror",
  ]) assert.match(validation, new RegExp(marker));
  assert.match(validation, /public\.accept_team_invitation\(v_token\)/);
  assert.match(validation, /UPDATE public\.team_memberships[\s\S]*SET role = 'coach'/);
  assert.match(validation, /DELETE FROM public\.team_memberships WHERE id = v_membership_id/);
});

test("concurrency harness only accepts an explicit disposable local database", () => {
  const disposable = "postgresql://postgres:local@127.0.0.1:55552/postgres";
  assert.equal(localUrl(disposable), disposable);
  assert.throws(() => localUrl(), /HARNESS_MISSING_DISPOSABLE_DATABASE_URL/);
  assert.throws(() => localUrl("postgresql://postgres:local@127.0.0.1:54322/postgres"), /HARNESS_PROTECTED_TARGET_REFUSED/);
  assert.match(harness, /process\.env\[MODE_ENV\] !== "LOCAL_DISPOSABLE"/);
  assert.match(harness, /pg_blocking_pids/);
  assert.match(harness, /role_update_vs_removal: PASS/);
  assert.match(harness, /async function parentDeleteVsReconciliation/);
  assert.match(harness, /SELECT private\.reconcile_team_staff_memberships\(\)/);
  assert.match(harness, /DELETE FROM public\.teams WHERE id = \$1/);
  assert.match(harness, /parent_delete_vs_reconciliation: PASS/);
  assert.match(harness, /await parentDeleteVsReconciliation\(a, b, observer, control\)/);
  assert.match(harness, /"parent_delete_vs_legacy_role_update"/);
  assert.match(harness, /"parent_delete_vs_legacy_removal"/);
  assert.match(harness, /waitForParentCleanupPause/);
  assert.match(harness, /MIRROR_PARITY_FAILURE/);
  assert.doesNotMatch(harness, /DISABLE TRIGGER|DROP INDEX|session_replication_role/);
});
