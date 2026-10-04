import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const token = "a".repeat(64);
const submittedAthlete = "00000000-0000-4000-8000-000000000001";
const returnedAthlete = "00000000-0000-4000-8000-000000000002";
const returnedTeam = "00000000-0000-4000-8000-000000000003";
const idle = { status: "idle", message: "" };

function load(mocks) {
  const source = ts.transpileModule(readFileSync(root + "src/app/family-invite/[token]/actions.ts", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const loaded = { exports: {} };
  new vm.Script(`(function(require, module, exports) {${source}\n})`).runInThisContext()((name) => name in mocks ? mocks[name] : require(name), loaded, loaded.exports);
  return loaded.exports;
}

function fixture({ result = [{ team_id: returnedTeam, athlete_id: returnedAthlete }], error = null, status = 200, signedOut = false } = {}) {
  const calls = [];
  const actions = load({
    "next/navigation": { redirect(destination) { throw Error(`REDIRECT:${destination}`); } },
    "@/lib/supabase/server": { createClient: async () => ({}) },
    "@/lib/supabase/service": { createServiceClient: () => ({ rpc: async (name, args) => { calls.push({ name, args }); return { data: result, error, status }; } }) },
    "@/lib/verified-auth-identity": { getCurrentVerifiedAuthIdentity: async () => signedOut ? null : { authUserId: "recipient-account", verifiedEmail: "recipient@example.test" } },
    "@/lib/family-team-invitations": { familyInvitationLoginPath: () => "/login", isFamilyInvitationToken: (value) => value === token },
    "@/lib/training-assignment": { isUuid: (value) => /^[0-9a-f-]{36}$/i.test(value) },
  });
  return { actions, calls };
}

function form(values = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

test("existing athlete acceptance sends the untrusted subject only to the canonical RPC and redirects from its returned identity", async () => {
  const { actions, calls } = fixture();
  await assert.rejects(actions.acceptFamilyTeamInvitation(token, idle, form({ athleteId: submittedAthlete })), (error) => error.message === `REDIRECT:/?athlete=${returnedAthlete}`);
  assert.deepEqual(calls, [{ name: "server_accept_family_team_invitation", args: {
    p_auth_user_id: "recipient-account", p_verified_email: "recipient@example.test", p_invitation_token: token, p_existing_athlete_id: submittedAthlete,
    p_first_name: null, p_last_name: null, p_graduation_year: null,
  } }]);
});

test("new child acceptance uses one atomic RPC call with normalized structured details", async () => {
  const { actions, calls } = fixture();
  await assert.rejects(actions.acceptFamilyTeamInvitation(token, idle, form({ firstName: "  New ", lastName: " Child  ", graduationYear: "2034" })), /REDIRECT/);
  assert.deepEqual(calls[0].args, {
    p_auth_user_id: "recipient-account", p_verified_email: "recipient@example.test", p_invitation_token: token, p_existing_athlete_id: null,
    p_first_name: "New", p_last_name: "Child", p_graduation_year: 2034,
  });
});

test("mixed partial and missing acceptance modes fail before the RPC", async () => {
  for (const values of [
    { athleteId: submittedAthlete, firstName: "Child" },
    { firstName: "Child" },
    {},
  ]) {
    const { actions, calls } = fixture();
    assert.equal((await actions.acceptFamilyTeamInvitation(token, idle, form(values))).status, "error");
    assert.equal(calls.length, 0);
  }
});

test("known acceptance failures are translated and an uncertain result is never retried", async () => {
  for (const [message, expected] of [
    ["Invitation email does not match the signed-in account", "Sign in with the email"],
    ["Family invitation is no longer pending", "invalid or unavailable"],
    ["Inviter no longer has permission to enroll families", "can no longer add"],
    ["Selected athlete is unavailable", "no longer available"],
  ]) {
    const { actions } = fixture({ error: { message }, status: 400 });
    assert.match((await actions.acceptFamilyTeamInvitation(token, idle, form({ athleteId: submittedAthlete }))).message, new RegExp(expected));
  }
  const { actions, calls } = fixture({ result: null, status: undefined });
  assert.equal((await actions.acceptFamilyTeamInvitation(token, idle, form({ athleteId: submittedAthlete }))).status, "review_required");
  assert.equal(calls.length, 1);
});

test("malformed canonical acceptance results never redirect or fall back to a submitted or actor identity", async () => {
  const malformedResults = [
    [],
    [{ team_id: returnedTeam, athlete_id: returnedAthlete }, { team_id: returnedTeam, athlete_id: returnedAthlete }],
    [{}],
    [{ team_id: returnedTeam }],
    [{ team_id: returnedTeam, athlete_id: null }],
    [{ team_id: returnedTeam, athlete_id: "not-a-uuid" }],
    [{ athlete_id: returnedAthlete }],
    [{ team_id: null, athlete_id: returnedAthlete }],
    [{ team_id: "not-a-uuid", athlete_id: returnedAthlete }],
    { team_id: returnedTeam, athlete_id: returnedAthlete },
    null,
  ];
  for (const result of malformedResults) {
    const { actions, calls } = fixture({ result });
    const state = await actions.acceptFamilyTeamInvitation(token, idle, form({ athleteId: submittedAthlete }));
    assert.equal(state.status, "review_required");
    assert.equal(calls.length, 1);
    assert.doesNotMatch(state.message, new RegExp(`${submittedAthlete}|recipient-account`));
  }
});

test("acceptance action keeps all child and invitation mutations inside the canonical RPC", () => {
  const source = readFileSync(root + "src/app/family-invite/[token]/actions.ts", "utf8");
  const component = readFileSync(root + "src/components/family-invitation-acceptance-form.tsx", "utf8");
  assert.match(source, /getCurrentVerifiedAuthIdentity\(\)/);
  assert.match(source, /createServiceClient\(\)\.rpc\("server_accept_family_team_invitation"/);
  assert.doesNotMatch(source, /create_my_athlete|athlete_profile_relationships|team_athlete_memberships|\.from\(|\.insert\(/);
  assert.doesNotMatch(component, /name="(?:email|birth|dob|address|school|password|token_hash)"/i);
  assert.match(component, /firstName[\s\S]*lastName[\s\S]*graduationYear/);
});
