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
    profiles: [{ id: coachId, platform_role: options.platformRole ?? "user" }],
    team_memberships: [{ team_id: teamId, user_id: coachId, role: options.role ?? "coach" }],
    training_plans: [{ id: planId, team_id: null, kind: options.kind ?? "coach", visibility: options.visibility ?? "private", source_template_id: null, archived_at: options.archivedAt ?? null, owner_user_id: options.owner ?? coachId, name: "Test plan", description: "Description", status: options.status ?? "draft", created_at: version, updated_at: version }],
    training_plan_items: options.empty ? [] : [{ id: itemId, training_plan_id: planId, workout_id: workoutId, day_offset: 0, position: 0, scheduled_time: null, notes: null, updated_at: version }],
    workouts: options.inaccessible ? [] : [{ id: workoutId, name: "Workout", description: "Practice", difficulty: "beginner", visibility: options.publicWorkouts ? "public" : "team", team_id: teamId, owner_user_id: coachId, requires_entitlement: options.gated ? "premium_workouts" : null }],
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
          if (options.throwOn === `${table}:${operation}`) return Promise.reject(Error("connection lost")).then(resolve, reject);
          if (options.failedInsert === table && operation === "insert") return Promise.resolve({ data: null, error: { message: "rejected" }, status: options.failureStatus ?? 403 }).then(resolve, reject);
          if (options.deniedWrite && operation !== "read") return Promise.resolve({ data: [], error: { message: "RLS rejected" } }).then(resolve, reject);
          if (options.readError === table && operation === "read") return Promise.resolve({ data: null, error: { message: "RLS rejected" } }).then(resolve, reject);
          if (options.race && table === "training_plans" && operation === "update") tables.training_plans[0].status = "active";
          const matches = (row) => filters.every(([key, value]) => Array.isArray(value) ? value.includes(row[key]) : row[key] === value);
          let rows = (tables[table] ?? []).filter(matches);
          if (operation === "insert") {
            const added = (Array.isArray(payload) ? payload : [payload]).map((value) => ({ id: id(nextId++), updated_at: version, ...value }));
            tables[table].push(...added); rows = added;
          } else if (operation === "update") {
            rows.forEach((row) => {
              if (table === "training_plans" && payload.status === "archived") row.archived_at = new Date().toISOString();
              if (table === "training_plans" && row.status === "archived" && payload.status === "active") row.archived_at = null;
              Object.assign(row, payload, { updated_at: "2026-09-14T13:00:00+00:00" });
            });
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
  const adminServer = loadTs("src/lib/admin-training-templates-server.ts", mocks);
  mocks["@/lib/admin-training-templates-server"] = adminServer;
  const adminActions = loadTs("src/app/admin/training-templates/actions.ts", {
    ...mocks,
    "next/cache": { revalidatePath: (path) => invalidations.push(path) },
    "next/navigation": { redirect: (path) => { throw Error(`REDIRECT:${path}`); } },
  });
  return { tables, calls, invalidations, actions, server, mocks, adminServer, adminActions };
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
test("creation derives coach ownership and private library values from the session", async () => {
  const fixture = setup();
  await assert.rejects(fixture.actions.createPlan(teamId, idle, form("create", { team_id: id(99), owner_user_id: id(99), status: "active", kind: "template", visibility: "public" })), /REDIRECT:/);
  const payload = writes(fixture)[0].payload;
  assert.equal(payload.team_id, null);
  assert.equal(payload.kind, "coach");
  assert.equal(payload.visibility, "private");
  assert.equal(payload.owner_user_id, coachId);
  assert.equal(payload.status, "draft");
  assert.equal(fixture.invalidations.length, 2);
});
test("blank plan names cannot be created", async () => {
  const fixture = setup();
  assert.equal((await fixture.actions.createPlan(teamId, idle, form("create", { name: "  " }))).status, "error");
  assert.equal(writes(fixture).length, 0);
});

for (const [name, options, operation, fields] of [
  ["signed out", { signedOut: true }, "save-plan", {}],
  ["athlete", { role: "athlete" }, "save-plan", {}],
  ["other owner", { owner: id(99) }, "save-plan", {}],
  ["master template", { kind: "template", visibility: "public" }, "save-plan", {}],
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

test("assistant coach edits their own library plan details", async () => {
  const fixture = setup({ role: "assistant_coach" });
  assert.equal((await fixture.actions.mutatePlan(teamId, planId, idle, form("save-plan"))).status, "success");
  assert.equal(fixture.tables.training_plans[0].name, "New name");
  assert.deepEqual(writes(fixture)[0].filters, [["id", planId], ["kind", "coach"], ["owner_user_id", coachId], ["status", "draft"], ["updated_at", version]]);
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

const DAY = 86400000;
test("restore window uses archived_at with an inclusive exact 30-day boundary", () => {
  const now = Date.parse("2026-09-14T12:00:00Z");
  const archived = (age) => ({ status: "archived", archived_at: new Date(now - age).toISOString(), updated_at: "2026-09-14T11:59:59Z" });
  assert.deepEqual(logic.restorationWindow(archived(4 * DAY), now), { eligible: true, daysAgo: 4, daysRemaining: 26 });
  assert.equal(logic.restorationWindow(archived(30 * DAY), now).eligible, true);
  assert.equal(logic.restorationWindow(archived(30 * DAY + 1), now).eligible, false);
  for (const value of [null, "bad date", new Date(now + DAY).toISOString()]) assert.equal(logic.restorationWindow({ status: "archived", archived_at: value }, now).eligible, false);
  assert.equal(logic.restorationWindow({ ...archived(DAY), status: "active" }, now).eligible, false);
  assert.match(logic.archiveDescription(archived(4 * DAY), now), /Archived 4 days ago.*26 more days/);
  assert.match(logic.archiveDescription(archived(31 * DAY), now), /window has ended/);
});
for (const [label, options] of [
  ["expired archive", { status: "archived", archivedAt: new Date(Date.now() - 31 * DAY).toISOString() }],
  ["missing archive date", { status: "archived" }],
  ["draft", {}],
  ["active", { status: "active" }],
  ["other owner", { status: "archived", owner: id(99), archivedAt: new Date().toISOString() }],
  ["template", { status: "archived", kind: "template", visibility: "public", archivedAt: new Date().toISOString() }],
]) {
  test(`restore rejects ${label} without writes`, async () => {
    const fixture = setup(options);
    assert.equal((await fixture.actions.mutatePlan(teamId, planId, idle, form("restore"))).status, "error");
    assert.equal(writes(fixture).length, 0);
  });
}
test("eligible restore changes status to active and relies on trigger to clear archived_at", async () => {
  const fixture = setup({ status: "archived", archivedAt: new Date(Date.now() - 29 * DAY).toISOString() });
  const items = structuredClone(fixture.tables.training_plan_items);
  assert.equal((await fixture.actions.mutatePlan(teamId, planId, idle, form("restore"))).status, "success");
  assert.equal(fixture.tables.training_plans[0].status, "active");
  assert.equal(fixture.tables.training_plans[0].archived_at, null);
  assert.deepEqual(writes(fixture)[0].payload, { status: "active" });
  assert.deepEqual(fixture.tables.training_plan_items, items);
  assert.equal(writes(fixture).length, 1);
});
test("a single owned plan opens and changes from either coached team; unauthorized context fails", async () => {
  const fixture = setup();
  fixture.tables.team_memberships.push({ team_id: id(50), user_id: coachId, role: "assistant_coach" });
  const second = await fixture.server.requirePlanCoach(id(50));
  assert.equal((await fixture.server.requireCoachPlan(second, planId)).id, planId);
  assert.equal((await fixture.actions.mutatePlan(id(50), planId, idle, form("save-plan"))).status, "success");
  assert.equal(fixture.tables.training_plans.length, 1);
  assert.equal(fixture.tables.training_plans[0].team_id, null);
  await assert.rejects(fixture.server.requirePlanCoach(id(51)), /coaching permission/);
});
test("library workout eligibility includes all coached teams, excluding athlete-only teams", async () => {
  const fixture = setup();
  fixture.tables.team_memberships.push({ team_id: id(50), user_id: coachId, role: "assistant_coach" }, { team_id: id(51), user_id: coachId, role: "athlete" });
  fixture.tables.workouts.push(
    { ...fixture.tables.workouts[0], id: id(60), team_id: id(50), owner_user_id: id(99) },
    { ...fixture.tables.workouts[0], id: id(61), team_id: id(51), owner_user_id: id(99) },
  );
  assert.deepEqual((await fixture.server.loadPlanWorkouts(await fixture.server.requirePlanCoach(teamId))).map((workout) => workout.id), [workoutId, id(60)]);
});

function templateFixture(options = {}) {
  const fixture = setup({ kind: "template", visibility: "public", status: "active", owner: id(99), ...options });
  fixture.tables.training_plan_items.push(...Array.from({ length: 4 }, (_, index) => ({
    ...fixture.tables.training_plan_items[0], id: id(70 + index), position: index + 1, day_offset: index + 1, scheduled_time: "10:30:00", notes: `Item ${index}`,
  })));
  return fixture;
}
test("template duplication copies all paginated items with independent identities and canonical ownership", async () => {
  const fixture = templateFixture();
  const original = structuredClone({ plan: fixture.tables.training_plans[0], items: fixture.tables.training_plan_items });
  await assert.rejects(fixture.actions.duplicateTemplate(teamId, planId, idle, form("copy", { owner_user_id: id(98), team_id: id(98), source_template_id: id(98) })), /REDIRECT:/);
  const [planWrite, itemsWrite] = writes(fixture);
  const copyId = planWrite.payload.id;
  assert.deepEqual(planWrite.payload, { id: copyId, name: original.plan.name, description: original.plan.description, kind: "coach", visibility: "private", owner_user_id: coachId, team_id: null, status: "draft", source_template_id: planId });
  assert.equal(itemsWrite.payload.length, 5);
  assert.deepEqual(itemsWrite.payload, original.items.map(({ workout_id, day_offset, position, scheduled_time, notes }) => ({ training_plan_id: copyId, workout_id, day_offset, position, scheduled_time, notes })));
  const copyItems = fixture.tables.training_plan_items.filter((item) => item.training_plan_id === copyId);
  assert.ok(copyItems.every((item) => !original.items.some((source) => source.id === item.id)));
  assert.equal((await fixture.actions.mutatePlan(teamId, copyId, idle, form("save-item", { itemId: copyItems[0].id, orderNumber: "10" }))).status, "success");
  assert.deepEqual(fixture.tables.training_plan_items.filter((item) => item.training_plan_id === planId), original.items);
  const copiedNotes = copyItems[0].notes;
  fixture.tables.training_plan_items.find((item) => item.id === itemId).notes = "Master updated";
  assert.equal(copyItems[0].notes, copiedNotes);
  assert.ok(!fixture.calls.some((call) => ["training_sessions", "training_plan_assignments", "training_assignment_batches"].includes(call.table)));
});
for (const [label, options] of [
  ["coach plan source", { kind: "coach", owner: coachId }],
  ["private template", { visibility: "private" }],
  ["athlete", { role: "athlete" }],
  ["signed out", { signedOut: true }],
  ["unusable workout", { inaccessible: true }],
  ["unentitled workout", { gated: true }],
]) {
  test(`template duplication rejects ${label} before writes`, async () => {
    const fixture = templateFixture(options);
    assert.equal((await fixture.actions.duplicateTemplate(teamId, planId, idle, form("copy"))).status, "error");
    assert.equal(writes(fixture).length, 0);
  });
}
for (const options of [
  { failedInsert: "training_plans", failureStatus: 503 },
  { failedInsert: "training_plan_items", failureStatus: 403 },
  { throwOn: "training_plan_items:insert" },
]) {
  test(`incomplete/uncertain template copy ${JSON.stringify(options)} blocks retries and never deletes`, async () => {
    const fixture = templateFixture(options);
    const result = await fixture.actions.duplicateTemplate(teamId, planId, idle, form("copy"));
    assert.equal(result.status, "review_required");
    assert.ok(result.recoveryUrl.startsWith(`/teams/${teamId}/plans/`));
    const count = writes(fixture).length;
    assert.deepEqual(await fixture.actions.duplicateTemplate(teamId, planId, result, form("copy")), result);
    assert.equal(writes(fixture).length, count);
    assert.ok(!writes(fixture).some((call) => call.operation === "delete"));
  });
}
test("definite rejected plan copy does not copy items or claim success", async () => {
  const fixture = templateFixture({ failedInsert: "training_plans", failureStatus: 403 });
  assert.equal((await fixture.actions.duplicateTemplate(teamId, planId, idle, form("copy"))).status, "error");
  assert.equal(writes(fixture).length, 1);
});

async function renderBuilder(fixture) {
  const Form = ({ label, children }) => React.createElement("form", null, children, React.createElement("button", null, label));
  const page = loadTs("src/app/teams/[teamId]/plans/[planId]/page.tsx", {
    ...fixture.mocks, "../actions": fixture.actions,
    "@/components/plans/action-form": { default: Form },
    "@/components/plans/schedule-fields": { default: () => null, planInputClass: "input" },
    "next/link": { default: (props) => React.createElement("a", props) },
    "next/navigation": { redirect: () => { throw Error("redirect"); }, notFound: () => { throw Error("404"); } },
  }).default;
  return renderToStaticMarkup(await page({ params: Promise.resolve({ teamId, planId }) }));
}
for (const status of ["draft", "active", "archived"]) {
  test(`${status} master template renders only Use Template, never coach mutation/assignment controls`, async () => {
    if (status !== "active") {
      await assert.rejects(renderBuilder(templateFixture({ status })), /404/);
      return;
    }
    const markup = await renderBuilder(templateFixture({ status }));
    assert.ok(markup.includes("Use Template"));
    for (const forbidden of ["Activate Plan", "Archive Plan", "Restore Plan", "save-plan", `/teams/${teamId}/assign`]) assert.ok(!markup.includes(forbidden));
  });
}
test("restore control displays only with eligible archived_at, never recent updated_at alone", async () => {
  assert.ok((await renderBuilder(setup({ status: "archived", archivedAt: new Date(Date.now() - 4 * DAY).toISOString() }))).includes("Restore Plan"));
  assert.ok(!(await renderBuilder(setup({ status: "archived", archivedAt: new Date(Date.now() - 31 * DAY).toISOString() }))).includes("Restore Plan"));
});

async function renderLibrary(fixture, view, contextTeam = teamId) {
  const Form = ({ label }) => React.createElement("button", null, label);
  const page = loadTs("src/app/teams/[teamId]/plans/page.tsx", {
    ...fixture.mocks, "./actions": fixture.actions,
    "@/components/plans/action-form": { default: Form },
    "next/link": { default: (props) => React.createElement("a", props) },
    "next/navigation": { redirect: () => { throw Error("redirect"); } },
  }).default;
  return renderToStaticMarkup(await page({ params: Promise.resolve({ teamId: contextTeam }), searchParams: Promise.resolve({ view }) }));
}
test("library separates My Plans, public templates and own archived plans across team contexts", async () => {
  const fixture = setup();
  const base = fixture.tables.training_plans[0];
  fixture.tables.training_plans.push(
    { ...base, id: id(80), name: "Other coach plan", owner_user_id: id(99) },
    { ...base, id: id(81), name: "Public master", kind: "template", status: "active", visibility: "public", owner_user_id: id(99) },
    { ...base, id: id(82), name: "Own archived", status: "archived", archived_at: new Date(Date.now() - 4 * DAY).toISOString() },
    { ...base, id: id(83), name: "Private master", kind: "template" },
  );
  fixture.tables.team_memberships.push({ team_id: id(50), user_id: coachId, role: "coach" });
  for (const context of [teamId, id(50)]) {
    const mine = await renderLibrary(fixture, "mine", context);
    assert.ok(mine.includes("Test plan"));
    for (const forbidden of ["Other coach plan", "Public master", "Own archived"]) assert.ok(!mine.includes(forbidden));
  }
  const templates = await renderLibrary(fixture, "templates");
  assert.ok(templates.includes("Public master") && templates.includes("Use Template"));
  assert.ok(!templates.includes("Private master") && !templates.includes("Test plan"));
  const archived = await renderLibrary(fixture, "archived");
  assert.ok(archived.includes("Own archived") && archived.includes("26 more days"));
  assert.ok(!archived.includes("Test plan") && !archived.includes("Other coach plan"));
});
test("copy failure form shows review link/error and disables repeat submission", () => {
  const state = { status: "review_required", message: "Review the copy", recoveryUrl: `/teams/${teamId}/plans/${planId}` };
  const component = loadTs("src/components/plans/action-form.tsx", {
    react: { ...React, useActionState: () => [state, () => {}, false] },
    "@/lib/training-plans": logic,
    "next/link": { default: (props) => React.createElement("a", props) },
  }).default;
  const tree = component({ action: async () => state, children: null, label: "Use Template" });
  assert.equal(find(tree, "fieldset").props.disabled, true);
  assert.equal(find(tree, "button").props.disabled, true);
  assert.equal(find(tree, "p").props.role, "alert");
  assert.ok(renderToStaticMarkup(tree).includes(`href="${state.recoveryUrl}"`));
});

function adminFixture(options = {}) {
  return setup({ platformRole: "admin", kind: "template", visibility: "public", publicWorkouts: true, ...options });
}
for (const role of ["coach", "assistant_coach", "athlete"]) {
  test(`${role} team role cannot grant admin route access or template mutations`, async () => {
    const fixture = adminFixture({ platformRole: "user", role });
    await assert.rejects(fixture.adminServer.requirePlatformAdmin(), /Platform admin/);
    assert.equal((await fixture.adminActions.createTemplate(idle, form("create"))).status, "error");
    assert.equal((await fixture.adminActions.mutateTemplate(planId, idle, form("save-plan"))).status, "error");
    assert.equal(writes(fixture).length, 0);
    const nav = { redirect: () => { throw Error("denied"); }, notFound: () => { throw Error("404"); } };
    for (const path of ["src/app/admin/page.tsx", "src/app/admin/training-templates/page.tsx", "src/app/admin/training-templates/new/page.tsx", "src/app/admin/training-templates/[templateId]/page.tsx"]) {
      const page = loadTs(path, {
        ...fixture.mocks, "next/navigation": nav, "next/link": { default: () => null },
        "../actions": fixture.adminActions,
        "@/components/plans/action-form": { default: () => null },
        "@/components/plans/schedule-fields": { default: () => null, planInputClass: "input" },
      }).default;
      await assert.rejects(page({ params: Promise.resolve({ templateId: planId }) }), /denied/);
    }
  });
}
test("signed-out and missing-profile admin access fails closed", async () => {
  const fixture = adminFixture({ signedOut: true });
  await assert.rejects(fixture.adminServer.requirePlatformAdmin(), /sign in/);
  const missing = adminFixture(); missing.tables.profiles = [];
  await assert.rejects(missing.adminServer.requirePlatformAdmin(), /Platform admin/);
});
test("admin creation derives master identity from profile-auth context, not client or team role", async () => {
  const fixture = adminFixture({ role: "athlete" });
  await assert.rejects(fixture.adminActions.createTemplate(idle, form("create", { owner_user_id: id(99), team_id: teamId, kind: "coach", status: "active", source_template_id: id(99) })), /REDIRECT:\/admin\/training-templates/);
  const payload = writes(fixture)[0].payload;
  assert.equal(payload.kind, "template"); assert.equal(payload.visibility, "public"); assert.equal(payload.status, "draft");
  assert.equal(payload.team_id, null); assert.equal(payload.owner_user_id, coachId); assert.equal(payload.source_template_id, null);
});
for (const [label, options, operation, fields] of [
  ["coach plan target", { kind: "coach", visibility: "private" }, "save-plan", {}],
  ["stale version", {}, "save-plan", { planVersion: "old" }],
  ["empty publish", { empty: true }, "publish", {}],
  ["unavailable public workout", { inaccessible: true }, "publish", {}],
  ["nonpublic workout", { publicWorkouts: false }, "publish", {}],
  ["stale schedule", {}, "publish", { scheduleVersion: "old" }],
  ["foreign item", {}, "remove-item", { itemId: id(99) }],
  ["stale item", {}, "save-item", { itemVersion: "old" }],
  ["invalid day", {}, "save-item", { dayNumber: "0" }],
  ["duplicate order", {}, "add-item", {}],
  ["unknown operation", {}, "delete-template", {}],
]) {
  test(`admin rejects ${label} without writes`, async () => {
    const fixture = adminFixture(options);
    assert.equal((await fixture.adminActions.mutateTemplate(planId, idle, form(operation, fields))).status, "error"); assert.equal(writes(fixture).length, 0);
  });
}
for (const status of ["active", "archived"]) {
  for (const operation of ["save-plan", "add-item", "save-item", "remove-item"]) {
    test(`admin ${status} master is read-only for ${operation}`, async () => {
      const fixture = adminFixture({ status });
      assert.equal((await fixture.adminActions.mutateTemplate(planId, idle, form(operation))).status, "error"); assert.equal(writes(fixture).length, 0);
    });
  }
}
test("admin configures draft with existing human-day scheduling helpers", async () => {
  const fixture = adminFixture();
  assert.equal((await fixture.adminActions.mutateTemplate(planId, idle, form("save-plan"))).status, "success");
  const nextVersion = fixture.tables.training_plans[0].updated_at;
  assert.equal((await fixture.adminActions.mutateTemplate(planId, idle, form("add-item", { planVersion: nextVersion, dayNumber: "7", orderNumber: "2" }))).status, "success");
  const item = writes(fixture).at(-1).payload;
  assert.equal(item.day_offset, 6); assert.equal(item.position, 1); assert.equal(item.scheduled_time, "09:30"); assert.equal(item.notes, "Notes");
  assert.equal((await fixture.adminActions.mutateTemplate(planId, idle, form("remove-item", { planVersion: nextVersion }))).status, "success");
  assert.equal(fixture.tables.training_plan_items.length, 1);
});
for (const [operation, start, expected] of [["publish", "draft", "active"], ["unpublish", "active", "draft"], ["archive", "active", "archived"], ["edit-archived", "archived", "draft"]]) {
  test(`admin lifecycle ${operation} changes only master status to ${expected}`, async () => {
    const fixture = adminFixture({ status: start, gated: true });
    const items = structuredClone(fixture.tables.training_plan_items);
    assert.equal((await fixture.adminActions.mutateTemplate(planId, idle, form(operation))).status, "success");
    assert.equal(fixture.tables.training_plans[0].status, expected); assert.deepEqual(writes(fixture)[0].payload, { status: expected });
    assert.deepEqual(fixture.tables.training_plan_items, items);
    assert.ok(!fixture.calls.some((call) => ["training_plan_assignments", "training_sessions", "workout_results"].includes(call.table)));
  });
}
for (const status of ["draft", "archived"]) {
  test(`${status} masters cannot be viewed or copied by coach, even via direct ID`, async () => {
    const fixture = templateFixture({ status });
    await assert.rejects(fixture.server.requireReadablePlan(await fixture.server.requirePlanCoach(teamId), planId), /unavailable/);
    assert.equal((await fixture.actions.duplicateTemplate(teamId, planId, idle, form("copy"))).status, "error"); assert.equal(writes(fixture).length, 0);
    assert.ok(!(await renderLibrary(fixture, "templates")).includes("Test plan"));
  });
}
test("published master changes and archival never alter existing independent coach copy", async () => {
  const fixture = adminFixture({ status: "active" });
  await assert.rejects(fixture.actions.duplicateTemplate(teamId, planId, idle, form("copy")), /REDIRECT:/);
  const copy = fixture.tables.training_plans[1];
  const copyItems = structuredClone(fixture.tables.training_plan_items.filter((item) => item.training_plan_id === copy.id));
  const originalCopy = structuredClone(copy);
  assert.equal(copy.source_template_id, planId);
  assert.equal((await fixture.adminActions.mutateTemplate(planId, idle, form("unpublish"))).status, "success");
  const current = fixture.tables.training_plans[0].updated_at;
  assert.equal((await fixture.adminActions.mutateTemplate(planId, idle, form("save-item", { planVersion: current, notes: "Master edited" }))).status, "success");
  assert.deepEqual(fixture.tables.training_plan_items.filter((item) => item.training_plan_id === copy.id), copyItems);
  assert.deepEqual(copy, originalCopy);
});

test("admin layout independently denies non-admin and renders for admin", async () => {
  for (const platformRole of ["user", "admin"]) {
    const fixture = adminFixture({ platformRole });
    const layout = loadTs("src/app/admin/layout.tsx", {
      ...fixture.mocks, "next/link": { default: () => null }, "next/navigation": { redirect: () => { throw Error("denied"); } },
    }).default;
    if (platformRole === "user") await assert.rejects(layout({ children: "Admin child" }), /denied/);
    else assert.ok(renderToStaticMarkup(await layout({ children: "Admin child" })).includes("Admin child"));
  }
});
test("admin list separates draft, published and archived masters with counts, excluding coach plans", async () => {
  const fixture = adminFixture();
  const base = fixture.tables.training_plans[0];
  fixture.tables.training_plans.push({ ...base, id: id(90), name: "Published master", status: "active" }, { ...base, id: id(91), name: "Archived master", status: "archived" }, { ...base, id: id(92), name: "Private coach plan", kind: "coach", visibility: "private" });
  const page = loadTs("src/app/admin/training-templates/page.tsx", { ...fixture.mocks, "next/link": { default: (props) => React.createElement("a", props) }, "next/navigation": { redirect: () => { throw Error("denied"); } } }).default;
  const markup = renderToStaticMarkup(await page());
  for (const label of ["Draft", "Published", "Archived", "1 scheduled workouts", "Published master", "Archived master"]) assert.ok(markup.includes(label));
  assert.ok(!markup.includes("Private coach plan"));
});
for (const status of ["draft", "active", "archived"]) {
  test(`admin detail shows ${status} lifecycle controls and draft schedule fields`, async () => {
    const fixture = adminFixture({ status });
    const Form = ({ label, children }) => React.createElement("form", null, children, React.createElement("button", null, label));
    const Schedule = () => React.createElement("span", null, "Schedule inputs");
    const page = loadTs("src/app/admin/training-templates/[templateId]/page.tsx", {
      ...fixture.mocks, "../actions": fixture.adminActions, "@/components/plans/action-form": { default: Form }, "@/components/plans/schedule-fields": { default: Schedule, planInputClass: "input" },
      "next/link": { default: (props) => React.createElement("a", props) }, "next/navigation": { redirect: () => { throw Error("denied"); }, notFound: () => { throw Error("404"); } },
    }).default;
    const markup = renderToStaticMarkup(await page({ params: Promise.resolve({ templateId: planId }) }));
    assert.equal(markup.includes("Schedule inputs"), status === "draft");
    assert.equal(markup.includes("Publish Template"), status === "draft");
    assert.equal(markup.includes("Unpublish / Edit"), status === "active");
    assert.equal(markup.includes("Archive Template"), status === "active");
    assert.equal(markup.includes("Return to Draft"), status === "archived");
    assert.ok(!markup.includes("Assign Training") && !markup.includes("Use Template"));
  });
}
test("admin mutation RLS rejection remains an error with no false success", async () => {
  const fixture = adminFixture({ deniedWrite: true });
  assert.equal((await fixture.adminActions.mutateTemplate(planId, idle, form("publish"))).status, "error");
  assert.equal(fixture.tables.training_plans[0].status, "draft");
  assert.equal(fixture.invalidations.length, 0);
});
