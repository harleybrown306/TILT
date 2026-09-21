import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Only session-scoped mocks: no network requests or live database writes.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
function loadTs(path, mocks = {}) {
  const source = ts.transpileModule(readFileSync(root + path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loadedModule = { exports: {} };
  const run = new vm.Script(`(function(require, module, exports) {${source}\n})`).runInThisContext();
  run((name) => name in mocks ? mocks[name] : require(name), loadedModule, loadedModule.exports);
  return loadedModule.exports;
}
const logic = loadTs("src/lib/team-creation.ts");
const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const userId = id(1), newTeamId = id(2), oldTeamId = id(3);
const idle = { status: "idle", message: "" };
function form(name = "  JV   Lacrosse  ") {
  const data = new FormData();
  if (name !== null) data.set("name", name);
  data.set("created_by_user_id", id(999));
  data.set("user_id", id(999));
  data.set("role", "athlete");
  return data;
}
function setup(options = {}) {
  const calls = [], invalidations = [];
  const tables = {
    profiles: [{ id: userId, full_name: "Test user", platform_role: "user" }],
    teams: [{ id: oldTeamId, name: "Original team", created_by_user_id: id(900) }],
    team_memberships: options.zeroTeams ? [] : [{ id: id(4), team_id: oldTeamId, user_id: userId, role: options.existingRole ?? "athlete", created_by_user_id: id(900), teams: { id: oldTeamId, name: "Original team" }, profiles: { id: userId, full_name: "Test user" } }],
    training_sessions: [],
  };
  const client = {
    auth: { getUser: async () => ({ data: { user: options.signedOut ? null : { id: userId } }, error: options.authError ? { message: "denied" } : null }) },
    from(table) {
      let operation = "read", payload, single = false;
      const filters = [];
      const query = {
        select() { return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        order() { return query; },
        single() { single = true; return query; },
        insert(value) { operation = "insert"; payload = value; return query; },
        then(resolve, reject) {
          calls.push({ table, operation, payload, filters });
          if (options.throwOn === `${table}:${operation}`) return Promise.reject(Error("connection lost")).then(resolve, reject);
          if (operation === "insert") {
            // Model the inspected on_team_created trigger and transaction rollback.
            if (options.insertFailure !== undefined || options.triggerFailure) return Promise.resolve({ data: null, error: { message: "rejected" }, status: options.insertFailure ?? 400 }).then(resolve, reject);
            assert.equal(table, "teams", "app must rely on the atomic membership trigger");
            tables.teams.push({ ...payload });
            if (!options.missingMembership) tables.team_memberships.push({
              id: id(5), team_id: payload.id, user_id: payload.created_by_user_id,
              role: options.wrongRole ? "athlete" : "coach", created_by_user_id: options.wrongCreator ? id(999) : payload.created_by_user_id,
              teams: { id: payload.id, name: payload.name }, profiles: { id: userId, full_name: "Test user" },
            });
            return Promise.resolve({ data: null, error: null, status: 201 }).then(resolve, reject);
          }
          if (options.readError === table) return Promise.resolve({ data: null, error: { message: "denied" }, status: 403 }).then(resolve, reject);
          const rows = (tables[table] ?? []).filter((row) => filters.every(([key, value]) => row[key] === value));
          return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null, status: 200 }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const mocks = {
    "node:crypto": { randomUUID: () => newTeamId },
    "@/lib/supabase/server": { createClient: async () => client },
    "@/lib/team-creation": logic,
    "next/cache": { revalidatePath: (path) => invalidations.push(path) },
    "next/navigation": { redirect: (path) => { throw Error(`REDIRECT:${path}`); }, notFound: () => { throw Error("404"); } },
    "next/link": { default: (props) => React.createElement("a", props) },
    "@/components/sign-out-button": { default: () => null },
    "@/lib/team-attendance": {
      localDate: () => "2026-09-14",
      shiftDate: (date) => date,
      formatScheduledDate: (date) => date,
      attendanceStatus: (session, today) => session.completedAt || session.storedStatus === "completed" ? "completed" : session.scheduledDate > today ? "upcoming" : "pending",
    },
    "@/lib/team-attendance-server": { loadTeamAttendance: async (teamId) => ({ team: tables.teams.find((team) => team.id === teamId), sessions: [], athletes: [] }) },
    "@/lib/coach-attention-signals": { deriveCoachAttentionSignals: () => [] },
    "@/lib/athlete-exercise-adherence": {
      athleteExerciseAdherenceInput: () => ({ result: null, attempt: null, prescription: null }),
    },
    "@/lib/exercise-adherence": {
      calculateExerciseAdherence: () => ({ available: false, completedBlocks: null, prescribedBlocks: null, skippedBlocks: null, ratio: null, percentage: null }),
      aggregateExerciseAdherence: () => ({ available: false, completedBlocks: 0, prescribedBlocks: 0, skippedBlocks: 0, eligibleSessionCount: 0, unavailableSessionCount: 0, ratio: null, percentage: null }),
    },
    "@/lib/athlete-dashboard": {
      isCompleted: (session) => session.status === "completed" || Boolean(session.completedAt),
      displayMinutes: (milliseconds) => Math.round(milliseconds / 60000),
      athleteDashboardMetrics: () => ({ weeklyWorkMs: 0, monthlyWorkMs: 0, totalCompletedWorkouts: 0, trainingDays: 0, currentStreak: 0 }),
      activityBuckets: () => [],
    },
  };
  const action = loadTs("src/app/teams/new/actions.ts", mocks).createTeam;
  return { action, mocks, tables, calls, invalidations };
}
const writes = (fixture) => fixture.calls.filter((call) => call.operation !== "read");
test("team name normalization and reasonable length", () => {
  assert.equal(logic.readTeamName("  JV \n Lacrosse\t Team  "), "JV Lacrosse Team");
  assert.equal(logic.readTeamName("x".repeat(100)).length, 100);
  for (const name of [null, "", " \t\n ", "x".repeat(101), new Blob(["name"])]) assert.throws(() => logic.readTeamName(name));
});
for (const [label, options, name] of [
  ["signed out", { signedOut: true }, "Team"],
  ["auth error", { authError: true }, "Team"],
  ["missing name", {}, null],
  ["blank name", {}, "  \n "],
  ["long name", {}, "x".repeat(101)],
]) {
  test(`${label} creation is denied without writes`, async () => {
    const fixture = setup(options);
    assert.equal((await fixture.action(idle, form(name))).status, "error");
    assert.equal(writes(fixture).length, 0);
  });
}
for (const options of [{ zeroTeams: true }, { existingRole: "athlete" }, { existingRole: "coach" }]) {
  test(`creation derives auth identity and adds only a new coach role ${JSON.stringify(options)}`, async () => {
    const fixture = setup(options);
    const existing = structuredClone(fixture.tables.team_memberships);
    await assert.rejects(fixture.action(idle, form()), new RegExp(`REDIRECT:/teams/${newTeamId}`));
    assert.deepEqual(writes(fixture).map((call) => ({ table: call.table, payload: call.payload })), [{ table: "teams", payload: { id: newTeamId, name: "JV Lacrosse", created_by_user_id: userId } }]);
    const membership = fixture.tables.team_memberships.find((row) => row.team_id === newTeamId);
    assert.equal(membership.user_id, userId);
    assert.equal(membership.role, "coach");
    assert.equal(membership.created_by_user_id, userId);
    assert.deepEqual(fixture.tables.team_memberships.filter((row) => row.team_id !== newTeamId), existing);
    assert.equal(fixture.tables.profiles[0].platform_role, "user");
    assert.deepEqual(fixture.invalidations, ["/", `/teams/${newTeamId}`]);
  });
}
for (const options of [{ insertFailure: 403 }, { triggerFailure: true }]) {
  test(`definite insert/trigger rejection rolls back both rows without cleanup ${JSON.stringify(options)}`, async () => {
    const fixture = setup(options);
    const original = structuredClone(fixture.tables);
    assert.equal((await fixture.action(idle, form())).status, "error");
    assert.deepEqual(fixture.tables, original);
    assert.equal(writes(fixture).length, 1);
    assert.equal(fixture.invalidations.length, 0);
  });
}
for (const options of [
  { insertFailure: 0 }, { insertFailure: 503 }, { insertFailure: 408 }, { throwOn: "teams:insert" },
  { readError: "team_memberships" }, { readError: "teams" }, { missingMembership: true }, { wrongRole: true }, { wrongCreator: true },
]) {
  test(`uncertain creation/confirmation requires review and never retries or deletes ${JSON.stringify(options)}`, async () => {
    const fixture = setup(options);
    const result = await fixture.action(idle, form());
    assert.equal(result.status, "review_required");
    assert.equal(result.teamUrl, `/teams/${newTeamId}`);
    assert.equal(writes(fixture).length, 1);
    assert.deepEqual(await fixture.action(result, form()), result);
    assert.equal(writes(fixture).length, 1);
  });
}
async function dashboard(fixture) {
  const page = loadTs("src/app/page.tsx", fixture.mocks).default;
  return renderToStaticMarkup(await page());
}
for (const options of [{ zeroTeams: true }, { existingRole: "athlete" }, { existingRole: "coach" }, { existingRole: "assistant_coach" }]) {
  test(`dashboard always offers Create Team ${JSON.stringify(options)}`, async () => {
    const fixture = setup(options);
    const markup = await dashboard(fixture);
    assert.ok(markup.includes('href="/teams/new"') && markup.includes("Create Team"));
    if (options.zeroTeams) assert.ok(markup.includes("not currently a member"));
    else assert.ok(markup.includes("Original team"));
  });
}
test("new team appears through normal dashboard membership query and existing coach dashboard works", async () => {
  const fixture = setup();
  await assert.rejects(fixture.action(idle, form()), /REDIRECT:/);
  const markup = await dashboard(fixture);
  assert.ok(markup.includes("JV Lacrosse") && markup.includes(`href="/teams/${newTeamId}"`));
  assert.ok(markup.includes("Original team") && markup.includes('href="/#athlete-training"'));
  const page = loadTs("src/app/teams/[teamId]/page.tsx", fixture.mocks).default;
  const teamMarkup = renderToStaticMarkup(await page({ params: Promise.resolve({ teamId: newTeamId }) }));
  assert.ok(teamMarkup.includes("JV Lacrosse"));
  for (const destination of ["groups", "plans", "assign"]) assert.ok(teamMarkup.includes(`/teams/${newTeamId}/${destination}`));
});
test("team creation page redirects unauthenticated users", async () => {
  const fixture = setup({ signedOut: true });
  const page = loadTs("src/app/teams/new/page.tsx", { ...fixture.mocks, "./team-form": { default: () => null } }).default;
  await assert.rejects(page(), /REDIRECT:\/login/);
});
test("authenticated athlete can open creation page without a global coach role", async () => {
  const fixture = setup();
  const page = loadTs("src/app/teams/new/page.tsx", { ...fixture.mocks, "./team-form": { default: () => React.createElement("span", null, "Team form") } }).default;
  assert.ok(renderToStaticMarkup(await page()).includes("Team form"));
});
function find(node, type) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) return node.map((child) => find(child, type)).find(Boolean) ?? null;
  return node.type === type ? node : find(node.props?.children, type);
}
for (const [state, pending] of [[idle, true], [{ status: "review_required", message: "Review team", teamUrl: `/teams/${newTeamId}` }, false], [{ status: "error", message: "Name required" }, false]]) {
  test(`form shows errors/review and disables pending or uncertain submission ${state.status}/${pending}`, () => {
    const fixture = setup();
    const component = loadTs("src/app/teams/new/team-form.tsx", {
      ...fixture.mocks, "./actions": { createTeam: fixture.action }, react: { ...React, useActionState: () => [state, () => {}, pending] },
    }).default;
    const tree = component();
    assert.equal(find(tree, "button").props.disabled, pending || state.status === "review_required");
    assert.equal(find(tree, "fieldset").props.disabled, pending || state.status === "review_required");
    assert.equal(find(tree, "input").props.maxLength, 100);
    if (state.message) assert.equal(find(tree, "p").props.role, "alert");
    if (state.status === "review_required") assert.ok(renderToStaticMarkup(tree).includes(`href="/teams/${newTeamId}"`));
  });
}
