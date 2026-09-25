import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const pagePath = "src/app/teams/[teamId]/athletes/[athleteId]/page.tsx";
const teamId = "00000000-0000-4000-8000-000000000101";
const athleteId = "00000000-0000-4000-8000-000000000201";
const profileId = "00000000-0000-4000-8000-000000000301";

function loadPage(mocks) {
  const source = ts.transpileModule(readFileSync(root + pagePath, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const loaded = { exports: {} };
  const run = new vm.Script(`(function(require,module,exports){${source}\n})`).runInThisContext();
  run((name) => name in mocks ? mocks[name] : require(name), loaded, loaded.exports);
  return loaded.exports.default;
}

function fixture({ roster = "coach-allowed" } = {}) {
  const calls = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: profileId } } }) },
    rpc(name, payload) {
      calls.push({ kind: "rpc", name, payload });
      if (roster.endsWith("-denied")) return Promise.resolve({ data: null, error: { message: `${roster} denied` } });
      if (roster === "other-team") return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: [{ athlete_id: athleteId, display_name: "Durable athlete" }], error: null });
    },
    from(table) {
      const filters = [];
      let single = false;
      const query = {
        select() { return query; },
        eq(column, value) { filters.push([column, value]); return query; },
        order() { return query; },
        single() { single = true; return query; },
        then(resolve, reject) {
          calls.push({ kind: "read", table, filters });
          const data = table === "teams"
            ? { id: teamId, name: "Team" }
            : [];
          return Promise.resolve({ data: single ? data : data, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const mocks = {
    "@/lib/supabase/server": { createClient: async () => client },
    "next/navigation": {
      redirect: (path) => { throw Error(`REDIRECT:${path}`); },
      notFound: () => { throw Error("NOT_FOUND"); },
    },
    "next/link": { default: () => null },
    "@/lib/athlete-exercise-adherence": { athleteExerciseAdherenceInput: () => ({ result: null, attempt: null, prescription: null }) },
    "@/lib/exercise-adherence": {
      calculateExerciseAdherence: () => ({ available: false, completedBlocks: null, prescribedBlocks: null, skippedBlocks: null, ratio: null, percentage: null }),
    },
  };
  return { calls, page: loadPage(mocks) };
}

async function open(fixture) {
  return fixture.page({ params: Promise.resolve({ teamId, athleteId }) });
}

for (const [viewer, roster] of [["coach", "coach-allowed"], ["assistant coach", "assistant-allowed"], ["platform admin", "admin-allowed"]]) {
  test(`${viewer} can view a durably rostered team athlete through the analytics roster boundary`, async () => {
    const current = fixture({ roster });
    await open(current);
    assert.deepEqual(current.calls.find((call) => call.kind === "rpc"), {
      kind: "rpc",
      name: "list_my_team_rostered_athlete_identities",
      payload: { p_team_id: teamId },
    });
    const sessionRead = current.calls.find((call) => call.table === "training_sessions");
    assert.deepEqual(sessionRead.filters, [["team_id", teamId], ["athlete_id", athleteId]]);
  });
}

for (const [viewer, roster] of [["unrelated coach", "unrelated-denied"], ["guardian-only account", "guardian-denied"], ["self-only athlete", "self-denied"]]) {
  test(`${viewer} is denied before the detail route reads sessions`, async () => {
    const current = fixture({ roster });
    await assert.rejects(open(current), /NOT_FOUND/);
    assert.equal(current.calls.some((call) => call.table === "training_sessions"), false);
  });
}

test("an athlete not on the requested team is denied before the detail route reads sessions", async () => {
  const current = fixture({ roster: "other-team" });
  await assert.rejects(open(current), /NOT_FOUND/);
  assert.equal(current.calls.some((call) => call.table === "training_sessions"), false);
});

test("viewing athlete detail introduces no mutation operation or legacy identity equality check", async () => {
  const current = fixture();
  await open(current);
  assert.ok(profileId !== athleteId);
  assert.ok(current.calls.every((call) => call.kind === "rpc" || call.kind === "read"));
  const source = readFileSync(root + pagePath, "utf8");
  assert.doesNotMatch(source, /team_memberships|platform_role/);
  assert.doesNotMatch(source, /user\.id\s*===\s*athleteId|athleteId\s*===\s*user\.id/);
  assert.match(source, /list_my_team_rostered_athlete_identities/);
  assert.ok(source.indexOf("if (athleteError || !athlete)") < source.indexOf('.from("training_sessions")'));
});
