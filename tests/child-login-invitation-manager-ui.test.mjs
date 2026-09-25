import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const athleteA = "00000000-0000-4000-8000-000000000001";
const athleteB = "00000000-0000-4000-8000-000000000002";
const invitationId = "00000000-0000-4000-8000-000000000003";
const idle = { status: "idle", message: "" };
const uuid = (value) => /^[0-9a-f-]{36}$/i.test(value);

function load(path, mocks = {}) {
  const source = ts.transpileModule(readFileSync(root + path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  new vm.Script(`(function(require, module, exports) {${source}\n})`).runInThisContext()(
    (name) => name in mocks ? mocks[name] : require(name), loaded, loaded.exports,
  );
  return loaded.exports;
}

const childLogin = load("src/lib/child-login-invitations.ts", {
  "@/lib/auth-continuation": { authPath: (pathname, next) => `${pathname}?next=${encodeURIComponent(next)}` },
  "@/lib/training-assignment": { isUuid: uuid },
});
const pageSource = readFileSync(root + "src/app/athletes/[athleteId]/child-login/page.tsx", "utf8");
const actionsSource = readFileSync(root + "src/app/athletes/[athleteId]/child-login/actions.ts", "utf8");
const dashboardSource = readFileSync(root + "src/app/page.tsx", "utf8");
const guardianPageSource = readFileSync(root + "src/app/athletes/[athleteId]/guardians/page.tsx", "utf8");

function form(email = " Child@Example.com ") {
  const data = new FormData();
  data.set("email", email);
  return data;
}

function contexts(role = "guardian", canManage = true) {
  return [{ athleteId: athleteA, displayName: "Athlete A", graduationYear: null, relationshipRole: role, canManage, canAct: false }];
}

function actionFixture({ familyContexts = contexts(), response = { data: [{ invitation_id: invitationId, expires_at: "2030-01-01T00:00:00Z" }], error: null, status: 201 } } = {}) {
  const calls = [];
  const invalidated = [];
  const actions = load("src/app/athletes/[athleteId]/child-login/actions.ts", {
    "node:crypto": {
      randomBytes: (size) => ({ toString: (encoding) => { assert.equal(size, 48); assert.equal(encoding, "base64url"); return "z".repeat(64); } }),
      createHash,
    },
    "next/cache": { revalidatePath: (path) => invalidated.push(path) },
    "@/components/family-invitation-action-form": {},
    "@/lib/child-login-invitations": childLogin,
    "@/lib/my-athlete-contexts-server": { loadMyFamilyAthleteContexts: async () => familyContexts },
    "@/lib/supabase/server": { createClient: async () => ({ rpc: async (name, args) => { calls.push({ name, args }); return name === "revoke_child_login_invitation" ? { data: null, error: response.error, status: response.status } : response; } }) },
    "@/lib/training-assignment": { isUuid: uuid },
  });
  return { actions, calls, invalidated };
}

test("child-login parsers expose only the manager contract and reject malformed results", () => {
  const create = { invitation_id: invitationId, expires_at: "2030-01-01T00:00:00Z" };
  const list = { invitation_id: invitationId, invited_email: "child@example.com", invitation_status: "pending", expires_at: "2030-01-01T00:00:00Z", created_at: "2029-12-01T00:00:00Z" };
  assert.deepEqual(childLogin.parseChildLoginInvitationCreate([create]), create);
  assert.equal(childLogin.parseChildLoginInvitationCreate([{ ...create, token_hash: "secret" }]), null);
  assert.deepEqual(childLogin.parseChildLoginInvitationList([list]), [list]);
  for (const value of [[{ ...list, token_hash: "secret" }], [{ ...list, invited_email: " " }], [{ ...list, invitation_status: "unknown" }], { 0: list, length: 1 }]) assert.equal(childLogin.parseChildLoginInvitationList(value), null);
  assert.equal(childLogin.childLoginInvitationPath("z".repeat(64)), `/child-login-invite/${"z".repeat(64)}`);
});

test("manager create uses canonical selected context, hashes a server token, and returns only a relative one-time link", async () => {
  const fixture = actionFixture();
  const result = await fixture.actions.createChildLoginInvitation(athleteA, idle, form());
  assert.equal(result.status, "success");
  assert.equal(result.invitationPath, `/child-login-invite/${"z".repeat(64)}`);
  assert.deepEqual(fixture.calls, [{ name: "create_child_login_invitation", args: {
    p_athlete_id: athleteA,
    p_invited_email: "child@example.com",
    p_token_hash: createHash("sha256").update("z".repeat(64)).digest("hex"),
  } }]);
  assert.equal(JSON.stringify(fixture.calls[0].args).includes("z".repeat(64)), false);
  assert.deepEqual(fixture.invalidated, [`/athletes/${athleteA}/child-login`]);
});

test("actions fail closed for a non-managing or tampered athlete subject and use only released RPCs", async () => {
  const fixture = actionFixture({ familyContexts: contexts("self", false) });
  const denied = await fixture.actions.createChildLoginInvitation(athleteA, idle, form());
  assert.equal(denied.status, "error");
  assert.equal(fixture.calls.length, 0);
  const valid = actionFixture();
  const revoked = await valid.actions.revokeChildLoginInvitation(athleteA, invitationId, idle);
  assert.equal(revoked.status, "success");
  assert.deepEqual(valid.calls, [{ name: "revoke_child_login_invitation", args: { p_invitation_id: invitationId } }]);
  const tampered = await valid.actions.revokeChildLoginInvitation(athleteB, invitationId, idle);
  assert.equal(tampered.status, "error");
  assert.equal(valid.calls.length, 1);
});

test("known write rejections are safe and uncertain outcomes require review without retry", async () => {
  for (const [message, expected] of [
    ["Athlete self claim is unavailable", /already has self-login history/],
    ["A pending child login invitation already exists", /already an active/],
    ["Child login invitation is not authorized", /no longer have permission/],
  ]) {
    const fixture = actionFixture({ response: { data: null, error: { message }, status: 400 } });
    const result = await fixture.actions.createChildLoginInvitation(athleteA, idle, form());
    assert.equal(result.status, "error");
    assert.match(result.message, expected);
    assert.equal(fixture.calls.length, 1);
  }
  const uncertain = actionFixture({ response: { data: [], error: null, status: 201 } });
  assert.equal((await uncertain.actions.createChildLoginInvitation(athleteA, idle, form())).status, "review_required");
  assert.equal(uncertain.calls.length, 1);
});

function managerPageFixture(familyContexts) {
  const page = load("src/app/athletes/[athleteId]/child-login/page.tsx", {
    "next/navigation": { redirect: (destination) => { throw Error(`REDIRECT:${destination}`); } },
    "next/link": { default: (props) => React.createElement("a", props) },
    "@/components/family-invitation-action-form": { default: ({ label, children }) => React.createElement("section", null, label, children) },
    "@/lib/child-login-invitations": childLogin,
    "@/lib/my-athlete-contexts-server": { loadMyFamilyAthleteContexts: async () => familyContexts },
    "@/lib/supabase/server": { createClient: async () => ({ rpc: async () => ({ data: [], error: null }) }) },
    "@/lib/team-invitations": { formatInvitationDate: (value) => value },
    "@/lib/training-assignment": { isUuid: uuid },
    "./actions": { createChildLoginInvitation: async () => idle, revokeChildLoginInvitation: async () => idle },
  }).default;
  return page;
}

test("page allows selected guardian or SELF MANAGE contexts but suppresses create for active SELF", async () => {
  const guardianMarkup = renderToStaticMarkup(await managerPageFixture(contexts("guardian", true))({ params: Promise.resolve({ athleteId: athleteA }) }));
  assert.match(guardianMarkup, /Create child login invitation/);
  const selfMarkup = renderToStaticMarkup(await managerPageFixture(contexts("self", true))({ params: Promise.resolve({ athleteId: athleteA }) }));
  assert.match(selfMarkup, /already has self-login history/);
  assert.doesNotMatch(selfMarkup, /Child email address/);
  await assert.rejects(managerPageFixture(contexts("self", false))({ params: Promise.resolve({ athleteId: athleteA }) }), /REDIRECT:\//);
});

test("source keeps canonical SELF precedence, profile-to-athlete separation, guardian isolation, and the sealed recipient boundary", () => {
  assert.match(pageSource, /candidate\.athleteId === athleteId && candidate\.canManage/);
  assert.doesNotMatch(pageSource, /relationshipRole === "guardian"/);
  assert.match(actionsSource, /loadMyFamilyAthleteContexts/);
  assert.match(actionsSource, /p_athlete_id: athleteId/);
  assert.doesNotMatch(actionsSource, /get_child_login_invitation_summary|accept_child_login_invitation|\.from\(|\.insert\(/);
  assert.match(actionsSource, /randomBytes\(48\)\.toString\("base64url"\)/);
  assert.match(actionsSource, /createHash\("sha256"\)/);
  assert.match(dashboardSource, /activeContext\?\.canManage[\s\S]*\/child-login/);
  assert.match(guardianPageSource, /candidate\.relationshipRole === "guardian" && candidate\.canManage/);
  assert.doesNotMatch(guardianPageSource, /child-login/);
  assert.doesNotMatch(`${pageSource}\n${actionsSource}`, /localStorage|sessionStorage|auth\.users|profiles\(|console\.(?:log|error|warn)/i);
});

test("multi-athlete links remain durable-athlete scoped and no permission merge is introduced", () => {
  assert.match(dashboardSource, /encodeURIComponent\(activeContext\.athleteId\).*\/child-login/);
  assert.doesNotMatch(actionsSource, /canManage\s*\|\||canAct|relationshipRole.*guardian.*\|\|/);
  assert.match(actionsSource, /candidate\.athleteId === athleteId && candidate\.canManage/);
});
