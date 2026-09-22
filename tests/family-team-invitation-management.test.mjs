import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const teamId = "00000000-0000-4000-8000-000000000001";
const invitationId = "00000000-0000-4000-8000-000000000002";
const idle = { status: "idle", message: "" };
function load(path, mocks = {}) {
  const source = ts.transpileModule(readFileSync(root + path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  new vm.Script(`(function(require, module, exports) {${source}\n})`).runInThisContext()((name) => name in mocks ? mocks[name] : require(name), loaded, loaded.exports);
  return loaded.exports;
}
const family = load("src/lib/family-team-invitations.ts", { "@/lib/auth-continuation": { authPath: (path, next) => `${path}?next=${encodeURIComponent(next)}` } });
const actionsSource = readFileSync(root + "src/app/teams/[teamId]/roster/actions.ts", "utf8");
const rosterSource = readFileSync(root + "src/app/teams/[teamId]/roster/page.tsx", "utf8");
const formSource = readFileSync(root + "src/components/family-invitation-action-form.tsx", "utf8");

function setup({ manager = true, rpcError = null } = {}) {
  const calls = [], invalidations = [];
  const client = { rpc: async (name, args) => {
    calls.push({ name, args });
    if (rpcError) return { data: null, error: { message: "raw database detail" }, status: rpcError };
    if (name === "revoke_family_team_invitation") return { data: null, error: null, status: 200 };
    return { data: [{ invitation_id: invitationId, expires_at: "2030-01-01T00:00:00Z" }], error: null, status: 201 };
  } };
  const actions = load("src/app/teams/[teamId]/roster/actions.ts", {
    "next/cache": { revalidatePath: (path) => invalidations.push(path) },
    "@/lib/family-team-invitations": family,
    "@/lib/training-assignment": { isUuid: (value) => value === invitationId },
    "@/lib/team-invitations": { canManageInvitation: () => true, canRemoveMember: () => true, normalizeInvitationEmail: () => "legacy@example.com" },
    "@/lib/team-roster-server": { requireRosterManager: async () => {
      if (!manager) throw Error("not authorized");
      return { user: { id: "manager", email: "manager@example.com" }, supabase: client };
    } },
  });
  return { actions, calls, invalidations };
}

function form(email = " Parent@Example.com ") {
  const data = new FormData();
  data.set("email", email);
  return data;
}

test("family invitation creation is a roster-manager RPC boundary with a server-generated hash", async () => {
  const fixture = setup();
  const result = await fixture.actions.createFamilyInvitation(teamId, idle, form());
  assert.equal(result.status, "success");
  assert.match(result.invitationPath, /^\/family-invite\/[A-Za-z0-9_-]{64}$/);
  assert.equal(fixture.calls.length, 1);
  const call = fixture.calls[0];
  assert.equal(call.name, "create_family_team_invitation");
  assert.deepEqual(Object.keys(call.args).sort(), ["p_expires_at", "p_invited_email", "p_team_id", "p_token_hash"]);
  assert.equal(call.args.p_team_id, teamId);
  assert.equal(call.args.p_invited_email, "parent@example.com");
  const rawToken = result.invitationPath.split("/").at(-1);
  assert.equal(call.args.p_token_hash, createHash("sha256").update(rawToken).digest("hex"));
  assert.equal(JSON.stringify(call.args).includes(rawToken), false);
  assert.ok(fixture.invalidations.includes(`/teams/${teamId}/roster`));
});

test("family invitation validation and authorization fail before any RPC", async () => {
  for (const options of [{}, { manager: false }]) {
    const fixture = setup(options);
    const result = await fixture.actions.createFamilyInvitation(teamId, idle, options.manager === false ? form() : form("bad"));
    assert.equal(result.status, "error");
    assert.equal(fixture.calls.length, 0);
  }
});

test("family invitation errors are controlled and never return raw database detail or a token", async () => {
  const fixture = setup({ rpcError: 400 });
  const result = await fixture.actions.createFamilyInvitation(teamId, idle, form());
  assert.equal(result.status, "error");
  assert.doesNotMatch(result.message, /raw database detail|[A-Za-z0-9_-]{32,}/);
  assert.equal(result.invitationPath, undefined);
});

test("family invitation revocation uses only the canonical RPC after server-side manager authorization", async () => {
  const fixture = setup();
  const result = await fixture.actions.revokeFamilyInvitation(teamId, invitationId, idle);
  assert.equal(result.status, "success");
  assert.deepEqual(fixture.calls, [{ name: "revoke_family_team_invitation", args: { p_invitation_id: invitationId } }]);
});

test("family invitation UI is distinct, metadata-only, and never reconstructs prior links", () => {
  assert.match(rosterSource, /Invite a family/);
  assert.match(rosterSource, /Parent or guardian email/);
  assert.match(rosterSource, /family_team_invitations/);
  assert.match(rosterSource, /select\("id, invited_email, status, created_at, expires_at"\)/);
  assert.doesNotMatch(rosterSource, /token_hash|accept_family_team_invitation/);
  assert.match(formSource, /navigator\.clipboard\.writeText\(link\)/);
  assert.doesNotMatch(formSource, /localStorage|sessionStorage|indexedDB|telemetry/);
});

test("family action source has no direct family-table mutation, acceptance, athlete selection, or weak randomness", () => {
  const familyActions = actionsSource.slice(actionsSource.indexOf("export async function createFamilyInvitation"));
  assert.match(actionsSource, /requireRosterManager/);
  assert.match(familyActions, /randomBytes\(48\)\.toString\("base64url"\)/);
  assert.match(familyActions, /createHash\("sha256"\)/);
  assert.doesNotMatch(familyActions, /\.from\("family_team_invitations"\)|accept_family_team_invitation|Math\.random|athleteId|p_existing_athlete_id|p_first_name/);
  const legacy = readFileSync(root + "src/app/invite/[token]/page.tsx", "utf8");
  assert.doesNotMatch(legacy, /family_team_invitations|family-invite/);
});
