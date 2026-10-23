import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const token = "a".repeat(64);
function load(path, mocks = {}) {
  const source = ts.transpileModule(readFileSync(root + path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  new vm.Script(`(function(require, module, exports) {${source}\n})`).runInThisContext()((name) => name in mocks ? mocks[name] : require(name), loaded, loaded.exports);
  return loaded.exports;
}
const auth = load("src/lib/auth-continuation.ts");
const family = load("src/lib/family-team-invitations.ts", { "@/lib/auth-continuation": auth });
const pageSource = readFileSync(root + "src/app/family-invite/[token]/page.tsx", "utf8");
const actionsSource = readFileSync(root + "src/app/family-invite/[token]/actions.ts", "utf8");

function fixture({ signedOut = false, unverified = false, summary = { team_name: "Thunder", expires_at: "2030-01-01T00:00:00Z", invitation_status: "pending" }, rpcError = false } = {}) {
  const calls = [];
  const authClient = {
    auth: { getUser: async () => ({ data: { user: signedOut ? null : { id: "recipient", email: "recipient@example.test", email_confirmed_at: unverified ? null : "2026-10-01T00:00:00Z" } }, error: null }) },
  };
  const serviceClient = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      return rpcError ? { data: null, error: { message: "unavailable" } } : { data: summary ? [summary] : [], error: null };
    },
  };
  const verifiedAuthIdentity = load("src/lib/verified-auth-identity.ts", {
    "server-only": {}, "@/lib/supabase/server": { createClient: async () => authClient },
  });
  const page = load("src/app/family-invite/[token]/page.tsx", {
    "next/navigation": { redirect: (destination) => { throw Error(`REDIRECT:${destination}`); } },
    "next/link": { default: (props) => React.createElement("a", props) },
    "@/components/roster-action-form": { default: ({ label }) => React.createElement("button", null, label) },
    "@/components/family-invitation-acceptance-form": { default: () => React.createElement("div", null, "Family athlete choices") },
    "@/lib/my-athlete-contexts-server": { loadMyFamilyAthleteContexts: async () => [] },
    "@/lib/supabase/server": { createClient: async () => authClient },
    "@/lib/supabase/service": { createServiceClient: () => serviceClient },
    "@/lib/verified-auth-identity": verifiedAuthIdentity,
    "@/lib/family-team-invitations": family,
    "./actions": { acceptFamilyTeamInvitation: async () => ({ status: "idle", message: "" }), switchFamilyInvitationAccount: async () => ({ status: "idle", message: "" }) },
  }).default;
  return { page, calls };
}

test("family invitation helper accepts only the reviewed token and continuation path", () => {
  assert.equal(family.isFamilyInvitationToken(token), true);
  assert.equal(family.familyInvitationLoginPath(token), `/login?next=${encodeURIComponent(`/family-invite/${token}`)}`);
  for (const value of ["", "short", "a".repeat(257), "bad/token", "a".repeat(31)]) assert.equal(family.isFamilyInvitationToken(value), false);
});

test("unauthenticated family invitation preserves the exact safe continuation", async () => {
  const { page, calls } = fixture({ signedOut: true });
  await assert.rejects(page({ params: Promise.resolve({ token }) }), (error) => error.message === `REDIRECT:${family.familyInvitationLoginPath(token)}`);
  assert.deepEqual(calls, []);
});

for (const [status, expected] of [["pending", "Family athlete choices"], ["expired", "has expired"], ["revoked", "no longer available"], ["accepted", "already been used"]]) {
  test(`family invitation renders ${status} using only the summary contract`, async () => {
    const { page, calls } = fixture({ summary: { team_name: "Thunder", expires_at: "2030-01-01T00:00:00Z", invitation_status: status } });
    const markup = renderToStaticMarkup(await page({ params: Promise.resolve({ token }) }));
    assert.ok(markup.includes(expected));
    assert.deepEqual(calls, [{ name: "server_get_family_team_invitation_summary", args: { p_auth_user_id: "recipient", p_verified_email: "recipient@example.test", p_invitation_token: token } }]);
  });
}

test("invalid or uncertain family summaries fail closed without acceptance", async () => {
  for (const options of [{ summary: null }, { rpcError: true }]) {
    const { page, calls } = fixture(options);
    const markup = renderToStaticMarkup(await page({ params: Promise.resolve({ token }) }));
    assert.match(markup, /invitation is unavailable/i);
    assert.equal(calls.length, 1);
  }
  const { page, calls } = fixture();
  const markup = renderToStaticMarkup(await page({ params: Promise.resolve({ token: "short" }) }));
  assert.match(markup, /invitation is unavailable/i);
  assert.deepEqual(calls, []);
});

test("wrong, unverified, and invalid recipients use one generic unavailable view without metadata", async () => {
  const wrong = fixture({ summary: null });
  const unverified = fixture({ unverified: true });
  const invalid = fixture();
  const wrongMarkup = renderToStaticMarkup(await wrong.page({ params: Promise.resolve({ token }) }));
  const unverifiedMarkup = renderToStaticMarkup(await unverified.page({ params: Promise.resolve({ token }) }));
  const invalidMarkup = renderToStaticMarkup(await invalid.page({ params: Promise.resolve({ token: "short" }) }));
  for (const markup of [wrongMarkup, unverifiedMarkup, invalidMarkup]) {
    assert.match(markup, /This invitation is unavailable/);
    assert.doesNotMatch(markup, /Thunder|Expires|pending|accepted|revoked|expired/i);
  }
  assert.deepEqual(wrong.calls, [{ name: "server_get_family_team_invitation_summary", args: { p_auth_user_id: "recipient", p_verified_email: "recipient@example.test", p_invitation_token: token } }]);
  assert.deepEqual(unverified.calls, []);
  assert.deepEqual(invalid.calls, []);
});

test("recipient route keeps summary and manageable-family-context loading server-side", () => {
  assert.match(pageSource, /server_get_family_team_invitation_summary/);
  assert.match(pageSource, /getCurrentVerifiedAuthIdentity\(\)/);
  assert.doesNotMatch(pageSource, /\.rpc\("get_family_team_invitation_summary"/);
  assert.doesNotMatch(pageSource, /\.from\(/);
  assert.match(pageSource, /loadMyFamilyAthleteContexts\(\)[\s\S]*filter\(\(context\) => context\.canManage\)/);
  assert.doesNotMatch(pageSource, /token_hash|localStorage|sessionStorage|indexedDB|telemetry/i);
  assert.doesNotMatch(actionsSource, /\.from\(|token_hash|localStorage|sessionStorage|indexedDB|telemetry/i);
  assert.match(actionsSource, /auth\.signOut/);
  assert.match(actionsSource, /familyInvitationLoginPath/);
});

test("legacy invitation route remains independent", () => {
  const legacy = readFileSync(root + "src/app/invite/[token]/page.tsx", "utf8");
  assert.match(legacy, /server_get_team_invitation_summary/);
  assert.match(legacy, /getCurrentVerifiedAuthIdentity\(\)/);
  assert.doesNotMatch(legacy, /\.rpc\("get_team_invitation_summary"/);
  assert.doesNotMatch(legacy, /get_family_team_invitation_summary|family-invite/);
});
