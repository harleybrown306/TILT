import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const athleteId = "00000000-0000-4000-8000-000000000001";
const invitationId = "00000000-0000-4000-8000-000000000002";
const returnedAthleteId = "00000000-0000-4000-8000-000000000003";
const token = "a".repeat(64);
const idle = { status: "idle", message: "" };

function load(path, mocks = {}) {
  const source = ts.transpileModule(readFileSync(root + path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  new vm.Script(`(function(require, module, exports) {${source}\n})`).runInThisContext()((name) => name in mocks ? mocks[name] : require(name), loaded, loaded.exports);
  return loaded.exports;
}

const auth = load("src/lib/auth-continuation.ts");
const guardian = load("src/lib/guardian-invitations.ts", { "@/lib/auth-continuation": auth, "@/lib/training-assignment": { isUuid: (value) => /^[0-9a-f-]{36}$/i.test(value) } });
const managerSource = readFileSync(root + "src/app/athletes/[athleteId]/guardians/actions.ts", "utf8");
const managerPageSource = readFileSync(root + "src/app/athletes/[athleteId]/guardians/page.tsx", "utf8");
const recipientPageSource = readFileSync(root + "src/app/guardian-invite/[token]/page.tsx", "utf8");
const recipientActionsSource = readFileSync(root + "src/app/guardian-invite/[token]/actions.ts", "utf8");

function form(email = " Adult@Example.com ") { const data = new FormData(); data.set("email", email); return data; }

function managerFixture({ result = [{ invitation_id: invitationId, expires_at: "2030-01-01T00:00:00Z" }], error = null, status = 201, signedOut = false } = {}) {
  const calls = [], invalidated = [];
  const actions = load("src/app/athletes/[athleteId]/guardians/actions.ts", {
    "node:crypto": awaitableCrypto,
    "next/cache": { revalidatePath: (path) => invalidated.push(path) },
    "@/lib/guardian-invitations": guardian,
    "@/lib/supabase/server": { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: signedOut ? null : { id: "manager" } }, error: null }) }, rpc: async (name, args) => { calls.push({ name, args }); return name === "revoke_guardian_invitation" ? { data: null, error, status } : { data: result, error, status }; } }) },
    "@/lib/training-assignment": { isUuid: (value) => /^[0-9a-f-]{36}$/i.test(value) },
  });
  return { actions, calls, invalidated };
}
const awaitableCrypto = { randomBytes: (size) => ({ toString: (encoding) => { assert.equal(size, 48); assert.equal(encoding, "base64url"); return "z".repeat(64); } }), createHash };

test("guardian continuation accepts only the exact canonical bearer route", () => {
  assert.equal(auth.safeAuthContinuation(`/guardian-invite/${token}`), `/guardian-invite/${token}`);
  assert.equal(guardian.guardianInvitationLoginPath(token), `/login?next=${encodeURIComponent(`/guardian-invite/${token}`)}`);
  for (const value of ["/guardian-invite/short", `/guardian-invite/${token}/extra`, "/guardian-invite/%2f%2fevil.test", `/guardian-invite/${token}?next=https://evil.test`, `/guardian-invite/${token}#fragment`, `/guardian-invite/${token}\\evil`, `/guardian-invite/../${token}`, `/guardian-invite/%252f%252fevil.test`]) assert.equal(auth.safeAuthContinuation(value), "/");
});

test("strict guardian RPC parsers require actual arrays and fully valid trusted fields", () => {
  const create = { invitation_id: invitationId, expires_at: "2030-01-01T00:00:00Z" };
  assert.deepEqual(guardian.parseGuardianInvitationCreate([create]), create);
  for (const value of [{ 0: create, length: 1 }, [], [create, create], null, [{ expires_at: create.expires_at }], [{ invitation_id: "not-a-uuid", expires_at: create.expires_at }], [{ invitation_id: null, expires_at: create.expires_at }], [{ invitation_id: invitationId, expires_at: undefined }], [{ invitation_id: invitationId, expires_at: "not-a-date" }], [{ invitation_id: invitationId, expires_at: null }]]) assert.equal(guardian.parseGuardianInvitationCreate(value), null);

  assert.deepEqual(guardian.parseGuardianInvitationAcceptance([{ athlete_id: returnedAthleteId }]), { athlete_id: returnedAthleteId });
  for (const value of [{ 0: { athlete_id: returnedAthleteId }, length: 1 }, [], [{ athlete_id: returnedAthleteId }, { athlete_id: returnedAthleteId }], null, [{}], [{ athlete_id: "not-a-uuid" }], [{ athlete_id: null }]]) assert.equal(guardian.parseGuardianInvitationAcceptance(value), null);

  const summary = { athlete_display_name: "Private Athlete", expires_at: "2030-01-01T00:00:00Z", invitation_status: "pending" };
  assert.deepEqual(guardian.parseGuardianInvitationSummary([]), { kind: "none" });
  assert.deepEqual(guardian.parseGuardianInvitationSummary([summary]), { kind: "summary", value: summary });
  for (const value of [{ 0: summary, length: 1 }, [summary, summary], [{ ...summary, athlete_display_name: null }], [{ ...summary, expires_at: "bad" }], [{ ...summary, invitation_status: "other" }]]) assert.deepEqual(guardian.parseGuardianInvitationSummary(value), { kind: "malformed" });

  const list = { invitation_id: invitationId, invited_email: "adult@example.com", invitation_status: "pending", expires_at: "2030-01-01T00:00:00Z", created_at: "2029-12-01T00:00:00Z" };
  assert.deepEqual(guardian.parseGuardianInvitationList([list]), [list]);
  for (const value of [{ 0: list, length: 1 }, [{ ...list, invitation_id: "bad" }], [{ ...list, invited_email: " " }], [{ ...list, invitation_status: "other" }], [{ ...list, expires_at: "bad" }], [{ ...list, created_at: "bad" }], [list, { ...list, created_at: null }]]) assert.equal(guardian.parseGuardianInvitationList(value), null);
});

test("guardian timestamptz validation accepts only canonical timezone-bearing calendar-valid values", () => {
  for (const value of ["2026-09-23T10:30:00Z", "2026-09-23T10:30:00+00:00", "2026-09-23T10:30:00+05:30", "2026-09-23T10:30:00-05:00", "2024-02-29T10:30:00.123456Z"]) assert.equal(guardian.isGuardianInvitationTimestamp(value), true);
  for (const value of [
    "2026-09-23", "2026-09-23T10:30:00", "Tue, 23 Sep 2026 10:30:00 GMT", "2026/09/23T10:30:00Z", "2026-09-23T10:30:00Z ", "2026-09-23T10:30:00Zextra", "2026-09-23T10:30:00+5:00", "2026-09-23T10:30:00+0500", "2026-09-23T10:30:00 America/Chicago",
    "2026-00-01T10:30:00Z", "2026-13-01T10:30:00Z", "2026-01-00T10:30:00Z", "2026-04-31T10:30:00Z", "2026-02-30T10:30:00Z", "2025-02-29T10:30:00Z", "2026-01-01T24:00:00Z", "2026-01-01T10:60:00Z", "2026-01-01T10:30:60Z", "2026-01-01T10:30:00+16:00", "2026-01-01T10:30:00+15:60",
  ]) assert.equal(guardian.isGuardianInvitationTimestamp(value), false, value);
  assert.ok(Number.isFinite(Date.parse("2026-04-31T10:30:00Z")));
  assert.equal(guardian.isGuardianInvitationTimestamp("2026-04-31T10:30:00Z"), false);
});

test("manager creation uses exactly the guardian RPC with server-generated hash and immediate-only link", async () => {
  const fixture = managerFixture();
  const result = await fixture.actions.createGuardianInvitation(athleteId, idle, form());
  assert.equal(result.status, "success");
  assert.match(result.invitationPath, /^\/guardian-invite\/z{64}$/);
  assert.deepEqual(fixture.calls, [{ name: "create_guardian_invitation", args: {
    p_athlete_id: athleteId, p_invited_email: "adult@example.com", p_token_hash: createHash("sha256").update("z".repeat(64)).digest("hex"), p_expires_at: fixture.calls[0].args.p_expires_at,
  } }]);
  assert.equal(JSON.stringify(fixture.calls[0].args).includes("z".repeat(64)), false);
  assert.ok(fixture.invalidated.includes(`/athletes/${athleteId}/guardians`));
});

test("manager writes fail closed without retries and revoke uses only its canonical RPC", async () => {
  const valid = { invitation_id: invitationId, expires_at: "2030-01-01T00:00:00Z" };
  for (const options of [{ result: { 0: valid, length: 1 } }, { result: [] }, { result: [valid, valid] }, { result: null }, { result: [{ expires_at: valid.expires_at }] }, { result: [{ invitation_id: "bad", expires_at: valid.expires_at }] }, { result: [{ invitation_id: null, expires_at: valid.expires_at }] }, { result: [{ invitation_id: invitationId, expires_at: "bad" }] }, { result: [{ invitation_id: invitationId, expires_at: null }] }, { result: [valid], error: { message: "unavailable" }, status: 503 }]) {
    const fixture = managerFixture(options);
    const result = await fixture.actions.createGuardianInvitation(athleteId, idle, form());
    assert.equal(result.status, "review_required");
    assert.equal(result.invitationPath, undefined);
    assert.equal(fixture.calls.length, 1);
  }
  const fixture = managerFixture();
  assert.equal((await fixture.actions.revokeGuardianInvitation(athleteId, invitationId, idle)).status, "success");
  assert.deepEqual(fixture.calls, [{ name: "revoke_guardian_invitation", args: { p_invitation_id: invitationId } }]);
});

function recipientFixture({ signedOut = false, summary = { athlete_display_name: "Private Athlete", expires_at: "2030-01-01T00:00:00Z", invitation_status: "pending" }, rpcError = false } = {}) {
  const calls = [];
  const client = { auth: { getUser: async () => ({ data: { user: signedOut ? null : { id: "recipient" } }, error: null }) }, rpc: async (name, args) => { calls.push({ name, args }); return rpcError ? { data: null, error: { message: "unavailable" } } : { data: summary ? [summary] : [], error: null }; } };
  const page = load("src/app/guardian-invite/[token]/page.tsx", {
    "next/navigation": { redirect: (destination) => { throw Error(`REDIRECT:${destination}`); } },
    "@/lib/supabase/server": { createClient: async () => ({}) },
    "next/link": { default: (props) => React.createElement("a", props) },
    "@/components/roster-action-form": { default: ({ label }) => React.createElement("button", null, label) },
    "@/components/guardian-invitation-acceptance-form": { default: () => React.createElement("div", null, "Accept guardian access") },
    "@/lib/guardian-invitations": guardian,
    "@/lib/supabase/server": { createClient: async () => client },
    "@/lib/supabase/service": { createServiceClient: () => client },
    "@/lib/verified-auth-identity": { getCurrentVerifiedAuthIdentity: async () => signedOut ? null : { authUserId: "recipient", verifiedEmail: "recipient@example.test" } },
    "./actions": { acceptGuardianInvitation: async () => idle, switchGuardianInvitationAccount: async () => idle },
  }).default;
  return { page, calls };
}

test("recipient disclosure is generic before the DB summary email gate and shows identity only after an authorized row", async () => {
  const missing = recipientFixture({ summary: null });
  const invalid = recipientFixture({ summary: null });
  const missingMarkup = renderToStaticMarkup(await missing.page({ params: Promise.resolve({ token }) }));
  const invalidMarkup = renderToStaticMarkup(await invalid.page({ params: Promise.resolve({ token: "short" }) }));
  assert.match(missingMarkup, /This invitation is unavailable/);
  assert.match(invalidMarkup, /This invitation is unavailable/);
  assert.doesNotMatch(missingMarkup, /Private Athlete|athlete_id|email match/i);
  const malformed = recipientFixture({ summary: { athlete_display_name: "Private Athlete", expires_at: "2026-04-31T10:30:00Z", invitation_status: "pending" } });
  const malformedMarkup = renderToStaticMarkup(await malformed.page({ params: Promise.resolve({ token }) }));
  assert.match(malformedMarkup, /could not load/i);
  assert.doesNotMatch(malformedMarkup, /Private Athlete/);
  const authorized = recipientFixture();
  assert.match(renderToStaticMarkup(await authorized.page({ params: Promise.resolve({ token }) })), /Private Athlete/);
  assert.deepEqual(authorized.calls, [{ name: "server_get_guardian_invitation_summary", args: { p_auth_user_id: "recipient", p_verified_email: "recipient@example.test", p_invitation_token: token } }]);
});

test("recipient acceptance invokes exactly one RPC and redirects only from its returned durable athlete identity", async () => {
  const calls = [];
  const actions = load("src/app/guardian-invite/[token]/actions.ts", {
    "next/navigation": { redirect: (destination) => { throw Error(`REDIRECT:${destination}`); } },
    "@/lib/supabase/server": { createClient: async () => ({}) },
    "@/lib/guardian-invitations": guardian,
    "@/lib/supabase/service": { createServiceClient: () => ({ rpc: async (name, args) => { calls.push({ name, args }); return { data: [{ athlete_id: returnedAthleteId }], error: null }; } }) },
    "@/lib/verified-auth-identity": { getCurrentVerifiedAuthIdentity: async () => ({ authUserId: "recipient", verifiedEmail: "recipient@example.test" }) },
    "@/lib/training-assignment": { isUuid: (value) => /^[0-9a-f-]{36}$/i.test(value) },
  });
  await assert.rejects(actions.acceptGuardianInvitation(token, idle, new FormData()), (error) => error.message === `REDIRECT:/?athlete=${returnedAthleteId}`);
  assert.deepEqual(calls, [{ name: "server_accept_guardian_invitation", args: { p_auth_user_id: "recipient", p_verified_email: "recipient@example.test", p_invitation_token: token } }]);
});

test("malformed or errored acceptance responses never redirect or retry", async () => {
  const valid = { athlete_id: returnedAthleteId };
  for (const response of [{ data: { 0: valid, length: 1 }, error: null }, { data: [], error: null }, { data: [valid, valid], error: null }, { data: null, error: null }, { data: [{}], error: null }, { data: [{ athlete_id: "bad" }], error: null }, { data: [{ athlete_id: null }], error: null }, { data: [valid], error: { message: "error wins" } }]) {
    const calls = [];
    const actions = load("src/app/guardian-invite/[token]/actions.ts", {
      "next/navigation": { redirect: () => { throw Error("UNEXPECTED_REDIRECT"); } },
      "@/lib/supabase/server": { createClient: async () => ({}) },
      "@/lib/guardian-invitations": guardian,
      "@/lib/supabase/service": { createServiceClient: () => ({ rpc: async (name, args) => { calls.push({ name, args }); return response; } }) },
      "@/lib/verified-auth-identity": { getCurrentVerifiedAuthIdentity: async () => ({ authUserId: "recipient", verifiedEmail: "recipient@example.test" }) },
      "@/lib/training-assignment": { isUuid: (value) => /^[0-9a-f-]{36}$/i.test(value) },
    });
    const result = await actions.acceptGuardianInvitation(token, idle, new FormData());
    assert.ok(["error", "review_required"].includes(result.status));
    assert.equal(calls.length, 1);
  }
});

test("guardian UI remains RPC-only and carries no bearer persistence, permission selection, or direct table access", () => {
  for (const source of [managerSource, managerPageSource, recipientPageSource, recipientActionsSource]) assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|telemetry|\.from\("guardian_invitations"\)|\.insert\(/i);
  assert.match(managerSource, /randomBytes\(48\)\.toString\("base64url"\)/);
  assert.match(managerSource, /createHash\("sha256"\)/);
  assert.match(managerPageSource, /list_my_guardian_invitations/);
  assert.match(recipientActionsSource, /getCurrentVerifiedAuthIdentity\(\)/);
  assert.match(recipientActionsSource, /rpc\("server_accept_guardian_invitation"/);
  assert.doesNotMatch(recipientActionsSource, /athleteId|permission|\.from\(|\.insert\(/);
});
