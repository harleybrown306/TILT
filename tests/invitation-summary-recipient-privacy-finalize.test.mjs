import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const migration = readFileSync(root + "supabase/migrations/20261023000001_finalize_invitation_summary_recipient_privacy.sql", "utf8");

test("finalization is transactional and requires the server-only compatibility boundary", () => {
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);
  for (const signature of [
    "public.server_get_team_invitation_summary(uuid,text,text)",
    "public.server_get_family_team_invitation_summary(uuid,text,text)",
  ]) assert.match(migration, new RegExp(`to_regprocedure\\('${signature.replace(/[()]/g, "\\$&")}\\'\\) IS NULL`));
  assert.match(migration, /NOT procedure\.prosecdef[\s\S]*?search_path=""[\s\S]*?NOT has_function_privilege\('service_role', procedure\.oid, 'EXECUTE'\)/);
  assert.match(migration, /has_function_privilege\('authenticated', procedure\.oid, 'EXECUTE'\)/);
});

test("finalization only removes legacy direct-summary execution", () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.get_team_invitation_summary\(text\), public\.get_family_team_invitation_summary\(text\)\s+FROM PUBLIC, anon, authenticated, service_role/);
  assert.doesNotMatch(migration, /CREATE OR REPLACE FUNCTION|CREATE FUNCTION|ALTER FUNCTION|DROP FUNCTION/);
  assert.doesNotMatch(migration, /(?:CREATE|ALTER|DROP) TABLE|CREATE POLICY|ROW LEVEL SECURITY|accept_team_invitation\(/);
});
