import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const teamId = "00000000-0000-4000-8000-000000000001";
const parentId = "00000000-0000-4000-8000-000000000002";
const childId = "00000000-0000-4000-8000-000000000003";
const idle = { status: "idle", message: "" };

function loadTs(path, mocks) {
  const source = ts.transpileModule(readFileSync(root + path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  const run = new vm.Script(`(function(require, module, exports) {${source}\n})`).runInThisContext();
  run((name) => name in mocks ? mocks[name] : require(name), loaded, loaded.exports);
  return loaded.exports;
}

function actionFixture({ reject = false } = {}) {
  const calls = [];
  const context = { user: { id: parentId }, supabase: {
    async rpc(name, args) {
      calls.push({ name, args });
      return reject ? { error: { message: "not authorized" } } : { data: name === "create_my_athlete" ? childId : [{ team_id: teamId, athlete_id: childId }], error: null };
    },
  } };
  const actions = loadTs("src/app/teams/[teamId]/roster/actions.ts", {
    "next/cache": { revalidatePath() {} },
    "@/lib/training-assignment": { isUuid: (value) => /^[0-9a-f-]{36}$/i.test(value) },
    "@/lib/team-invitations": { canManageInvitation() { return true; }, canRemoveMember() { return true; }, normalizeInvitationEmail(value) { return String(value); } },
    "@/lib/team-roster-server": { requireRosterManager: async () => context },
  });
  return { actions, calls };
}

function childForm(name = "Child Athlete", year = "") {
  const form = new FormData();
  form.set("displayName", name);
  form.set("graduationYear", year);
  return form;
}

test("child creation calls only the canonical creator with display fields and no actor identity", async () => {
  const { actions, calls } = actionFixture();
  assert.equal((await actions.createManagedAthlete(teamId, idle, childForm("  Child Athlete  ", "2030"))).status, "success");
  assert.deepEqual(calls, [{ name: "create_my_athlete", args: { p_display_name: "Child Athlete", p_graduation_year: 2030 } }]);
  assert.equal(JSON.stringify(calls).includes(parentId), false);
});

test("child creation permits omitted graduation year and rejects invalid years before its RPC", async () => {
  const { actions, calls } = actionFixture();
  await actions.createManagedAthlete(teamId, idle, childForm("Child Athlete"));
  assert.equal(calls[0].args.p_graduation_year, null);
  for (const year of ["1999", "2101", "20x0"]) {
    const fixture = actionFixture();
    assert.equal((await fixture.actions.createManagedAthlete(teamId, idle, childForm("Child", year))).status, "error");
    assert.equal(fixture.calls.length, 0);
  }
});

test("adding a managed athlete delegates only durable identifiers to the canonical roster RPC", async () => {
  const { actions, calls } = actionFixture();
  const form = new FormData(); form.set("athleteId", childId);
  assert.equal((await actions.addManagedAthleteToTeam(teamId, idle, form)).status, "success");
  assert.deepEqual(calls, [{ name: "add_my_managed_athlete_to_team", args: { p_team_id: teamId, p_athlete_id: childId } }]);
  assert.equal(JSON.stringify(calls).includes(parentId), false);
});

test("invalid or rejected roster additions do not fall back to direct membership writes", async () => {
  const invalid = actionFixture();
  const form = new FormData(); form.set("athleteId", "not-a-uuid");
  assert.equal((await invalid.actions.addManagedAthleteToTeam(teamId, idle, form)).status, "error");
  assert.equal(invalid.calls.length, 0);
  const rejected = actionFixture({ reject: true });
  const valid = new FormData(); valid.set("athleteId", childId);
  assert.equal((await rejected.actions.addManagedAthleteToTeam(teamId, idle, valid)).status, "error");
  assert.equal(rejected.calls[0].name, "add_my_managed_athlete_to_team");
});

test("roster and assignment use the canonical reader while managed-athlete discovery remains relationship-scoped", () => {
  const rosterServer = readFileSync(root + "src/lib/team-roster-server.ts", "utf8");
  const rosterPage = readFileSync(root + "src/app/teams/[teamId]/roster/page.tsx", "utf8");
  const assignmentPage = readFileSync(root + "src/app/teams/[teamId]/assign/page.tsx", "utf8");
  assert.match(rosterServer, /from\("athlete_profile_relationships"\)[\s\S]*manage_permission/);
  assert.match(rosterServer, /rpc\("list_my_team_rostered_athlete_identities"/);
  assert.match(rosterServer, /from\("athletes"\)[\s\S]*display_name, graduation_year, status/);
  assert.match(rosterPage, /durableAthletes\.map\(\(athlete\)/);
  assert.match(rosterPage, /managedAthletes\.map\(\(athlete\)/);
  assert.match(assignmentPage, /rpc\("list_my_team_rostered_athlete_identities"/);
  assert.doesNotMatch(assignmentPage, /athletes!team_athlete_memberships_athlete_id_fkey/);
  assert.doesNotMatch(rosterServer.slice(rosterServer.indexOf("export async function loadDurableRoster"), rosterServer.indexOf("export async function loadManagedAthletes")), /from\("athletes"\)|from\("team_athlete_memberships"\)/);
  assert.doesNotMatch(assignmentPage, /team_memberships[\s\S]*profiles!team_memberships_user_id_fkey/);
  assert.doesNotMatch(assignmentPage, /athlete_user_id.*profiles/);
});

test("assignment continues sending durable athlete IDs to the existing canonical writer", () => {
  const source = readFileSync(root + "src/app/teams/[teamId]/assign/actions.ts", "utf8");
  assert.match(source, /p_athlete_ids:\s*athleteIds/);
  assert.match(source, /from\("team_athlete_memberships"\)/);
  assert.doesNotMatch(source, /\.insert\([^\n]*team_athlete_memberships/);
});
