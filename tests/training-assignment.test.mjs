import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Exercise the actual TS modules with a session-scoped mock; never connect to Supabase.
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

const helper = loadTs("src/lib/training-assignment.ts");
const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const teamId = id(1), planId = id(2), coachId = id(3);
const athleteA = id(4), athleteB = id(5), athleteC = id(6);
const groupA = id(7), groupB = id(8), otherTeam = id(9);
const idle = { status: "idle", message: "" };

function form({ individuals = [athleteA], groups = [], plan = planId, date = "2026-09-14" } = {}) {
  const data = new FormData();
  data.set("trainingPlanId", plan);
  data.set("startDate", date);
  data.set("notes", "  Practice off hand  ");
  individuals.forEach((value) => data.append("athleteIds", value));
  groups.forEach((value) => data.append("groupIds", value));
  return data;
}

function setup(options = {}) {
  const calls = [], revalidated = [], reviews = [];
  const tables = {
    teams: [{ id: teamId, name: "Test team" }],
    team_memberships: [
      { id: id(10), team_id: teamId, user_id: coachId, role: options.role ?? "coach" },
      ...[athleteA, athleteB, athleteC].map((user_id, index) => ({
        id: id(11 + index), team_id: teamId, user_id, role: "athlete",
        profiles: { full_name: `Athlete ${index + 1}` },
      })),
    ],
    training_plans: [{ id: planId, team_id: options.planTeam === undefined ? teamId : options.planTeam, status: options.planStatus ?? "active", name: "Test plan", description: null }],
    team_groups: [{ id: groupA, team_id: teamId, name: "Group A" }, { id: groupB, team_id: teamId, name: "Group B" }],
    team_group_memberships: [
      { id: id(20), team_group_id: groupA, athlete_user_id: athleteA },
      { id: id(21), team_group_id: groupA, athlete_user_id: athleteB },
      { id: id(22), team_group_id: groupB, athlete_user_id: athleteB },
      { id: id(23), team_group_id: groupB, athlete_user_id: athleteC },
      { id: id(24), team_group_id: groupB, athlete_user_id: id(999) },
    ],
  };
  if (options.emptyRoster) tables.team_memberships = tables.team_memberships.slice(0, 1);
  if (options.emptyGroups) { tables.team_groups = []; tables.team_group_memberships = []; }
  if (options.emptyPlans) tables.training_plans = [];
  if (options.missingMembership) tables.team_memberships = tables.team_memberships.filter((row) => row.user_id !== coachId);
  const client = {
    auth: { getUser: async () => ({ data: { user: options.signedOut ? null : { id: coachId } }, error: null }) },
    from(table) {
      const filters = [], orders = [];
      let operation = "read", payload, single = false, start = 0, end = Infinity, orFilter;
      const query = {
        select() { return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        in(key, value) { filters.push([key, value]); return query; },
        or(value) { orFilter = value; return query; },
        order(key) { orders.push(key); return query; },
        range(from, to) { start = from; end = to; return query; },
        single() { single = true; return query; },
        insert(value) { operation = "insert"; payload = value; return query; },
        delete() { operation = "delete"; return query; },
        then(resolve, reject) {
          calls.push({ table, operation, payload, filters, start, end });
          if (options.throwOn === `${table}:${operation}`) return Promise.reject(Error("connection lost")).then(resolve, reject);
          if (options.readError === table && operation === "read") return Promise.resolve({ data: null, error: { message: "denied" }, status: 403 }).then(resolve, reject);
          if (operation === "insert") {
            const failure = table === "training_assignment_batches" ? options.batchFailure : options.assignmentFailure;
            return Promise.resolve({ data: null, error: failure !== undefined ? { message: "rejected" } : null, status: failure ?? 201 }).then(resolve, reject);
          }
          if (operation === "delete") {
            return Promise.resolve({ data: options.cleanupDenied ? [] : [{ id: filters[0][1] }], error: options.cleanupError ? { message: "denied" } : null, status: 200 }).then(resolve, reject);
          }
          let rows = (tables[table] ?? []).filter((row) => filters.every(([key, value]) => Array.isArray(value) ? value.includes(row[key]) : row[key] === value));
          if (orFilter) rows = rows.filter((row) => row.team_id === teamId || row.team_id === null);
          rows.sort((a, b) => {
            for (const key of orders) { const diff = String(a[key]).localeCompare(String(b[key])); if (diff) return diff; }
            return 0;
          });
          rows = rows.slice(start, Math.min(end + 1, start + (options.apiCap ?? Infinity)));
          return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null, status: 200 }).then(resolve, reject);
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
  // Capture review metadata without noisy logs or any external data.
  const actionModuleSource = ts.transpileModule(readFileSync(root + "src/app/teams/[teamId]/assign/actions.ts", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const actionModule = { exports: {} };
  const run = new vm.Script(`(function(require, module, exports, console) {${actionModuleSource}\n})`).runInThisContext();
  run((name) => name in mocks ? mocks[name] : require(name), actionModule, actionModule.exports, { error: (...values) => reviews.push(values) });
  return { action: actionModule.exports.assignTraining, calls, revalidated, reviews, mocks };
}

const writes = (fixture) => fixture.calls.filter((call) => call.operation !== "read");

test("recipient resolution deduplicates overlap and excludes non-roster members", () => {
  assert.deepEqual(helper.resolveRecipientIds([athleteA, athleteA], [athleteA, athleteB, athleteB, id(999)], [athleteA, athleteB]), [athleteA, athleteB]);
});

test("strict date validation rejects impossible dates", () => {
  for (const date of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-9-14", "0000-01-01", "invalid"]) assert.equal(helper.isDate(date), false, date);
  assert.equal(helper.isDate("2028-02-29"), true);
});

test("pagination continues through a short API-capped page and propagates failures", async () => {
  const values = [1, 2, 3, 4, 5];
  const rows = await helper.readAllRows((from) => Promise.resolve({ data: values.slice(from, from + 2), error: null }));
  assert.deepEqual(rows, values);
  await assert.rejects(helper.readAllRows(() => Promise.resolve({ data: null, error: { message: "denied" } })));
});

for (const [name, individuals, groups, expected] of [
  ["single athlete", [athleteA], [], [athleteA]],
  ["multiple athletes", [athleteA, athleteB], [], [athleteA, athleteB]],
  ["single group", [], [groupA], [athleteA, athleteB]],
  ["overlapping groups", [], [groupA, groupB], [athleteA, athleteB, athleteC]],
  ["mixed and repeated selections", [athleteA, athleteA], [groupA, groupA, groupB], [athleteA, athleteB, athleteC]],
]) {
  test(`assigns ${name} with one batch and one canonical row per recipient`, async () => {
    const fixture = setup({ apiCap: 2 });
    const state = await fixture.action(teamId, idle, form({ individuals, groups }));
    assert.equal(state.status, "success");
    assert.equal(state.recipientCount, expected.length);
    const [batchCall, assignmentCall] = writes(fixture);
    assert.equal(writes(fixture).length, 2);
    assert.equal(batchCall.table, "training_assignment_batches");
    assert.deepEqual(batchCall.payload.selection_snapshot, {
      selected_individual_athlete_ids: [...new Set(individuals)],
      selected_group_ids: [...new Set(groups)],
      resolved_unique_athlete_ids: expected,
    });
    assert.deepEqual(assignmentCall.payload, expected.map((athleteId) => ({
      training_plan_id: planId, team_id: teamId, athlete_user_id: athleteId,
      assigned_by_user_id: coachId, start_date: "2026-09-14", status: "active",
      notes: "Practice off hand", assignment_batch_id: batchCall.payload.id,
    })));
    assert.deepEqual(fixture.revalidated, [`/teams/${teamId}`, `/teams/${teamId}/assign`, "/"]);
    assert.ok(!fixture.calls.some((call) => call.table === "training_sessions"));
  });
}

for (const [name, options, input] of [
  ["signed out", { signedOut: true }, {}],
  ["athlete role", { role: "athlete" }, {}],
  ["not a member", { missingMembership: true }, {}],
  ["other team's plan", { planTeam: otherTeam }, {}],
  ["draft plan", { planStatus: "draft" }, {}],
  ["archived plan", { planStatus: "archived" }, {}],
  ["missing plan", { emptyPlans: true }, {}],
  ["other team's group", {}, { individuals: [], groups: [id(999)] }],
  ["non-roster individual", {}, { individuals: [id(999)] }],
  ["coach selected as athlete", {}, { individuals: [coachId] }],
  ["empty selection", {}, { individuals: [], groups: [] }],
  ["empty eligible group", { emptyRoster: true }, { individuals: [], groups: [groupA] }],
  ["invalid date", {}, { date: "2026-02-30" }],
  ["malformed recipient", {}, { individuals: ["bad-id"] }],
  ["roster query failure", { readError: "team_memberships" }, {}],
  ["group query failure", { readError: "team_groups" }, { groups: [groupA] }],
  ["group members query failure", { readError: "team_group_memberships" }, { groups: [groupA] }],
]) {
  test(`rejects ${name} before any writes`, async () => {
    const fixture = setup(options);
    assert.equal((await fixture.action(teamId, idle, form(input))).status, "error");
    assert.equal(writes(fixture).length, 0);
    assert.equal(fixture.revalidated.length, 0);
  });
}

test("assistant coach can assign an RLS-visible active shared plan without groups", async () => {
  const fixture = setup({ role: "assistant_coach", planTeam: null, emptyGroups: true });
  assert.equal((await fixture.action(teamId, idle, form())).status, "success");
});

test("server resolves current membership rather than trusting a client recipient list", async () => {
  const fixture = setup();
  const data = form({ individuals: [], groups: [groupA] });
  data.set("resolvedAthleteIds", id(999));
  data.set("assigned_by_user_id", id(999));
  const state = await fixture.action(teamId, idle, data);
  assert.equal(state.recipientCount, 2);
  assert.ok(writes(fixture)[1].payload.every((row) => row.assigned_by_user_id === coachId));
});

test("definite batch rejection never inserts assignments", async () => {
  const fixture = setup({ batchFailure: 403 });
  assert.equal((await fixture.action(teamId, idle, form())).status, "error");
  assert.equal(writes(fixture).length, 1);
});

test("definite bulk rejection removes only the new empty batch and never reports success", async () => {
  const fixture = setup({ assignmentFailure: 400 });
  const state = await fixture.action(teamId, idle, form({ groups: [groupA] }));
  assert.equal(state.status, "error");
  const [batch, assignments, cleanup] = writes(fixture);
  assert.equal(assignments.payload.length, 2);
  assert.equal(cleanup.operation, "delete");
  assert.equal(cleanup.table, "training_assignment_batches");
  assert.deepEqual(cleanup.filters, [["id", batch.payload.id], ["team_id", teamId], ["assigned_by_user_id", coachId]]);
  assert.equal(fixture.revalidated.length, 0);
});

for (const options of [
  { batchFailure: 0 }, { batchFailure: 503 }, { assignmentFailure: 0 },
  { assignmentFailure: 503 }, { assignmentFailure: 408 },
  { throwOn: "training_plan_assignments:insert" },
]) {
  test(`uncertain write ${JSON.stringify(options)} requires review and never deletes`, async () => {
    const fixture = setup(options);
    const state = await fixture.action(teamId, idle, form());
    assert.equal(state.status, "review_required");
    assert.ok(!writes(fixture).some((call) => call.operation === "delete"));
    assert.equal(fixture.revalidated.length, 0);
    assert.equal(fixture.reviews.length, 1);
    assert.ok(!state.message.includes(teamId));
    assert.ok(!state.message.includes(fixture.reviews[0][1].batchId));
    const count = writes(fixture).length;
    assert.equal((await fixture.action(teamId, state, form())).status, "review_required");
    assert.equal(writes(fixture).length, count);
  });
}

for (const options of [{ cleanupDenied: true }, { cleanupError: true }]) {
  test(`unconfirmed cleanup ${JSON.stringify(options)} requires review`, async () => {
    const fixture = setup({ assignmentFailure: 400, ...options });
    assert.equal((await fixture.action(teamId, idle, form())).status, "review_required");
    assert.equal(fixture.revalidated.length, 0);
  });
}

test("successful action state cannot resubmit the same form", async () => {
  const fixture = setup();
  const state = await fixture.action(teamId, idle, form());
  assert.equal((await fixture.action(teamId, state, form())).status, "success");
  assert.equal(writes(fixture).length, 2);
});

function findComponent(node, component) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) return node.map((child) => findComponent(child, component)).find(Boolean) ?? null;
  return node.type === component ? node : findComponent(node.props?.children, component);
}

test("page loads active available plans and deduplicated group counts with capped pagination", async () => {
  const fixture = setup({ apiCap: 2 });
  const Form = () => null;
  const page = loadTs("src/app/teams/[teamId]/assign/page.tsx", {
    ...fixture.mocks,
    "./assignment-form": { default: Form },
    "next/link": { default: () => null },
    "next/navigation": { redirect: () => { throw Error("redirect"); }, notFound: () => { throw Error("404"); } },
  }).default;
  const tree = await page({ params: Promise.resolve({ teamId }) });
  const formNode = findComponent(tree, Form);
  assert.equal(formNode.props.plans.length, 1);
  assert.equal(formNode.props.athletes.length, 3);
  assert.deepEqual(formNode.props.groups.map((group) => group.athleteIds), [[athleteA, athleteB], [athleteB, athleteC]]);
  assert.ok(helper.isDate(formNode.props.defaultStartDate));
});

test("page does not render an assignment form after a recipient loading failure", async () => {
  const fixture = setup({ readError: "team_group_memberships" });
  const Form = () => null;
  const page = loadTs("src/app/teams/[teamId]/assign/page.tsx", {
    ...fixture.mocks, "./assignment-form": { default: Form }, "next/link": { default: () => null },
    "next/navigation": { redirect: () => { throw Error("redirect"); }, notFound: () => { throw Error("404"); } },
  }).default;
  const tree = await page({ params: Promise.resolve({ teamId }) });
  assert.equal(findComponent(tree, Form), null);
});

function uiFixture({ groups = true, plans = true, state = idle, pending = false } = {}) {
  const values = [];
  let cursor;
  const component = loadTs("src/app/teams/[teamId]/assign/assignment-form.tsx", {
    react: {
      ...React,
      useState(initial) {
        const index = cursor++;
        if (!(index in values)) values[index] = initial;
        return [values[index], (value) => { values[index] = value; }];
      },
      useActionState: () => [state, () => {}, pending],
    },
    "next/link": { default: (props) => React.createElement("a", props) },
    "@/lib/training-assignment": helper,
    "./actions": { assignTraining: async () => idle },
  }).default;
  const props = {
    teamId,
    plans: plans ? [{ id: planId, name: "Test plan", description: null }] : [],
    groups: groups ? [
      { id: groupA, name: "Group A", athleteIds: [athleteA, athleteB] },
      { id: groupB, name: "Group B", athleteIds: [athleteB, athleteC] },
    ] : [],
    athletes: [athleteA, athleteB, athleteC].map((id, index) => ({ id, name: `Athlete ${index + 1}` })),
    defaultStartDate: "2026-09-14",
  };
  return {
    render() { cursor = 0; return component(props); },
  };
}

function findNode(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) return node.map((child) => findNode(child, predicate)).find(Boolean) ?? null;
  return predicate(node) ? node : findNode(node.props?.children, predicate);
}

test("interactive overlap selections show named unique recipients and enable valid submission", () => {
  const fixture = uiFixture();
  const button = (tree) => findNode(tree, (node) => node.type === "button");
  assert.equal(button(fixture.render()).props.disabled, true);
  findNode(fixture.render(), (node) => node.type === "select").props.onChange({ target: { value: planId } });
  for (const group of [groupA, groupB]) {
    findNode(fixture.render(), (node) => node.type === "input" && node.props.value === group).props.onChange();
  }
  findNode(fixture.render(), (node) => node.type === "input" && node.props.value === athleteB).props.onChange();
  const tree = fixture.render();
  assert.equal(button(tree).props.disabled, false);
  const text = renderToStaticMarkup(tree).replace(/<[^>]*>/g, "");
  assert.ok(text.includes("3 unique athletes will receive training"));
  assert.ok(text.includes("Included through a selected group"));
  assert.ok(!/00000000-0000/.test(text));
  const recipients = findNode(tree, (node) => node.props["aria-label"] === "Selected recipients");
  assert.equal(recipients.props.children.length, 3);
  findNode(tree, (node) => node.type === "input" && node.props.value === groupB).props.onChange();
  assert.ok(renderToStaticMarkup(fixture.render()).includes("2 unique"));
});

test("no groups still permits individual assignment and no plans disables submission", () => {
  const fixture = uiFixture({ groups: false });
  findNode(fixture.render(), (node) => node.type === "select").props.onChange({ target: { value: planId } });
  findNode(fixture.render(), (node) => node.type === "input" && node.props.value === athleteA).props.onChange();
  const tree = fixture.render();
  assert.equal(findNode(tree, (node) => node.type === "button").props.disabled, false);
  assert.ok(renderToStaticMarkup(tree).includes("No groups have been created"));
  const noPlans = uiFixture({ plans: false }).render();
  assert.equal(findNode(noPlans, (node) => node.type === "button").props.disabled, true);
  assert.ok(renderToStaticMarkup(noPlans).includes("No active training plans"));
});

test("pending and review-required forms cannot submit; success replaces the form", () => {
  for (const options of [{ pending: true }, { state: { status: "review_required", message: "Ask for review." } }]) {
    const tree = uiFixture(options).render();
    assert.equal(findNode(tree, (node) => node.type === "fieldset").props.disabled, true);
    assert.equal(findNode(tree, (node) => node.type === "button").props.disabled, true);
  }
  const success = uiFixture({ state: { status: "success", message: "Training assigned to 3 athletes." } }).render();
  assert.equal(findNode(success, (node) => node.type === "form"), null);
  assert.ok(renderToStaticMarkup(success).includes("Training assigned to 3 athletes."));
});
