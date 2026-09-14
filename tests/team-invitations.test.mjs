import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Actual TS modules, session-scoped mocks only: never call live Supabase.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
function loadTs(path, mocks = {}) {
  const source = ts.transpileModule(readFileSync(root + path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  const run = new vm.Script(`(function(require, module, exports) {${source}\n})`).runInThisContext();
  run((name) => name in mocks ? mocks[name] : require(name), loaded, loaded.exports);
  return loaded.exports;
}
const logic = loadTs("src/lib/team-invitations.ts");
const assignment = loadTs("src/lib/training-assignment.ts");
const id = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const teamId = id(1), userId = id(2), athleteId = id(3), athleteMembership = id(4), staffMembership = id(5), inviteId = id(6), otherTeam = id(7);
const token = "a".repeat(64), idle = { status: "idle", message: "" };
const future = () => new Date(Date.now() + 86400000).toISOString();
function form(email = "  Athlete@Example.COM ") {
  const data = new FormData();
  data.set("email", email); data.set("role", "coach"); data.set("invited_by_user_id", id(999));
  return data;
}
function setup(options = {}) {
  const calls = [], invalidations = [];
  const tables = {
    teams: [{ id: teamId, name: "Team", created_by_user_id: options.creator ?? userId }],
    team_memberships: [
      { id: id(10), team_id: teamId, user_id: userId, role: options.managerRole ?? "coach", profiles: { full_name: "Manager" } },
      { id: athleteMembership, team_id: teamId, user_id: athleteId, role: "athlete", profiles: { full_name: "Athlete" } },
      { id: staffMembership, team_id: teamId, user_id: id(11), role: "assistant_coach", profiles: { full_name: "Assistant" } },
      { id: id(12), team_id: otherTeam, user_id: athleteId, role: "athlete", profiles: { full_name: "Athlete" } },
    ],
    team_invitations: options.pending ? [{ id: inviteId, team_id: teamId, invited_email: "athlete@example.com", role: options.inviteRole ?? "athlete", status: options.inviteStatus ?? "pending", expires_at: options.expired ? "2020-01-01T00:00:00Z" : future(), created_at: "2026-09-14T10:00:00Z" }] : [],
    profiles: [{ id: athleteId, full_name: "Athlete" }], training_sessions: [{ id: id(30), athlete_user_id: athleteId }], workout_results: [{ id: id(31), athlete_user_id: athleteId }],
  };
  const client = {
    auth: {
      getUser: async () => ({ data: { user: options.signedOut ? null : { id: userId, email: "manager@example.com" } }, error: null }),
      signOut: async () => { calls.push({ operation: "signout" }); return { error: null }; },
    },
    from(table) {
      let operation = "read", payload, single = false, start = 0, end = Infinity;
      const filters = [];
      const query = {
        select() { return query; }, eq(key, value) { filters.push([key, value]); return query; }, order() { return query; },
        single() { single = true; return query; }, range(from, to) { start = from; end = to; return query; },
        insert(value) { operation = "insert"; payload = value; return query; }, update(value) { operation = "update"; payload = value; return query; }, delete() { operation = "delete"; return query; },
        then(resolve, reject) {
          calls.push({ table, operation, payload, filters });
          if (options.throwOn === `${table}:${operation}`) return Promise.reject(Error("connection lost")).then(resolve, reject);
          if (options.readError === table && operation === "read") return Promise.resolve({ data: null, error: { message: "denied" }, status: 403 }).then(resolve, reject);
          if (options.writeFailure !== undefined && operation !== "read") return Promise.resolve({ data: null, error: { message: "denied", code: options.writeCode }, status: options.writeFailure }).then(resolve, reject);
          if (options.race && operation !== "read") {
            if (table === "team_memberships") tables[table].find((row) => row.id === athleteMembership).role = "coach";
            if (table === "team_invitations") tables[table][0].status = "accepted";
          }
          const matches = (row) => filters.every(([key, value]) => row[key] === value);
          let rows = (tables[table] ?? []).filter(matches);
          if (operation === "insert") { const row = { created_at: new Date().toISOString(), ...payload }; tables[table].push(row); rows = [row]; }
          if (operation === "update") rows.forEach((row) => Object.assign(row, payload));
          if (operation === "delete") tables[table] = tables[table].filter((row) => !matches(row));
          if (operation === "read") rows = rows.slice(start, Math.min(end + 1, start + 2));
          return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null, status: operation === "insert" ? 201 : 200 }).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name, args) {
      calls.push({ operation: "rpc", name, args });
      if (options.rpcThrows) throw Error("connection lost");
      if (name === "get_team_invitation_summary") return { data: options.invalidToken ? [] : [{ team_name: "Team", invitation_role: options.acceptedRole ?? "athlete", invitation_status: options.summaryStatus ?? "pending", expires_at: options.expired ? "2020-01-01T00:00:00Z" : future() }], error: null, status: 200 };
      if (options.rpcError) return { data: null, error: { message: options.rpcError }, status: options.rpcStatus ?? 400 };
      // Model the existing atomic RPC, preserving every other membership/history row.
      const result = { team_id: otherTeam, membership_id: id(40), membership_role: options.acceptedRole ?? "athlete" };
      tables.team_memberships.push({ id: result.membership_id, team_id: result.team_id, user_id: userId, role: result.membership_role });
      return { data: [result], error: null, status: 200 };
    },
  };
  const mocks = {
    "server-only": {}, "@/lib/supabase/server": { createClient: async () => client }, "@/lib/training-assignment": assignment, "@/lib/team-invitations": logic,
    "next/cache": { revalidatePath: (path) => invalidations.push(path) },
    "next/navigation": { redirect: (path) => { throw Error(`REDIRECT:${path}`); } },
    "next/link": { default: (props) => React.createElement("a", props) },
  };
  mocks["@/lib/team-roster-server"] = loadTs("src/lib/team-roster-server.ts", mocks);
  const actions = loadTs("src/app/teams/[teamId]/roster/actions.ts", mocks);
  const acceptance = loadTs("src/app/invite/[token]/actions.ts", mocks);
  return { calls, tables, mocks, actions, acceptance, invalidations };
}
const writes = (fixture) => fixture.calls.filter((call) => ["insert", "update", "delete"].includes(call.operation));

test("email normalization and basic validation", () => {
  assert.equal(logic.normalizeInvitationEmail("  A@Example.COM "), "a@example.com");
  for (const value of [null, "", "abc", "x@y", "a b@example.com", "x".repeat(255) + "@example.com"]) assert.throws(() => logic.normalizeInvitationEmail(value));
});
for (const [managerRole, role] of [["coach", "athlete"], ["assistant_coach", "athlete"], ["coach", "assistant_coach"]]) {
  test(`${managerRole} invites ${role} with secure hash, server ownership and one-time URL`, async () => {
    const fixture = setup({ managerRole });
    const result = await fixture.actions.createInvitation(teamId, role, idle, form());
    assert.equal(result.status, "success");
    const raw = result.invitationPath.split("/").at(-1);
    assert.match(raw, /^[a-f0-9]{64}$/);
    const payload = writes(fixture)[0].payload;
    assert.equal(payload.token_hash, createHash("sha256").update(raw).digest("hex"));
    assert.ok(!JSON.stringify(payload).includes(raw));
    assert.equal(payload.role, role); assert.equal(payload.invited_by_user_id, userId); assert.equal(payload.invited_email, "athlete@example.com");
    assert.ok(Date.parse(result.expiresAt) > Date.now() + 6.99 * 86400000);
    assert.deepEqual(await fixture.actions.createInvitation(teamId, role, result, form()), result);
    assert.equal(writes(fixture).length, 1);
  });
}
for (const [label, options, role, email] of [
  ["assistant inviting staff", { managerRole: "assistant_coach" }, "assistant_coach"],
  ["athlete", { managerRole: "athlete" }, "athlete"], ["signed out", { signedOut: true }, "athlete"],
  ["unsupported coach role", {}, "coach"], ["duplicate pending", { pending: true }, "athlete"],
  ["expired pending still blocks index", { pending: true, expired: true }, "athlete"],
  ["existing self member", {}, "athlete", "manager@example.com"], ["invalid email", {}, "athlete", "bad"],
]) {
  test(`invite rejects ${label} without writes`, async () => {
    const fixture = setup(options);
    assert.equal((await fixture.actions.createInvitation(teamId, role, idle, form(email))).status, "error"); assert.equal(writes(fixture).length, 0);
  });
}
test("database duplicate race is a friendly rejection", async () => {
  const fixture = setup({ writeFailure: 409, writeCode: "23505" });
  assert.match((await fixture.actions.createInvitation(teamId, "athlete", idle, form())).message, /pending invitation/);
});
test("unknown invitation insert blocks retries and never exposes unconfirmed token", async () => {
  const fixture = setup({ writeFailure: 503 });
  const result = await fixture.actions.createInvitation(teamId, "athlete", idle, form());
  assert.equal(result.status, "review_required"); assert.equal(result.invitationPath, undefined);
  await fixture.actions.createInvitation(teamId, "athlete", result, form()); assert.equal(writes(fixture).length, 1);
});
for (const [managerRole, role, allowed] of [["coach", "athlete", true], ["coach", "assistant_coach", true], ["assistant_coach", "athlete", true], ["assistant_coach", "assistant_coach", false], ["athlete", "athlete", false]]) {
  test(`revocation permissions ${managerRole}/${role}`, async () => {
    const fixture = setup({ managerRole, pending: true, inviteRole: role });
    const result = await fixture.actions.revokeInvitation(teamId, inviteId, idle);
    assert.equal(result.status, allowed ? "success" : "error");
    if (allowed) { assert.equal(fixture.tables.team_invitations[0].status, "revoked"); assert.ok(fixture.tables.team_invitations[0].revoked_at); assert.equal(writes(fixture)[0].operation, "update"); }
    else assert.equal(writes(fixture).length, 0);
  });
}
for (const status of ["accepted", "revoked", "expired"]) {
  test(`cannot revoke ${status} history`, async () => {
    const fixture = setup({ pending: true, inviteStatus: status });
    assert.equal((await fixture.actions.revokeInvitation(teamId, inviteId, idle)).status, "error"); assert.equal(writes(fixture).length, 0);
  });
}
for (const [managerRole, targetId, allowed] of [["coach", athleteMembership, true], ["assistant_coach", athleteMembership, true], ["coach", staffMembership, true], ["assistant_coach", staffMembership, false], ["athlete", athleteMembership, false], ["coach", id(10), false], ["coach", id(12), false]]) {
  test(`member removal permission ${managerRole}/${targetId}`, async () => {
    const fixture = setup({ managerRole }); const original = structuredClone(fixture.tables);
    assert.equal((await fixture.actions.removeMember(teamId, targetId, idle)).status, allowed ? "success" : "error");
    if (allowed) {
      assert.equal(writes(fixture).length, 1); assert.equal(writes(fixture)[0].table, "team_memberships");
      assert.deepEqual(fixture.tables.team_memberships, original.team_memberships.filter((member) => member.id !== targetId));
      for (const table of ["profiles", "training_sessions", "workout_results"]) assert.deepEqual(fixture.tables[table], original[table]);
    } else assert.equal(writes(fixture).length, 0);
  });
}
test("team creator remains protected even with an athlete role", async () => {
  const fixture = setup({ creator: athleteId });
  assert.equal((await fixture.actions.removeMember(teamId, athleteMembership, idle)).status, "error"); assert.equal(writes(fixture).length, 0);
});
test("role/status races prevent deleting coaches or revoking accepted invites", async () => {
  const fixture = setup({ race: true, pending: true });
  assert.equal((await fixture.actions.removeMember(teamId, athleteMembership, idle)).status, "error");
  assert.ok(fixture.tables.team_memberships.some((member) => member.id === athleteMembership && member.role === "coach"));
  assert.equal((await fixture.actions.revokeInvitation(teamId, inviteId, idle)).status, "error"); assert.equal(fixture.tables.team_invitations[0].status, "accepted");
});
for (const [error, expected] of [["Invitation email does not match the signed-in account", /account associated/], ["User is already a member of this team", /already a member/], ["Invitation has expired", /expired/], ["Invitation is no longer pending", /accepted, revoked, or expired/], ["Invitation not found", /invalid/], ["Inviter no longer has permission to invite athletes", /no longer has permission/]]) {
  test(`acceptance handles ${error} through RPC without direct writes`, async () => {
    const fixture = setup({ rpcError: error }); const original = structuredClone(fixture.tables);
    const result = await fixture.acceptance.acceptInvitation(token, idle);
    assert.equal(result.status, "error"); assert.match(result.message, expected); assert.deepEqual(fixture.tables, original); assert.equal(writes(fixture).length, 0);
  });
}
for (const role of ["athlete", "assistant_coach"]) {
  test(`RPC acceptance preserves other memberships and redirects ${role} appropriately`, async () => {
    const fixture = setup({ acceptedRole: role }); const previous = structuredClone(fixture.tables.team_memberships);
    await assert.rejects(fixture.acceptance.acceptInvitation(token, idle), new RegExp(`REDIRECT:${role === "athlete" ? "/$" : `/teams/${otherTeam}`}`));
    assert.deepEqual(fixture.tables.team_memberships.slice(0, previous.length), previous);
    assert.equal(writes(fixture).length, 0);
    assert.deepEqual(fixture.calls.find((call) => call.name === "accept_team_invitation").args, { invitation_token: token });
  });
}
test("uncertain RPC acceptance blocks retry and does not compensate", async () => {
  const fixture = setup({ rpcThrows: true });
  const result = await fixture.acceptance.acceptInvitation(token, idle); assert.equal(result.status, "review_required");
  await fixture.acceptance.acceptInvitation(token, result); assert.equal(fixture.calls.filter((call) => call.operation === "rpc").length, 1); assert.equal(writes(fixture).length, 0);
});
test("auth and invalid tokens reject acceptance before RPC", async () => {
  for (const [options, value] of [[{ signedOut: true }, token], [{}, "invalid"]]) {
    const fixture = setup(options); assert.equal((await fixture.acceptance.acceptInvitation(value, idle)).status, "error"); assert.equal(fixture.calls.filter((call) => call.operation === "rpc").length, 0);
  }
});
test("safe login destination preserves only local invitation paths", () => {
  assert.equal(logic.safeInvitationDestination(`/invite/${token}`), `/invite/${token}`);
  for (const value of [null, "https://evil.example", "//evil.example", "/teams/new", `/invite/${token}?next=https://evil.example`, "/invite/short", "/invite/%0A"]) assert.equal(logic.safeInvitationDestination(value), "/");
  const url = new URL(logic.invitationLoginPath(token), "https://tilt.example"); assert.equal(url.searchParams.get("next"), `/invite/${token}`);
});
async function invitePage(fixture) {
  const Form = ({ label }) => React.createElement("button", null, label);
  const page = loadTs("src/app/invite/[token]/page.tsx", { ...fixture.mocks, "./actions": fixture.acceptance, "@/components/roster-action-form": { default: Form } }).default;
  return page({ params: Promise.resolve({ token }) });
}
test("unauthenticated invitation page preserves token in login redirect", async () => {
  await assert.rejects(invitePage(setup({ signedOut: true })), (error) => error.message === `REDIRECT:${logic.invitationLoginPath(token)}`);
});
test("switching account signs out and preserves invitation", async () => {
  const fixture = setup();
  await assert.rejects(fixture.acceptance.switchInvitationAccount(token, idle), (error) => error.message === `REDIRECT:${logic.invitationLoginPath(token)}`);
  assert.equal(fixture.calls[0].operation, "signout");
});
for (const options of [{}, { expired: true }, { summaryStatus: "accepted" }, { summaryStatus: "revoked" }, { invalidToken: true }]) {
  test(`summary page renders valid status and acceptance controls ${JSON.stringify(options)}`, async () => {
    const markup = renderToStaticMarkup(await invitePage(setup(options)));
    assert.equal(markup.includes("Accept Invitation"), !options.expired && !options.summaryStatus && !options.invalidToken);
    assert.ok(!markup.includes("athlete@example.com"));
  });
}
test("expiration is inclusive and accepted/revoked tokens cannot be accepted", () => {
  const now = Date.now(); const summary = { invitation_role: "athlete", invitation_status: "pending", expires_at: new Date(now).toISOString() };
  assert.equal(logic.canAcceptInvitation(summary, now), false);
  assert.equal(logic.canAcceptInvitation({ ...summary, expires_at: new Date(now + 1).toISOString() }, now), true);
  assert.equal(logic.effectiveInvitationStatus("pending", summary.expires_at, now), "expired");
  for (const status of ["accepted", "revoked", "expired"]) assert.equal(logic.canAcceptInvitation({ ...summary, invitation_status: status, expires_at: future() }, now), false);
});
for (const managerRole of ["coach", "assistant_coach"]) {
  test(`roster UI permissions and old links cannot be reconstructed ${managerRole}`, async () => {
    const fixture = setup({ managerRole, pending: true, inviteRole: "assistant_coach" });
    const Form = ({ label }) => React.createElement("button", null, label);
    const page = loadTs("src/app/teams/[teamId]/roster/page.tsx", { ...fixture.mocks, "./actions": fixture.actions, "@/components/roster-action-form": { default: Form } }).default;
    const markup = renderToStaticMarkup(await page({ params: Promise.resolve({ teamId }) }));
    assert.ok(markup.includes("Invite Athlete")); assert.equal(markup.includes("Invite Assistant Coach"), managerRole === "coach"); assert.equal(markup.includes("Revoke Invitation"), managerRole === "coach");
    assert.ok(markup.includes("Athletes") && markup.includes("Assistant Coaches") && markup.includes("Pending Invitations"));
    assert.ok(!markup.includes("Copy Invitation Link") && !markup.includes("token_hash"));
  });
}

function find(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean) ?? null;
  return predicate(node) ? node : find(node.props?.children, predicate);
}
test("login submits credentials and returns to the preserved invitation", async () => {
  const pushed = [];
  const previousWindow = globalThis.window;
  globalThis.window = { location: { search: `?next=${encodeURIComponent(`/invite/${token}`)}` } };
  try {
    let cursor = 0;
    const component = loadTs("src/app/login/page.tsx", {
      "@/lib/team-invitations": logic,
      "@/lib/supabase/client": { createClient: () => ({ auth: { signInWithPassword: async ({ email, password }) => { assert.equal(email, "athlete@example.com"); assert.equal(password, "test-password"); return { error: null }; } } }) },
      "next/navigation": { useRouter: () => ({ push: (path) => pushed.push(path), refresh() {} }) },
      react: { ...React, useState: () => [["athlete@example.com", "test-password", "", false][cursor++], () => {}] },
    }).default;
    const tree = component();
    await find(tree, (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
    assert.deepEqual(pushed, [`/invite/${token}`]);
  } finally { globalThis.window = previousWindow; }
});
test("immediate success shows copy link; pending/review forms cannot resubmit", () => {
  for (const state of [{ status: "success", message: "Created", invitationPath: `/invite/${token}`, email: "athlete@example.com", role: "athlete", expiresAt: future() }, { status: "review_required", message: "Review change" }]) {
    const component = loadTs("src/components/roster-action-form.tsx", {
      "@/lib/team-invitations": logic,
      react: { ...React, useActionState: () => [state, () => {}, false], useState: () => ["", () => {}] },
    }).default;
    const tree = component({ action: async () => state, label: "Invite Athlete" });
    if (state.status === "success") {
      assert.equal(find(tree, (node) => node.type === "input").props.value, `/invite/${token}`);
      assert.ok(renderToStaticMarkup(tree).includes("Copy Invitation Link"));
      assert.equal(find(tree, (node) => node.type === "button").props.type, "button");
    } else {
      assert.equal(find(tree, (node) => node.type === "fieldset").props.disabled, true);
      assert.equal(find(tree, (node) => node.props.role === "alert").props.children, state.message);
    }
  }
});
test("foreign-team invitation cannot be revoked", async () => {
  const fixture = setup({ pending: true }); fixture.tables.team_invitations[0].team_id = otherTeam;
  assert.equal((await fixture.actions.revokeInvitation(teamId, inviteId, idle)).status, "error"); assert.equal(writes(fixture).length, 0);
});
test("removal RLS rejection and uncertain response are explicit", async () => {
  for (const [writeFailure, status] of [[403, "error"], [503, "review_required"]]) {
    const fixture = setup({ writeFailure });
    assert.equal((await fixture.actions.removeMember(teamId, athleteMembership, idle)).status, status);
    assert.ok(fixture.tables.team_memberships.some((member) => member.id === athleteMembership));
  }
});
