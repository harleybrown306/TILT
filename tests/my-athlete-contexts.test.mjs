import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const source = readFileSync(new URL("../src/lib/my-athlete-contexts-server.ts", import.meta.url), "utf8");
const compile = (value) => ts.transpileModule(value
  .replace('import "server-only";\n', "")
  .replace('import { redirect } from "next/navigation";', "const { redirect } = require('next/navigation');")
  .replace('import { createClient } from "@/lib/supabase/server";', "const { createClient } = require('@/lib/supabase/server');"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
function loadModule(createClient = undefined) {
  const contextModule = { exports: {} };
  new vm.Script(`(function(module,exports,require){${compile(source)}})`).runInThisContext()(contextModule, contextModule.exports, (name) => {
    if (name === "@/lib/supabase/server") return { createClient };
    if (name === "next/navigation") return { redirect: (path) => { throw new Error(`redirect:${path}`); } };
    return {};
  });
  return contextModule.exports;
}
const { resolveActiveAthleteContext } = loadModule();

const context = (athleteId, relationshipRole = "guardian", capabilities = {}) => ({
  athleteId,
  displayName: capabilities.displayName ?? athleteId,
  graduationYear: null,
  relationshipRole,
  canManage: capabilities.canManage ?? false,
  canAct: capabilities.canAct ?? false,
});

function relationship(athleteId, role, { canManage = false, canAct = false, revokedAt = null } = {}) {
  return {
    profile_id: "claimed-profile",
    athlete_id: athleteId,
    role,
    revoked_at: revokedAt,
    manage_permission: canManage,
    training_permission: canAct,
    athletes: { id: athleteId, display_name: athleteId, graduation_year: null },
  };
}

async function loadContexts(rows) {
  const filters = {};
  const query = {
    select() { return this; },
    eq(field, value) { filters[field] = value; return this; },
    in(field, value) { filters[field] = value; return this; },
    is(field, value) {
      filters[field] = value;
      return Promise.resolve({
        data: rows.filter((row) => row.profile_id === filters.profile_id
          && filters.role.includes(row.role)
          && row.revoked_at === filters.revoked_at),
        error: null,
      });
    },
  };
  const { loadMyFamilyAthleteContexts } = loadModule(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "claimed-profile" } }, error: null }) },
    from: () => query,
  }));
  return loadMyFamilyAthleteContexts();
}

test("one self athlete is selected by default", () => {
  const self = context("self", "self", { canManage: true, canAct: true });
  assert.deepEqual(resolveActiveAthleteContext([self]), { status: "selected", context: self });
});

test("one guardian child is selectable with independent capabilities", () => {
  const child = context("child", "guardian", { canManage: true, canAct: false });
  const result = resolveActiveAthleteContext([child]);
  assert.equal(result.status, "selected");
  assert.equal(result.context.canManage, true);
  assert.equal(result.context.canAct, false);
});

test("two guardian children use display name then durable ID as the deterministic default", () => {
  const result = resolveActiveAthleteContext([
    context("z-id", "guardian", { displayName: "Alex" }),
    context("a-id", "guardian", { displayName: "Alex" }),
    context("b-id", "guardian", { displayName: "Bea" }),
  ]);
  assert.deepEqual(result, { status: "selected", context: context("a-id", "guardian", { displayName: "Alex" }) });
});

test("one self relationship wins over guardian contexts", () => {
  const self = context("self", "self");
  assert.deepEqual(resolveActiveAthleteContext([context("child"), self]), { status: "selected", context: self });
});

test("an explicit authorized athlete request is selected", () => {
  const child = context("child");
  assert.deepEqual(resolveActiveAthleteContext([context("other"), child], "child"), { status: "selected", context: child });
});

test("an explicit unauthorized athlete request fails closed instead of falling back", () => {
  assert.deepEqual(resolveActiveAthleteContext([context("child")], "not-authorized"), {
    status: "unauthorized_request", requestedAthleteId: "not-authorized",
  });
});

test("an explicit empty or whitespace request fails closed without normalization", () => {
  const child = context("child");
  assert.deepEqual(resolveActiveAthleteContext([child], ""), { status: "unauthorized_request", requestedAthleteId: "" });
  assert.deepEqual(resolveActiveAthleteContext([child], " child "), { status: "unauthorized_request", requestedAthleteId: " child " });
});

test("self sorts before guardian when deterministic ordering is needed", () => {
  const self = context("self-a", "self", { displayName: "Zulu" });
  const guardian = context("guardian-a", "guardian", { displayName: "Alpha" });
  // Duplicate self relationships are invalid database state; this pure input
  // verifies the explicit role comparator independently of the self override.
  const anotherSelf = context("self-b", "self", { displayName: "Beta" });
  assert.deepEqual(resolveActiveAthleteContext([guardian, self, anotherSelf]), { status: "selected", context: anotherSelf });
});

test("duplicate durable identities fail closed without merging capabilities", () => {
  const self = context("same", "self", { canManage: false, canAct: true });
  const guardian = context("same", "guardian", { canManage: true, canAct: false });
  const expected = { status: "ambiguous_context", athleteId: "same" };
  assert.deepEqual(resolveActiveAthleteContext([self, guardian]), expected);
  assert.deepEqual(resolveActiveAthleteContext([self, guardian], "same"), expected);
});

test("loader keeps one SELF or GUARDIAN context for one durable athlete", async () => {
  assert.deepEqual(await loadContexts([relationship("athlete-a", "self", { canManage: true, canAct: true })]), [
    context("athlete-a", "self", { canManage: true, canAct: true }),
  ]);
  assert.deepEqual(await loadContexts([relationship("athlete-a", "guardian", { canManage: true })]), [
    context("athlete-a", "guardian", { canManage: true }),
  ]);
});

test("loader selects SELF wholesale over GUARDIAN for the same durable athlete", async () => {
  const contexts = await loadContexts([
    relationship("durable-athlete-a", "guardian", { canManage: true, canAct: true }),
    relationship("durable-athlete-a", "self", { canManage: false, canAct: false }),
  ]);
  assert.deepEqual(contexts, [context("durable-athlete-a", "self", { canManage: false, canAct: false })]);
  assert.notEqual(contexts[0].athleteId, "claimed-profile");
});

test("loader fails closed for duplicate SELF contexts regardless of row order", async () => {
  const first = relationship("athlete-a", "self", { canManage: false, canAct: false });
  const second = relationship("athlete-a", "self", { canManage: true, canAct: true });
  await assert.rejects(loadContexts([first, second]), /context data is ambiguous for athlete athlete-a/);
  await assert.rejects(loadContexts([second, first]), /context data is ambiguous for athlete athlete-a/);
});

test("loader fails closed for duplicate GUARDIAN contexts regardless of row order", async () => {
  const first = relationship("athlete-a", "guardian", { canManage: false, canAct: false });
  const second = relationship("athlete-a", "guardian", { canManage: true, canAct: true });
  await assert.rejects(loadContexts([first, second]), /context data is ambiguous for athlete athlete-a/);
  await assert.rejects(loadContexts([second, first]), /context data is ambiguous for athlete athlete-a/);
});

test("loader does not let valid cross-role precedence hide same-role corruption", async () => {
  await assert.rejects(loadContexts([
    relationship("athlete-a", "self", { canManage: false }),
    relationship("athlete-a", "self", { canManage: true }),
    relationship("athlete-a", "guardian", { canManage: true }),
  ]), /context data is ambiguous for athlete athlete-a/);
  await assert.rejects(loadContexts([
    relationship("athlete-a", "self", { canManage: false }),
    relationship("athlete-a", "guardian", { canManage: false }),
    relationship("athlete-a", "guardian", { canManage: true }),
  ]), /context data is ambiguous for athlete athlete-a/);
});

test("loader preserves distinct durable athletes while applying SELF precedence per athlete", async () => {
  assert.deepEqual(await loadContexts([
    relationship("athlete-a", "self", { canManage: true }),
    relationship("athlete-b", "guardian", { canAct: true }),
  ]), [
    context("athlete-a", "self", { canManage: true }),
    context("athlete-b", "guardian", { canAct: true }),
  ]);
});

test("loader ignores revoked relationships before applying precedence", async () => {
  assert.deepEqual(await loadContexts([
    relationship("athlete-a", "self", { revokedAt: "2026-09-24T00:00:00Z" }),
    relationship("athlete-a", "guardian", { canManage: true }),
  ]), [context("athlete-a", "guardian", { canManage: true })]);
  assert.deepEqual(await loadContexts([
    relationship("athlete-a", "self", { canAct: true }),
    relationship("athlete-a", "guardian", { canManage: true, revokedAt: "2026-09-24T00:00:00Z" }),
  ]), [context("athlete-a", "self", { canAct: true })]);
});

test("no contexts returns no selection", () => {
  assert.deepEqual(resolveActiveAthleteContext([]), { status: "none" });
});

test("reader behaviorally scopes active rows to the authenticated self/guardian relationship", async () => {
  const rows = [
    { profile_id: "current-profile", athlete_id: "self", role: "self", revoked_at: null, training_permission: true, manage_permission: true, athletes: { id: "self", display_name: "Self", graduation_year: null } },
    { profile_id: "current-profile", athlete_id: "child", role: "guardian", revoked_at: null, training_permission: false, manage_permission: true, athletes: { id: "child", display_name: "Child", graduation_year: 2030 } },
    { profile_id: "current-profile", athlete_id: "revoked", role: "guardian", revoked_at: "2026-09-01T00:00:00Z", training_permission: true, manage_permission: true, athletes: { id: "revoked", display_name: "Revoked", graduation_year: null } },
    { profile_id: "current-profile", athlete_id: "staff-only", role: "coach", revoked_at: null, training_permission: true, manage_permission: true, athletes: { id: "staff-only", display_name: "Staff", graduation_year: null } },
    { profile_id: "another-profile", athlete_id: "other", role: "guardian", revoked_at: null, training_permission: true, manage_permission: true, athletes: { id: "other", display_name: "Other", graduation_year: null } },
  ];
  const calls = [];
  const filters = {};
  const query = {
    select(value) { calls.push(["select", value]); return this; },
    eq(field, value) { calls.push(["eq", field, value]); filters[field] = value; return this; },
    in(field, value) { calls.push(["in", field, value]); filters[field] = value; return this; },
    is(field, value) {
      calls.push(["is", field, value]); filters[field] = value;
      return Promise.resolve({ data: rows.filter((row) => row.profile_id === filters.profile_id && filters.role.includes(row.role) && row.revoked_at === filters.revoked_at), error: null });
    },
  };
  const { loadMyFamilyAthleteContexts } = loadModule(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "current-profile" } }, error: null }) },
    from: (table) => { calls.push(["from", table]); return query; },
  }));
  assert.deepEqual(await loadMyFamilyAthleteContexts(), [
    context("self", "self", { displayName: "Self", canManage: true, canAct: true }),
    { ...context("child", "guardian", { displayName: "Child", canManage: true, canAct: false }), graduationYear: 2030 },
  ]);
  assert.deepEqual(calls, [
    ["from", "athlete_profile_relationships"],
    ["select", "athlete_id,role,training_permission,manage_permission,athletes!inner(id,display_name,graduation_year,status)"],
    ["eq", "profile_id", "current-profile"], ["in", "role", ["self", "guardian"]], ["eq", "athletes.status", "active"], ["is", "revoked_at", null],
  ]);
});

test("reader source excludes privileged fallbacks and uses only current-user RLS queries", () => {
  assert.match(source, /supabase\.auth\.getUser\(\)/);
  assert.match(source, /\.eq\("profile_id", user\.id\)/);
  assert.match(source, /\.in\("role", \["self", "guardian"\]\)/);
  assert.match(source, /\.eq\("athletes\.status", "active"\)/);
  assert.match(source, /\.is\("revoked_at", null\)/);
  assert.doesNotMatch(source, /function loadMyFamilyAthleteContexts\([^)]/);
  assert.doesNotMatch(source, /service_role|SECURITY DEFINER|rpc\(/i);
  assert.doesNotMatch(source, /team_staff_memberships|platform_role/);
});

test("reader projects every stored MANAGE and ACT combination without profile identity", async () => {
  const rows = [[true, true], [true, false], [false, true], [false, false]].map(([manage, act], index) => ({
    athlete_id: `child-${index}`, role: "guardian", manage_permission: manage, training_permission: act,
    athletes: { id: `child-${index}`, display_name: `Child ${index}`, graduation_year: null },
  }));
  const query = { select() { return this; }, eq() { return this; }, in() { return this; }, is() { return Promise.resolve({ data: rows, error: null }); } };
  const { loadMyFamilyAthleteContexts } = loadModule(async () => ({ auth: { getUser: async () => ({ data: { user: { id: "parent" } }, error: null }) }, from: () => query }));
  assert.deepEqual((await loadMyFamilyAthleteContexts()).map(({ canManage, canAct }) => [canManage, canAct]), [[true, true], [true, false], [false, true], [false, false]]);
  assert.doesNotMatch(source, /athlete_user_id|profiles\(/);
});
