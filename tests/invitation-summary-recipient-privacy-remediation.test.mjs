import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const migration = readFileSync(root + "supabase/migrations/20261023000000_harden_invitation_summary_recipient_privacy.sql", "utf8");
const teamPage = readFileSync(root + "src/app/invite/[token]/page.tsx", "utf8");
const familyPage = readFileSync(root + "src/app/family-invite/[token]/page.tsx", "utf8");
const teamActions = readFileSync(root + "src/app/invite/[token]/actions.ts", "utf8");
const familyActions = readFileSync(root + "src/app/family-invite/[token]/actions.ts", "utf8");

function definition(name, nextName) {
  const start = migration.indexOf(name);
  const end = nextName ? migration.indexOf(nextName, start + 1) : migration.length;
  assert.ok(start >= 0, `missing ${name}`);
  assert.ok(end > start, `missing end after ${name}`);
  return migration.slice(start, end);
}

test("compatibility migration is transactional and leaves legacy summary definitions and grants untouched", () => {
  const preflight = definition("DO $preflight$", "-- These wrappers");
  for (const signature of [
    "public.get_team_invitation_summary(text)",
    "public.get_family_team_invitation_summary(text)",
  ]) assert.match(preflight, new RegExp(`to_regprocedure\\('${signature.replace(/[()]/g, "\\$&")}\\'\\) IS NULL`));
  assert.match(preflight, /Expected predecessor authenticated summary grants are missing/);
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);
  assert.doesNotMatch(migration, /CREATE OR REPLACE FUNCTION public\.(?:get_team_invitation_summary|get_family_team_invitation_summary)/);
  assert.doesNotMatch(migration, /REVOKE ALL ON FUNCTION public\.get_team_invitation_summary/);
  assert.doesNotMatch(migration, /(?:CREATE|ALTER|DROP) TABLE|CREATE POLICY|ROW LEVEL SECURITY|accept_team_invitation\(/);
});

test("service-only wrappers independently bind every summary to a confirmed auth-user email", () => {
  for (const [name, table, columns] of [
    ["server_get_team_invitation_summary", "public.team_invitations", "team_name text, invitation_role public.team_member_role, expires_at timestamptz, invitation_status public.team_invitation_status"],
    ["server_get_family_team_invitation_summary", "public.family_team_invitations", "team_name text, expires_at timestamptz, invitation_status public.team_invitation_status"],
  ]) {
    const wrapper = definition(`CREATE FUNCTION public.${name}`, name === "server_get_team_invitation_summary" ? "CREATE FUNCTION public.server_get_family_team_invitation_summary" : "ALTER FUNCTION public.server_get_team_invitation_summary");
    assert.match(wrapper, new RegExp(`RETURNS TABLE\\(${columns.replace(/[().]/g, "\\$&").replace(/ /g, "\\s+")}\\)\\s+LANGUAGE plpgsql\\s+STABLE\\s+SECURITY DEFINER\\s+SET search_path TO ''`));
    assert.match(wrapper, /FROM auth\.users AS user_record[\s\S]*?user_record\.id = p_auth_user_id[\s\S]*?user_record\.email_confirmed_at IS NOT NULL/);
    assert.match(wrapper, /v_verified_email IS NULL OR v_verified_email <> lower\(btrim\(p_verified_email\)\)/);
    assert.match(wrapper, new RegExp(`FROM ${table.replace(".", "\\.")}`));
    assert.match(wrapper, /lower\(btrim\(invitation\.invited_email\)\) = v_verified_email/);
    assert.doesNotMatch(wrapper, /public\.(?:get_team_invitation_summary|get_family_team_invitation_summary)\(/);
  }
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.server_get_team_invitation_summary\(uuid, text, text\), public\.server_get_family_team_invitation_summary\(uuid, text, text\)\s+FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.server_get_team_invitation_summary\(uuid, text, text\), public\.server_get_family_team_invitation_summary\(uuid, text, text\)\s+TO service_role/);
});

test("recipient pages use a fresh verified identity and one generic unavailable view before summary disclosure", () => {
  for (const [page, wrapper, direct] of [
    [teamPage, "server_get_team_invitation_summary", "get_team_invitation_summary"],
    [familyPage, "server_get_family_team_invitation_summary", "get_family_team_invitation_summary"],
  ]) {
    assert.match(page, /getCurrentVerifiedAuthIdentity\(\)/);
    assert.match(page, new RegExp(`createServiceClient\\(\\)\\.rpc\\("${wrapper}"`));
    assert.doesNotMatch(page, new RegExp(`\\.rpc\\("${direct}"`));
    assert.match(page, /p_auth_user_id: identity\.authUserId/);
    assert.match(page, /p_verified_email: identity\.verifiedEmail/);
    assert.match(page, /This invitation is unavailable\./);
    assert.doesNotMatch(page, /token_hash|localStorage|sessionStorage|indexedDB|telemetry/i);
  }
});

test("acceptance contracts remain separate from summary display for legacy and family onboarding", () => {
  assert.match(teamActions, /rpc\("accept_team_invitation", \{ invitation_token: token \}\)/);
  assert.match(familyActions, /rpc\("server_accept_family_team_invitation"/);
  assert.doesNotMatch(teamActions, /server_get_team_invitation_summary/);
  assert.doesNotMatch(familyActions, /server_get_family_team_invitation_summary/);
});
