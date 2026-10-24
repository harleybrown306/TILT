import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const validTeamId = "3bd7f2ca-0a0c-4c9b-8f3a-5345317d7510";
const user = { id: "0dbd0d83-e85f-48d0-8508-05aef86b6a7e" };

function loadAttentionLoader(createClient) {
  const source = readFileSync(new URL("../src/lib/team-attendance-server.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const loaded = { exports: {} };
  const navigation = {
    redirect: (destination) => { throw new Error(`REDIRECT:${destination}`); },
    notFound: () => { throw new Error("NOT_FOUND"); },
  };
  new vm.Script(`(function(require, module, exports) {${compiled}\n})`).runInThisContext()(
    (name) => {
      if (name === "server-only") return {};
      if (name === "next/navigation") return navigation;
      if (name === "@/lib/supabase/server") return { createClient };
      if (name === "./athlete-exercise-adherence") return { athleteExerciseAdherenceInput: () => undefined };
      if (name === "./training-assignment") {
        return {
          isUuid: (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
          readAllRows: async () => [],
        };
      }
      return require(name);
    },
    loaded,
    loaded.exports,
  );
  return loaded.exports.loadTeamAttentionAttendance;
}

function attentionRow() {
  return {
    as_of_date: "2026-10-24",
    session_id: "c9f9db99-41c0-4df1-a5a1-3996838f0883",
    athlete_id: null,
    scheduled_date: "2026-10-23",
    is_cancelled: false,
    has_canonical_completion: false,
    prescribed_work_ms: null,
    adherence_completed_work_blocks: null,
    adherence_prescribed_work_blocks: null,
  };
}

function fixture({
  authenticatedUser = user,
  userError = null,
  team = { id: validTeamId, name: "Falcons" },
  teamError = null,
  membership = { role: "coach" },
  membershipError = null,
  profile = { platform_role: null },
  profileError = null,
  rpcResponses = {},
} = {}) {
  const calls = { createClient: 0, events: [], rpc: [] };
  const responses = {
    teams: { data: team, error: teamError },
    team_memberships: { data: membership, error: membershipError },
    profiles: { data: profile, error: profileError },
  };
  const supabase = {
    auth: {
      getUser: async () => {
        calls.events.push("auth:getUser");
        return { data: { user: authenticatedUser }, error: userError };
      },
    },
    from: (table) => {
      calls.events.push(`from:${table}`);
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => responses[table],
      };
      return query;
    },
    rpc: async (name, args) => {
      calls.events.push(`rpc:${name}`);
      calls.rpc.push({ name, args });
      return rpcResponses[name] ?? { data: [attentionRow()], error: null };
    },
  };
  return {
    calls,
    loader: loadAttentionLoader(async () => {
      calls.createClient += 1;
      return supabase;
    }),
  };
}

test("anonymous valid team IDs redirect before any protected analytics request", async () => {
  const { calls, loader } = fixture({ authenticatedUser: null });

  await assert.rejects(loader(validTeamId), /REDIRECT:\/login/);
  assert.deepEqual(calls.rpc, []);
  assert.deepEqual(calls.events, ["auth:getUser"]);
});

test("malformed team IDs return not found before creating a database client", async () => {
  const { calls, loader } = fixture();

  await assert.rejects(loader("not-a-uuid"), /NOT_FOUND/);
  assert.equal(calls.createClient, 0);
  assert.deepEqual(calls.rpc, []);
});

test("authorized coach and admin access resolves before the first analytics RPC", async () => {
  for (const access of [
    { name: "coach", membership: { role: "coach" }, profile: { platform_role: null } },
    { name: "admin", membership: null, profile: { platform_role: "admin" } },
  ]) {
    const { calls, loader } = fixture(access);
    const result = await loader(validTeamId);
    const firstAnalyticsCall = calls.events.findIndex((event) => event.startsWith("rpc:"));

    assert.equal(result.team.name, "Falcons", access.name);
    assert.ok(firstAnalyticsCall > calls.events.lastIndexOf("from:profiles"), access.name);
    assert.deepEqual(calls.rpc.map(({ name }) => name), [
      "list_my_team_attention_sessions",
      "list_my_team_rostered_athlete_identities",
    ], access.name);
  }
});

test("authenticated non-members receive a non-disclosing not found without analytics data requests", async () => {
  const { calls, loader } = fixture({ membership: null, profile: { platform_role: null } });

  await assert.rejects(loader(validTeamId), /NOT_FOUND/);
  assert.deepEqual(calls.rpc, []);
});

test("authenticated requests for nonexistent teams receive a non-disclosing not found without analytics data requests", async () => {
  const { calls, loader } = fixture({ team: null });

  await assert.rejects(loader(validTeamId), /NOT_FOUND/);
  assert.deepEqual(calls.rpc, []);
});

test("authorized empty teams use the protected calendar anchor and return an empty state", async () => {
  const { calls, loader } = fixture({
    rpcResponses: {
      list_my_team_attention_sessions: { data: [], error: null },
      get_team_attention_as_of_date: { data: "2026-10-24", error: null },
      list_my_team_rostered_athlete_identities: { data: [], error: null },
    },
  });

  const result = await loader(validTeamId);

  assert.equal(result.asOfDate, "2026-10-24");
  assert.deepEqual(result.sessions, []);
  assert.deepEqual(result.athletes, []);
  assert.deepEqual(calls.rpc.map(({ name }) => name), [
    "list_my_team_attention_sessions",
    "get_team_attention_as_of_date",
    "list_my_team_rostered_athlete_identities",
  ]);
});

test("unexpected access and analytics failures stay sanitized server errors rather than authorization not found", async () => {
  for (const options of [
    { teamError: { message: "database unavailable" } },
    { rpcResponses: { list_my_team_attention_sessions: { data: null, error: { message: "RPC failed" } } } },
  ]) {
    const { calls, loader } = fixture(options);
    await assert.rejects(loader(validTeamId), /Unable to (?:validate team analytics access|load team attention analytics)\./);
    assert.doesNotMatch(calls.events.join(","), /NOT_FOUND/);
  }
});

test("dashboard, analytics, and adherence all converge on the guarded attention loader", () => {
  for (const page of [
    "../src/app/teams/[teamId]/page.tsx",
    "../src/app/teams/[teamId]/analytics/page.tsx",
    "../src/app/teams/[teamId]/adherence/page.tsx",
  ]) {
    const source = readFileSync(new URL(page, import.meta.url), "utf8");
    assert.match(source, /import \{ loadTeamAttentionAttendance \} from "@\/lib\/team-attendance-server"/);
    assert.match(source, /await loadTeamAttentionAttendance\(teamId\)/);
    assert.doesNotMatch(source, /list_my_team_attention_sessions|get_team_attention_as_of_date/);
  }
});
