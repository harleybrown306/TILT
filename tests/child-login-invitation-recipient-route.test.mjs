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
const athleteId = "11111111-1111-4111-8111-111111111111";

function load(path, mocks = {}) {
  const source = ts.transpileModule(readFileSync(root + path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  new vm.Script(`(function(require, module, exports) {${source}\n})`).runInThisContext()((name) => name in mocks ? mocks[name] : require(name), loaded, loaded.exports);
  return loaded.exports;
}

const auth = load("src/lib/auth-continuation.ts");
const invitations = load("src/lib/child-login-invitations.ts", {
  "@/lib/auth-continuation": auth,
  "@/lib/training-assignment": { isUuid: (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) },
});
const pageSource = readFileSync(root + "src/app/child-login-invite/[token]/page.tsx", "utf8");
const actionsSource = readFileSync(root + "src/app/child-login-invite/[token]/actions.ts", "utf8");

function pageFixture({ user = { id: "recipient", email_confirmed_at: "2026-01-01T00:00:00Z" }, summary = { athlete_display_name: "Avery", expires_at: "2030-01-01T00:00:00Z", invitation_status: "pending" }, rpcError = false } = {}) {
  const calls = [];
  const client = {
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    rpc: async (name, args) => {
      calls.push({ name, args });
      return rpcError ? { data: null, error: { message: "unavailable" } } : { data: summary ? [summary] : [], error: null };
    },
  };
  const page = load("src/app/child-login-invite/[token]/page.tsx", {
    "next/link": { default: (props) => React.createElement("a", props) },
    "@/components/roster-action-form": { default: ({ label }) => React.createElement("button", null, label) },
    "@/components/child-login-invitation-acceptance-form": { default: ({ label }) => React.createElement("button", null, label) },
    "@/lib/supabase/server": { createClient: async () => client },
    "@/lib/auth-continuation": auth,
    "@/lib/child-login-invitations": invitations,
    "./actions": { acceptChildLoginInvitation: async () => ({ status: "idle", message: "" }), switchChildLoginInvitationAccount: async () => ({ status: "idle", message: "" }) },
  }).default;
  return { page, calls };
}

test("child-login invitation helpers accept only the reviewed bearer-token shape", () => {
  assert.equal(invitations.isChildLoginInvitationToken(token), true);
  assert.equal(invitations.childLoginInvitationLoginPath(token), `/login?next=${encodeURIComponent(`/child-login-invite/${token}`)}`);
  for (const value of ["", "short", "a".repeat(31), "a".repeat(257), "bad/token", "has space"]) assert.equal(invitations.isChildLoginInvitationToken(value), false);
});

test("malformed child-login invitations are generic and never query summary", async () => {
  const { page, calls } = pageFixture();
  const markup = renderToStaticMarkup(await page({ params: Promise.resolve({ token: "short" }) }));
  assert.match(markup, /invitation is unavailable/i);
  assert.doesNotMatch(markup, /Avery/);
  assert.deepEqual(calls, []);
});

test("signed-out child-login route preserves only the validated same-origin continuation", async () => {
  const { page, calls } = pageFixture({ user: null });
  const markup = renderToStaticMarkup(await page({ params: Promise.resolve({ token }) }));
  assert.match(markup, /Sign in or create an account to continue/);
  assert.match(markup, new RegExp(`/login\\?next=${encodeURIComponent(`/child-login-invite/${token}`).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(markup, /\/signup\?next=/);
  assert.doesNotMatch(markup, /Avery|athlete/i);
  assert.deepEqual(calls, []);
});

test("unconfirmed and wrong-account paths disclose no athlete identity", async () => {
  const unconfirmed = pageFixture({ user: { id: "recipient", email_confirmed_at: null } });
  const unconfirmedMarkup = renderToStaticMarkup(await unconfirmed.page({ params: Promise.resolve({ token }) }));
  assert.match(unconfirmedMarkup, /Confirm your email address/);
  assert.doesNotMatch(unconfirmedMarkup, /Avery/);
  assert.deepEqual(unconfirmed.calls, []);

  const wrong = pageFixture({ summary: null });
  const wrongMarkup = renderToStaticMarkup(await wrong.page({ params: Promise.resolve({ token }) }));
  assert.match(wrongMarkup, /invitation is unavailable/i);
  assert.doesNotMatch(wrongMarkup, /Avery/);
  assert.deepEqual(wrong.calls, [{ name: "get_child_login_invitation_summary", args: { p_invitation_token: token } }]);
});

test("confirmed recipient renders only summary fields and supports safe accepted retry", async () => {
  for (const status of ["pending", "accepted"]) {
    const { page, calls } = pageFixture({ summary: { athlete_display_name: "Avery", expires_at: "2030-01-01T00:00:00Z", invitation_status: status } });
    const markup = renderToStaticMarkup(await page({ params: Promise.resolve({ token }) }));
    assert.match(markup, /Avery/);
    assert.match(markup, status === "accepted" ? /Continue/ : /Claim child login/);
    assert.deepEqual(calls, [{ name: "get_child_login_invitation_summary", args: { p_invitation_token: token } }]);
  }
});

test("acceptance action gives the browser no identity authority and redirects only from the canonical RPC result", async () => {
  const calls = [];
  const actions = load("src/app/child-login-invite/[token]/actions.ts", {
    "next/navigation": { redirect: (destination) => { throw Error(`REDIRECT:${destination}`); } },
    "@/lib/child-login-invitations": invitations,
    "@/lib/supabase/server": { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "recipient" } }, error: null }) }, rpc: async (name, args) => { calls.push({ name, args }); return { data: [{ athlete_id: athleteId }], error: null }; } }) },
  });
  await assert.rejects(actions.acceptChildLoginInvitation(token, { status: "idle", message: "" }, new FormData()), new RegExp(`REDIRECT:\\/\\?athlete=${athleteId}`));
  assert.deepEqual(calls, [{ name: "accept_child_login_invitation", args: { p_invitation_token: token } }]);
});

test("acceptance maps rejected, transport, and malformed outcomes without inventing an athlete", async () => {
  for (const response of [
    { data: null, error: { message: "sensitive database detail" } },
    { data: [{ athlete_id: "not-a-uuid" }], error: null },
  ]) {
    const actions = load("src/app/child-login-invite/[token]/actions.ts", {
      "next/navigation": { redirect: () => { throw Error("unexpected redirect"); } },
      "@/lib/child-login-invitations": invitations,
      "@/lib/supabase/server": { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "recipient" } }, error: null }) }, rpc: async () => response }) },
    });
    const result = await actions.acceptChildLoginInvitation(token, { status: "idle", message: "" }, new FormData());
    assert.equal(result.status, response.error ? "error" : "review_required");
    assert.doesNotMatch(result.message, /sensitive|athlete_id|uuid/i);
  }
});

test("acceptance fails generically when the action-time session is absent or invalid", async () => {
  for (const authResult of [
    { data: { user: null }, error: null },
    { data: { user: null }, error: { message: "sensitive auth detail" } },
  ]) {
    const calls = [];
    const actions = load("src/app/child-login-invite/[token]/actions.ts", {
      "next/navigation": { redirect: (destination) => { throw Error(`UNEXPECTED_REDIRECT:${destination}`); } },
      "@/lib/child-login-invitations": invitations,
      "@/lib/supabase/server": { createClient: async () => ({
        auth: { getUser: async () => authResult },
        rpc: async (...args) => { calls.push(args); return { data: [{ athlete_id: athleteId }], error: null }; },
      }) },
    });
    const result = await actions.acceptChildLoginInvitation(token, { status: "idle", message: "" }, new FormData());
    assert.deepEqual(calls, []);
    assert.deepEqual(result, { status: "error", message: "Sign in with the invited account." });
    assert.doesNotMatch(result.message, /sensitive|token|athlete|profile|email/i);
  }
});

test("recipient implementation remains RPC-only, token-private, and dynamically rendered", () => {
  assert.match(pageSource, /export const dynamic = "force-dynamic"/);
  assert.match(pageSource, /export const revalidate = 0/);
  assert.match(pageSource, /get_child_login_invitation_summary/);
  assert.match(actionsSource, /accept_child_login_invitation", \{ p_invitation_token: token \}/);
  assert.match(actionsSource, /parseChildLoginInvitationAcceptance/);
  assert.match(actionsSource, /redirect\(`\/\?athlete=\$\{encodeURIComponent\(acceptedAthleteId\)\}`\)/);
  for (const source of [pageSource, actionsSource]) {
    assert.doesNotMatch(source, /\.from\(|\.insert\(|child_login_invitations|athlete_profile_relationships|localStorage|sessionStorage|indexedDB|telemetry/i);
    assert.doesNotMatch(source, /p_athlete_id|p_profile_id|p_email|profileId|athleteId/);
  }
  const config = readFileSync(root + "next.config.ts", "utf8");
  assert.match(config, /source: "\/child-login-invite\/:path\*"/);
  assert.match(config, /key: "Referrer-Policy", value: "no-referrer"/);
  assert.doesNotMatch(pageSource, /token_hash|<[^>]*>\{token\}/);
});

test("summary and acceptance parsers fail closed on malformed RPC results", () => {
  assert.equal(invitations.parseChildLoginInvitationSummary([{ athlete_display_name: "Avery", expires_at: "2030-01-01T00:00:00Z", invitation_status: "pending" }]).kind, "summary");
  assert.equal(invitations.parseChildLoginInvitationSummary([{ athlete_display_name: "Avery", expires_at: "bad", invitation_status: "pending" }]).kind, "malformed");
  assert.equal(invitations.parseChildLoginInvitationAcceptance([{ athlete_id: athleteId }])?.athlete_id, athleteId);
  assert.equal(invitations.parseChildLoginInvitationAcceptance([{ athlete_id: "not-a-uuid" }]), null);
});
