import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const sql = readFileSync(root + "supabase/migrations/20260929093000_server_mediated_verified_invitation_auth.sql", "utf8");
const signatures = [
  "public.accept_family_team_invitation(text,uuid,text,text,integer)",
  "public.create_guardian_invitation(uuid,text,text,timestamp with time zone)",
  "public.get_guardian_invitation_summary(text)",
  "public.accept_guardian_invitation(text)",
  "public.get_child_login_invitation_summary(text)",
  "public.accept_child_login_invitation(text)",
];
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("server-mediated Auth remediation has an atomic, exact-signature preflight", () => {
  const firstReplacement = sql.indexOf("CREATE OR REPLACE FUNCTION public.accept_family_team_invitation");
  const preflight = sql.indexOf("DO $$");
  assert.ok(preflight >= 0);
  assert.ok(preflight < firstReplacement);
  const preflightBlock = sql.slice(preflight, firstReplacement);
  for (const signature of signatures) {
    const exactSignature = escapeRegExp(signature);
    assert.match(preflightBlock, new RegExp(`to_regprocedure\\('${exactSignature}'\\) IS NULL`));
    assert.match(preflightBlock, new RegExp(`RAISE EXCEPTION 'Expected predecessor function is missing: ${exactSignature}';`));
  }
  assert.equal((preflightBlock.match(/to_regprocedure\(/g) ?? []).length, 6);
  assert.equal((preflightBlock.match(/RAISE EXCEPTION 'Expected predecessor function is missing:/g) ?? []).length, 6);
});

test("server-mediated Auth remediation remains explicit and server-bound", () => {
  assert.equal((sql.match(/CREATE OR REPLACE FUNCTION public\.(?:accept_family_team_invitation|create_guardian_invitation|get_guardian_invitation_summary|accept_guardian_invitation|get_child_login_invitation_summary|accept_child_login_invitation)\(/g) ?? []).length, 6);
  assert.doesNotMatch(sql, /pg_get_functiondef|regexp_replace|EXECUTE f|auth\.users/);
  assert.match(sql, /private\.server_verified_email\(\)/);
  assert.match(sql, /private\.can_manage_guardian_invitation\(p_athlete_id\)/);
  assert.match(sql, /private\.can_manage_athlete_identity_for_profile\(v_i\.athlete_id,v_i\.inviter_profile_id\)/);
  assert.match(sql, /r\.role IN \('self','guardian'\)[\s\S]*?FOR UPDATE/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.accept_family_team_invitation/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.server_accept_family_team_invitation[\s\S]*?TO service_role/);
});
