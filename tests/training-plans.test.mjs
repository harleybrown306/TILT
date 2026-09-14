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
function loadTs(path, mocks = {}) {
  const source = ts.transpileModule(readFileSync(root + path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loadedModule = { exports: {} };
  const run = new vm.Script(`(function(require, module, exports) {${source}\n})`).runInThisContext();
  run((name) => name in mocks ? mocks[name] : require(name), loadedModule, loadedModule.exports);
  return loadedModule.exports;
}
const assignment = loadTs("src/lib/training-assignment.ts");
const logic = loadTs("src/lib/training-plans.ts");
const id = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const teamId = id(1), coachId = id(2), planId = id(3), workoutId = id(4), itemId = id(5);
const version = "2026-09-14T12:00:00+00:00";
const idle = { status: "idle", message: "" };
function form(operation, fields = {}) {
  const data = new FormData();
  const defaults = { operation, planVersion: version, scheduleVersion: logic.scheduleVersion([{ id: itemId, updated_at: version }]), dayNumber: "2", orderNumber: "1", workoutId, itemId, itemVersion: version, name: "New name", description: "Description", scheduledTime: "09:30", notes: "Notes" };
  for (const [key, value] of Object.entries({ ...defaults, ...fields })) data.set(key, value);
  return data;
}

function setup(options = {}) {
  const calls = [], invalidations = [];
  const tables = {
    team_memberships: [{ team_id: teamId, user_id: coachId, role: options.role ?? "coach" }],
    training_plans: [{ id: planId, team_id: options.planTeam ?? teamId, owner_user_id: id(20), name: "Test plan", description: "Description", status: options.status ?? "draft", created_at: version, updated_at: version }],
    training_plan_items: options.empty ? [] : [{ id: itemId, training_plan_id: planId, workout_id: workoutId, day_offset: 0, position: 0, scheduled_time: null, notes: null, updated_at: version }],
    workouts: options.inaccessible ? [] : [{ id: workoutId, name: "Workout", description: "Practice", difficulty: "beginner", visibility: "team", team_id: teamId, owner_user_id: coachId, requires_entitlement: options.gated ? "premium_workouts" : null }],
    user_entitlements: options.entitled ? [{ id: id(30), user_id: coachId, plan_id: id(31), status: "active", starts_at: "2020-01-01T00:00:00Z", ends_at: options.expired ? "2020-02-01T00:00:00Z" : null }] : [],
    entitlement_plan_features: [{ id: id(32), plan_id: id(31), feature_key: "premium_workouts", enabled: !options.featureDisabled }],
  };
  let nextId = 100;
  const client = {
    auth: { getUser: async () => ({ data: { user: options.signedOut ? null : { id: coachId } }, error: null }) },
    from(table) {
      const filters = [];
      let operation = "read", payload, single = false, start = 0, end = Infinity;
      const query = {
        select() { return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        in(key, values) { filters.push([key, values]); return query; },
        order() { return query; },
        range(from, to) { start = from; end = to; return query; },
        single() { single = true; return query; },
        insert(value) { operation = "insert"; payload = value; return query; },
        update(value) { operation = "update"; payload = value; return query; },
        delete() { operation = "delete"; return query; },
        then(resolve, reject) {
          calls.push({ table, operation, filters, payload });
          if (options.deniedWrite && operation !== "read") return Promise.resolve({ data: [], error: { message: "RLS rejected" } }).then(resolve, reject);
          if (options.readError === table && operation === "read") return Promise.resolve({ data: null, error: { message: "RLS rejected" } }).then(resolve, reject);
          if (options.race && table === "training_plans" && operation === "update") tables.training_plans[0].status = "active";
          const matches = (row) => filters.every(([key, value]) => Array.isArray(value) ? value.includes(row[key]) : row[key] === value);
          let rows = (tables[table] ?? []).filter(matches);
          if (operation === "insert") {
            const added = { id: id(nextId++), updated_at: version, ...payload };
            tables[table].push(added); rows = [added];
          } else if (operation === "update") {
            rows.forEach((row) => Object.assign(row, payload, { updated_at: "2026-09-14T13:00:00+00:00" }));
          } else if (operation === "delete") {
            tables[table] = tables[table].filter((row) => !matches(row));
          } else { rows = rows.slice(start, Math.min(end + 1, start + 2)); }
          return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const mocks = {
    "server-only": {},
    "@/lib/supabase/server": { createClient: async () => client },
    "@/lib/training-assignment": assignment,
    "@/lib/training-plans": logic,
  };
  const server = loadTs("src/lib/training-plans-server.ts", mocks);
  mocks["@/lib/training-plans-server"] = server;
  const actions = loadTs("src/app/teams/[teamId]/plans/actions.ts", {
    ...mocks,
    "next/cache": { revalidatePath: (path) => invalidations.push(path) },
    "next/navigation": { redirect: (path) => { throw Error(`REDIRECT:${path}`); } },
  });
  return { tables, calls, invalidations, actions, server, mocks };
}
const writes = (fixture) => fixture.calls.filter((call) => call.operation !== "read");

test("human days convert to stored offsets and back", () => {
  for (const [day, offset] of [[1, 0], [2, 1], [7, 6]]) {
    assert.equal(logic.dayNumberToOffset(day), offset);
    assert.equal(logic.offsetToDayNumber(offset), day);
  }
  for (const invalid of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => logic.dayNumberToOffset(invalid));
});
test("only drafts are editable; workout order is day then position", () => {
  assert.equal(logic.isDraft("draft"), true);
  for (const status of ["active", "archived"]) assert.equal(logic.isDraft(status), false);
  const items = [{ id: "c", day_offset: 2, position: 0 }, { id: "b", day_offset: 0, position: 2 }, { id: "a", day_offset: 0, position: 1 }];
  assert.deepEqual(logic.sortPlanItems(items).map((item) => item.id), ["a", "b", "c"]);
  assert.equal(items[0].id, "c");
});
test("schedule validation rejects negative, fractional, missing and out-of-range values", () => {
  for (const fields of [{ dayNumber: "0" }, { dayNumber: "1.5" }, { orderNumber: "-1" }, { orderNumber: "" }, { dayNumber: "2147483648" }, { scheduledTime: "25:00" }]) {
    assert.throws(() => logic.readSchedule(form("save-item", fields)));
  }
  assert.deepEqual(logic.readSchedule(form("save-item")), { day_offset: 1, position: 0, scheduled_time: "09:30", notes: "Notes" });
});
test("workout eligibility keeps visibility and entitlement restrictions", () => {
  const workout = { visibility: "private", owner_user_id: id(99), team_id: teamId, requires_entitlement: null };
  assert.equal(logic.isWorkoutUsable(workout, teamId, coachId, new Set()), false);
  assert.equal(logic.isWorkoutUsable({ ...workout, visibility: "public", requires_entitlement: "premium" }, teamId, coachId, new Set()), false);
  assert.equal(logic.isWorkoutUsable({ ...workout, visibility: "public", requires_entitlement: "premium" }, teamId, coachId, new Set(["premium"])), true);
});
test("creation derives team and owner from the session and starts as draft", async () => {
  const fixture = setup();
  await assert.rejects(fixture.actions.createPlan(teamId, idle, form("create", { team_id: id(99), owner_user_id: id(99), status: "active" })), /REDIRECT:/);
  const payload = writes(fixture)[0].payload;
  assert.equal(payload.team_id, teamId);
  assert.equal(payload.owner_user_id, coachId);
  assert.equal(payload.status, "draft");
  assert.equal(fixture.invalidations.length, 3);
});
test("blank plan names cannot be created", async () => {
  const fixture = setup();
  assert.equal((await fixture.actions.createPlan(teamId, idle, form("create", { name: "  " }))).status, "error");
  assert.equal(writes(fixture).length, 0);
});

for (const [name, options, operation, fields] of [
  ["signed out", { signedOut: true }, "save-plan", {}],
  ["athlete", { role: "athlete" }, "save-plan", {}],
  ["wrong team", { planTeam: id(99) }, "save-plan", {}],
  ["stale plan version", {}, "save-plan", { planVersion: "old" }],
  ["wrong plan item", {}, "save-item", { itemId: id(99) }],
  ["stale item version", {}, "remove-item", { itemVersion: "old" }],
  ["zero day", {}, "save-item", { dayNumber: "0" }],
  ["unknown operation", {}, "delete-plan", {}],
  ["empty activation", { empty: true }, "activate", {}],
  ["stale activation schedule", {}, "activate", { scheduleVersion: "old" }],
  ["inaccessible workout", { inaccessible: true }, "activate", {}],
  ["unentitled workout", { gated: true }, "activate", {}],
  ["expired entitlement", { gated: true, entitled: true, expired: true }, "activate", {}],
  ["disabled entitlement feature", { gated: true, entitled: true, featureDisabled: true }, "activate", {}],
  ["entitlement query failure", { gated: true, readError: "user_entitlements" }, "activate", {}],
  ["active activation", { status: "active" }, "activate", {}],
  ["draft archive", {}, "archive", {}],
  ["archived archive", { status: "archived" }, "archive", {}],
]) {
  test(`rejects ${name} without writes`, async () => {
    const fixture = setup(options);
    const result = await fixture.actions.mutatePlan(teamId, planId, idle, form(operation, fields));
    assert.equal(result.status, "error");
    assert.equal(writes(fixture).length, 0);
  });
}
for (const status of ["active", "archived"]) {
  for (const operation of ["save-plan", "add-item", "save-item", "remove-item"]) {
    test(`${status} plan refuses ${operation}`, async () => {
      const fixture = setup({ status });
      assert.equal((await fixture.actions.mutatePlan(teamId, planId, idle, form(operation))).status, "error");
      assert.equal(writes(fixture).length, 0);
    });
  }
}

test("assistant coach edits team plan details even when another coach owns it", async () => {
  const fixture = setup({ role: "assistant_coach" });
  assert.equal((await fixture.actions.mutatePlan(teamId, planId, idle, form("save-plan"))).status, "success");
  assert.equal(fixture.tables.training_plans[0].name, "New name");
  assert.deepEqual(writes(fixture)[0].filters, [["id", planId], ["team_id", teamId], ["status", "draft"], ["updated_at", version]]);
});
test("draft can add a workout using human day and order numbers", async () => {
  const fixture = setup();
  assert.equal((await fixture.actions.mutatePlan(teamId, planId, idle, form("add-item", { orderNumber: "2", dayNumber: "7" }))).status, "success");
  const item = writes(fixture)[0].payload;
  assert.equal(item.training_plan_id, planId);
  assert.equal(item.workout_id, workoutId);
  assert.equal(item.day_offset, 6);
  assert.equal(item.position, 1);
});
test("duplicate order fails before writes; unused order can be saved without swapping rows", async () => {
  const fixture = setup();
  assert.equal((await fixture.actions.mutatePlan(teamId, planId, idle, form("add-item"))).status, "error");
  assert.equal(writes(fixture).length, 0);
  assert.equal((await fixture.actions.mutatePlan(teamId, planId, idle, form("save-item", { orderNumber: "3" }))).status, "success");
  assert.equal(fixture.tables.training_plan_items[0].position, 2);
  assert.ok(writes(fixture)[0].filters.some(([key, value]) => key === "training_plan_id" && value === planId));
});
test("draft removes only its validated item and never a plan", async () => {
  const fixture = setup();
  assert.equal((await fixture.actions.mutatePlan(teamId, planId, idle, form("remove-item"))).status, "success");
  assert.equal(fixture.tables.training_plan_items.length, 0);
  assert.equal(fixture.tables.training_plans.length, 1);
  assert.equal(writes(fixture)[0].table, "training_plan_items");
});
test("activation validates current entitlement and updates only status", async () => {
  const fixture = setup({ gated: true, entitled: true });
  assert.equal((await fixture.actions.mutatePlan(teamId, planId, idle, form("activate"))).status, "success");
  assert.equal(fixture.tables.training_plans[0].status, "active");
  assert.deepEqual(writes(fixture)[0].payload, { status: "active" });
  assert.equal(fixture.tables.training_plan_items.length, 1);
});
test("late status change prevents a conditional draft update", async () => {
  const fixture = setup({ race: true });
  assert.equal((await fixture.actions.mutatePlan(teamId, planId, idle, form("save-plan"))).status, "error");
  assert.equal(fixture.tables.training_plans[0].name, "Test plan");
});
test("RLS write rejection remains an error", async () => {
  const fixture = setup({ deniedWrite: true });
  assert.equal((await fixture.actions.mutatePlan(teamId, planId, idle, form("save-plan"))).status, "error");
  assert.equal(fixture.invalidations.length, 0);
});
test("archive changes only status and never writes to assignments or sessions", async () => {
  const fixture = setup({ status: "active" });
  const originalItems = structuredClone(fixture.tables.training_plan_items);
  assert.equal((await fixture.actions.mutatePlan(teamId, planId, idle, form("archive"))).status, "success");
  assert.equal(fixture.tables.training_plans[0].status, "archived");
  assert.deepEqual(fixture.tables.training_plan_items, originalItems);
  assert.equal(writes(fixture).length, 1);
  assert.deepEqual(writes(fixture)[0].payload, { status: "archived" });
  assert.ok(!fixture.calls.some((call) => ["training_sessions", "training_plan_assignments", "workout_results"].includes(call.table)));
});
test("same-process mutations are serialized until the previous operation releases", async () => {
  const fixture = setup();
  let release;
  const events = [];
  const first = fixture.server.withPlanLock("plan", async () => {
    events.push("first");
    await new Promise((resolve) => { release = resolve; });
    events.push("first-finished");
  });
  const second = fixture.server.withPlanLock("plan", async () => { events.push("second"); });
  await Promise.resolve();
  assert.deepEqual(events, ["first"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first", "first-finished", "second"]);
});

function find(node, type) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) return node.map((child) => find(child, type)).find(Boolean) ?? null;
  return node.type === type ? node : find(node.props?.children, type);
}
for (const status of ["draft", "active", "archived"]) {
  test(`builder renders ${status} lifecycle controls and structure`, async () => {
    const fixture = setup({ status });
    const Form = ({ children }) => React.createElement("form", null, children);
    const Schedule = () => React.createElement("span", null, "Schedule controls");
    const page = loadTs("src/app/teams/[teamId]/plans/[planId]/page.tsx", {
      ...fixture.mocks,
      "../actions": fixture.actions,
      "@/components/plans/action-form": { default: Form },
      "@/components/plans/schedule-fields": { default: Schedule, planInputClass: "input" },
      "next/link": { default: (props) => React.createElement("a", props) },
      "next/navigation": { redirect: () => { throw Error("redirect"); }, notFound: () => { throw Error("404"); } },
    }).default;
    const tree = await page({ params: Promise.resolve({ teamId, planId }) });
    const markup = renderToStaticMarkup(tree);
    assert.ok(markup.includes("Day 1"));
    if (status === "draft") {
      assert.ok(find(tree, Form));
      assert.ok(markup.includes("save-plan"));
      assert.ok(markup.includes("activate"));
      assert.ok(markup.includes("Schedule controls"));
    } else {
      assert.ok(!markup.includes("save-plan"));
      assert.ok(!markup.includes("Schedule controls"));
      assert.ok(markup.includes("read-only"));
      if (status === "active") assert.ok(markup.includes(`/teams/${teamId}/assign`));
      else assert.equal(find(tree, Form), null);
    }
  });
}
