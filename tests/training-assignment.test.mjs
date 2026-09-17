import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as React from "react";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
function loadTs(path, mocks = {}) {
  const source = ts.transpileModule(readFileSync(root + path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loadedModule = { exports: {} };
  const run = new vm.Script(`(function(require,module,exports){${source}\n})`).runInThisContext();
  run((name) => name in mocks ? mocks[name] : require(name), loadedModule, loadedModule.exports);
  return loadedModule.exports;
}

const helper = loadTs("src/lib/training-assignment.ts");
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const teamId = id(1), planId = id(2), coachId = id(3);
const athleteA = id(4), athleteB = id(5), athleteC = id(6), childAthlete = id(7);
const groupA = id(8), groupB = id(9), requestId = id(10);
const idle = { status: "idle", message: "" };

function form({ individuals = [athleteA], groups = [], request = requestId, date = "2026-09-14", notes = "  Practice off hand  " } = {}) {
  const data = new FormData();
  data.set("assignmentRequestId", request);
  data.set("trainingPlanId", planId);
  data.set("startDate", date);
  data.set("notes", notes);
  individuals.forEach((value) => data.append("athleteIds", value));
  groups.forEach((value) => data.append("groupIds", value));
  return data;
}

function setup(options = {}) {
  const calls = [], revalidated = [], logs = [];
  const tables = {
    teams: [{ id: teamId, name: "Test team" }],
    team_memberships: [{ team_id: teamId, user_id: coachId, role: options.role ?? "coach" },
      ...[athleteA, athleteB, athleteC].map((user_id, i) => ({ team_id: teamId, user_id, role: "athlete", profiles: { full_name: `Athlete ${i + 1}` } }))],
    team_athlete_memberships: [athleteA, athleteB, athleteC, ...(options.includeChild ? [childAthlete] : [])].map((athlete_id, i) => ({
      team_id: teamId,
      athlete_id,
      athletes: { id: athlete_id, display_name: athlete_id === childAthlete ? "Child Athlete" : `Athlete ${i + 1}`, graduation_year: null, status: options.archivedAthlete === athlete_id ? "archived" : "active" },
    })),
    training_plans: [{ id: planId, owner_user_id: coachId, kind: "coach", visibility: "private", status: "active", name: "Test plan", description: null }],
    team_groups: [{ id: groupA, team_id: teamId, name: "Group A" }, { id: groupB, team_id: teamId, name: "Group B" }],
    team_group_memberships: [
      { team_group_id: groupA, athlete_user_id: athleteA }, { team_group_id: groupA, athlete_user_id: athleteB },
      { team_group_id: groupB, athlete_user_id: athleteB }, { team_group_id: groupB, athlete_user_id: athleteC },
      { team_group_id: groupB, athlete_user_id: id(999) },
    ],
  };
  if (options.emptyGroups) { tables.team_groups = []; tables.team_group_memberships = []; }
  if (options.emptyRoster) tables.team_athlete_memberships = [];
  if (options.readError) tables[options.readError] = null;
  const client = {
    auth: { getUser: async () => ({ data: { user: options.signedOut ? null : { id: coachId } }, error: null }) },
    rpc(name, payload) {
      calls.push({ kind: "rpc", name, payload });
      if (options.rpcThrow) return Promise.reject(Error("connection lost"));
      if (name === "list_my_team_rostered_athlete_identities") {
        if (options.readerError) return Promise.resolve({ data: null, error: { message: "denied" } });
        return Promise.resolve({ data: tables.team_athlete_memberships.map((membership) => ({
          athlete_id: membership.athlete_id,
          display_name: membership.athletes.display_name,
          graduation_year: membership.athletes.graduation_year,
          status: membership.athletes.status,
        })), error: null });
      }
      const message = options.rpcError;
      return Promise.resolve({ data: message ? null : [{ batch_id: payload.p_batch_id, recipient_count: options.recipientCount ?? payload.p_athlete_ids.length }], error: message ? { message, code: "P0001" } : null });
    },
    from(table) {
      const filters = []; let start = 0; let end = Infinity; let single = false;
      const query = {
        select() { return query; }, eq(key, value) { filters.push([key, value]); return query; }, in(key, value) { filters.push([key, value]); return query; },
        order() { return query; }, range(from, to) { start = from; end = to; return query; }, single() { single = true; return query; },
        then(resolve, reject) {
          calls.push({ kind: "read", table, filters, start, end });
          if (tables[table] === null) return Promise.resolve({ data: null, error: { message: "denied" } }).then(resolve, reject);
          let rows = (tables[table] ?? []).filter((row) => filters.every(([key, value]) => Array.isArray(value) ? value.includes(row[key]) : row[key] === value));
          rows = rows.slice(start, end + 1);
          return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const mocks = {
    "@/lib/supabase/server": { createClient: async () => client },
    "@/lib/training-assignment": helper,
    "next/cache": { revalidatePath: (path) => revalidated.push(path) },
  };
  const source = ts.transpileModule(readFileSync(root + "src/app/teams/[teamId]/assign/actions.ts", "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS } }).outputText;
  const actionModule = { exports: {} };
  const run = new vm.Script(`(function(require,module,exports,console){${source}\n})`).runInThisContext();
  run((name) => name in mocks ? mocks[name] : require(name), actionModule, actionModule.exports, { error: (...args) => logs.push(args) });
  return { action: actionModule.exports.assignTraining, calls, revalidated, logs, tables, mocks };
}

function rpcCall(fixture) { return fixture.calls.find((call) => call.kind === "rpc"); }

test("recipient resolution remains roster-scoped and deterministic", () => {
  assert.deepEqual(helper.resolveRecipientIds([athleteB, athleteA], [athleteA, athleteC, id(999)], [athleteA, athleteB, athleteC]), [athleteA, athleteB, athleteC]);
});

test("individual assignment uses one canonical RPC with durable athlete IDs", async () => {
  const fixture = setup();
  const state = await fixture.action(teamId, idle, form());
  assert.equal(state.status, "success");
  assert.deepEqual(rpcCall(fixture), { kind: "rpc", name: "assign_my_team_training", payload: {
    p_batch_id: requestId, p_team_id: teamId, p_training_plan_id: planId,
    p_start_date: "2026-09-14", p_notes: "Practice off hand", p_athlete_ids: [athleteA],
  }});
  assert.ok(!fixture.calls.some((call) => call.table === "training_assignment_batches" || call.table === "training_plan_assignments"));
  assert.ok(!Object.hasOwn(rpcCall(fixture).payload, "assigned_by_user_id"));
  assert.ok(!Object.hasOwn(rpcCall(fixture).payload, "athlete_user_id"));
  assert.deepEqual(fixture.revalidated, [`/teams/${teamId}`, `/teams/${teamId}/assign`, "/"]);
});

for (const [name, input, expected] of [
  ["group", { individuals: [], groups: [groupA] }, [athleteA, athleteB]],
  ["mixed overlapping group and individual", { individuals: [athleteA, athleteB], groups: [groupA, groupB] }, [athleteA, athleteB, athleteC]],
]) {
  test(`${name} assignment calls the RPC once with deduplicated durable recipients`, async () => {
    const fixture = setup();
    const state = await fixture.action(teamId, idle, form(input));
    assert.equal(state.status, "success");
    assert.equal(fixture.calls.filter((call) => call.kind === "rpc").length, 1);
    assert.deepEqual(rpcCall(fixture).payload.p_athlete_ids, expected);
  });
}

test("a durable athlete without an auth-user identity is not rejected by the application", async () => {
  const fixture = setup({ includeChild: true });
  const state = await fixture.action(teamId, idle, form({ individuals: [childAthlete] }));
  assert.equal(state.status, "success");
  assert.deepEqual(rpcCall(fixture).payload.p_athlete_ids, [childAthlete]);
});

test("server recomputes group recipients and ignores client actor or compatibility fields", async () => {
  const fixture = setup(); const data = form({ individuals: [], groups: [groupA] });
  data.set("resolvedAthleteIds", id(999)); data.set("assigned_by_user_id", id(999)); data.set("athlete_user_id", id(999));
  await fixture.action(teamId, idle, data);
  assert.deepEqual(rpcCall(fixture).payload.p_athlete_ids, [athleteA, athleteB]);
  assert.equal(JSON.stringify(rpcCall(fixture).payload).includes(id(999)), false);
});

for (const [name, options, expected] of [
  ["unauthorized recipient", { rpcError: "Recipient is not authorized for this team assignment" }, "error"],
  ["idempotency conflict", { rpcError: "Assignment idempotency conflict" }, "error"],
  ["integrity failure", { rpcError: "Assignment idempotency integrity failure" }, "review_required"],
  ["uncertain transport failure", { rpcThrow: true }, "error"],
]) {
  test(`${name} returns a safe state without direct writes`, async () => {
    const fixture = setup(options);
    const state = await fixture.action(teamId, idle, form());
    assert.equal(state.status, expected);
    assert.ok(!state.message.includes("P0001"));
    assert.equal(fixture.calls.filter((call) => call.kind === "rpc").length, 1);
    assert.equal(fixture.revalidated.length, 0);
  });
}

test("uncertain failure retains the same request id for a manual retry and never auto-retries", async () => {
  const fixture = setup({ rpcThrow: true }); const data = form();
  await fixture.action(teamId, idle, data);
  assert.equal(fixture.calls.filter((call) => call.kind === "rpc").length, 1);
  await fixture.action(teamId, { status: "error", message: "retry" }, data);
  assert.equal(fixture.calls.filter((call) => call.kind === "rpc").length, 2);
  assert.ok(fixture.calls.filter((call) => call.kind === "rpc").every((call) => call.payload.p_batch_id === requestId));
});

for (const [name, options, input] of [
  ["signed out", { signedOut: true }, {}], ["non-roster durable athlete", {}, { individuals: [id(999)] }],
  ["invalid request id", {}, { request: "invalid" }], ["invalid date", {}, { date: "2026-02-30" }],
  ["group lookup failure", { readError: "team_groups" }, { individuals: [], groups: [groupA] }],
]) test(`${name} is rejected before RPC`, async () => {
  const fixture = setup(options); const state = await fixture.action(teamId, idle, form(input));
  assert.equal(state.status, "error"); assert.equal(fixture.calls.filter((call) => call.kind === "rpc").length, 0);
});

test("page emits durable athlete IDs and durable names while preserving legacy group display", async () => {
  const fixture = setup(); const Form = () => null;
  const page = loadTs("src/app/teams/[teamId]/assign/page.tsx", {
    ...fixture.mocks, "./assignment-form": { default: Form }, "next/link": { default: () => null },
    "next/navigation": { redirect: () => { throw Error("redirect"); }, notFound: () => { throw Error("not found"); } },
  }).default;
  const tree = await page({ params: Promise.resolve({ teamId }) });
  const find = (node) => !node || typeof node !== "object" ? null : node.type === Form ? node : Array.isArray(node) ? node.map(find).find(Boolean) : find(node.props?.children);
  const formNode = find(tree);
  assert.deepEqual(formNode.props.athletes.map((athlete) => athlete.athleteId), [athleteA, athleteB, athleteC]);
  assert.deepEqual(formNode.props.groups.map((group) => group.athleteIds), [[athleteA, athleteB], [athleteB, athleteC]]);
  assert.deepEqual(fixture.calls.find((call) => call.kind === "rpc" && call.name === "list_my_team_rostered_athlete_identities"), {
    kind: "rpc", name: "list_my_team_rostered_athlete_identities", payload: { p_team_id: teamId },
  });
});

test("assignment reader supports a no-auth child for staff and excludes archived athletes", async () => {
  const fixture = setup({ includeChild: true, archivedAthlete: athleteC, role: "assistant_coach" }); const Form = () => null;
  const page = loadTs("src/app/teams/[teamId]/assign/page.tsx", {
    ...fixture.mocks, "./assignment-form": { default: Form }, "next/link": { default: () => null },
    "next/navigation": { redirect: () => { throw Error("redirect"); }, notFound: () => { throw Error("not found"); } },
  }).default;
  const tree = await page({ params: Promise.resolve({ teamId }) });
  const find = (node) => !node || typeof node !== "object" ? null : node.type === Form ? node : Array.isArray(node) ? node.map(find).find(Boolean) : find(node.props?.children);
  const formNode = find(tree);
  assert.deepEqual(formNode.props.athletes.map((athlete) => athlete.athleteId), [athleteA, athleteB, childAthlete]);
  assert.ok(!formNode.props.athletes.some((athlete) => athlete.athleteId === coachId));
});

test("form holds a stable hidden request UUID and uses athleteId semantics", () => {
  const values = []; let cursor = 0;
  const Form = loadTs("src/app/teams/[teamId]/assign/assignment-form.tsx", {
    react: { ...React, useState(initial) { const i = cursor++; if (!(i in values)) values[i] = typeof initial === "function" ? initial() : initial; return [values[i], (v) => { values[i] = v; }]; }, useActionState: () => [idle, () => {}, false] },
    "next/link": { default: (props) => React.createElement("a", props) }, "@/lib/training-assignment": helper, "./actions": { assignTraining: async () => idle },
  }).default;
  const props = { teamId, plans: [{ id: planId, name: "Test", description: null }], groups: [], athletes: [{ athleteId: athleteA, name: "Athlete A" }], defaultStartDate: "2026-09-14" };
  const tree = Form(props);
  const find = (node, pred) => !node || typeof node !== "object" ? null : pred(node) ? node : Array.isArray(node) ? node.map((x) => find(x, pred)).find(Boolean) : find(node.props?.children, pred);
  const hidden = find(tree, (node) => node.type === "input" && node.props.name === "assignmentRequestId");
  assert.match(hidden.props.value, /^[0-9a-f-]{36}$/i);
  assert.equal(find(tree, (node) => node.type === "input" && node.props.name === "athleteIds").props.value, athleteA);
});
