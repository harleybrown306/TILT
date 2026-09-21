import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const athleteId = "00000000-0000-4000-8000-000000000013";
const idle = { status: "idle", message: "" };

function loadTs(path, mocks) {
  const source = ts.transpileModule(readFileSync(root + path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  new vm.Script(`(function(require,module,exports){${source}\n})`).runInThisContext()(
    (name) => name in mocks ? mocks[name] : require(name), loaded, loaded.exports,
  );
  return loaded.exports;
}

function form({ firstName = "Child", lastName = "Athlete", graduationYear = "2031" } = {}) {
  const data = new FormData();
  if (firstName !== null) data.set("firstName", firstName);
  if (lastName !== null) data.set("lastName", lastName);
  if (graduationYear !== null) data.set("graduationYear", graduationYear);
  data.set("actorId", "browser-controlled-actor");
  data.set("athleteId", "browser-controlled-athlete");
  return data;
}

function setup({ signedOut = false, rpc = { data: athleteId, error: null, status: 200 } } = {}) {
  const calls = [];
  const action = loadTs("src/app/athletes/new/actions.ts", {
    "@/lib/supabase/server": { createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: signedOut ? null : { id: "authenticated-profile" } }, error: null }) },
      rpc: async (name, args) => { calls.push({ name, args }); return rpc; },
    }) },
    "@/lib/training-assignment": { isUuid: (value) => value === athleteId },
    "next/cache": { revalidatePath: () => {} },
    "next/navigation": { redirect: (path) => { throw Error(`REDIRECT:${path}`); } },
  }).addAthlete;
  return { action, calls };
}

for (const [label, fields] of [
  ["first name", { firstName: "   " }],
  ["last name", { lastName: "   " }],
  ["graduation year", { graduationYear: null }],
  ["invalid graduation year", { graduationYear: "1999" }],
  ["non-integer graduation year", { graduationYear: "2031.5" }],
]) test(`${label} is rejected before any RPC`, async () => {
  const fixture = setup();
  assert.equal((await fixture.action(idle, form(fields))).status, "error");
  assert.equal(fixture.calls.length, 0);
});

test("creation calls only the canonical three-argument RPC and redirects to its durable athlete ID", async () => {
  const fixture = setup();
  await assert.rejects(fixture.action(idle, form()), new RegExp(`REDIRECT:/\\?athlete=${athleteId}`));
  assert.deepEqual(fixture.calls, [{ name: "create_my_athlete", args: {
    p_first_name: "Child", p_last_name: "Athlete", p_graduation_year: 2031,
  } }]);
});

test("browser actor and athlete IDs are not accepted as creation authority or identity", async () => {
  const fixture = setup();
  await assert.rejects(fixture.action(idle, form()), /REDIRECT:/);
  assert.equal(JSON.stringify(fixture.calls), JSON.stringify([{ name: "create_my_athlete", args: {
    p_first_name: "Child", p_last_name: "Athlete", p_graduation_year: 2031,
  } }]));
});

test("signed-out and uncertain RPC responses fail safely", async () => {
  const signedOut = setup({ signedOut: true });
  assert.equal((await signedOut.action(idle, form())).status, "error");
  assert.equal(signedOut.calls.length, 0);
  const uncertain = setup({ rpc: { data: null, error: { message: "timeout" }, status: 503 } });
  assert.equal((await uncertain.action(idle, form())).status, "review_required");
});

test("family dashboard exposes Add athlete without changing the canonical fail-closed resolver", () => {
  const dashboard = readFileSync(root + "src/app/page.tsx", "utf8");
  assert.match(dashboard, /href="\/athletes\/new"[\s\S]*Add athlete/);
  assert.match(dashboard, /resolveActiveAthleteContext\(familyContexts, requestedAthleteId\)/);
  assert.match(dashboard, /Training profile unavailable/);
});

test("form and action avoid direct persistence and legacy athletes retain dashboard display-name compatibility", () => {
  const action = readFileSync(root + "src/app/athletes/new/actions.ts", "utf8");
  const formSource = readFileSync(root + "src/app/athletes/new/athlete-form.tsx", "utf8");
  const contexts = readFileSync(root + "src/lib/my-athlete-contexts-server.ts", "utf8");
  assert.match(action, /rpc\("create_my_athlete"/);
  assert.doesNotMatch(action, /\.from\("athletes"|\.from\("athlete_profile_relationships"|service_role/);
  assert.match(formSource, /name="firstName"[\s\S]*name="lastName"[\s\S]*name="graduationYear"/);
  assert.match(formSource, /min="2000" max="2100"/);
  assert.match(contexts, /displayName: athlete\.display_name/);
});

test("team roster creation remains its existing separate managed-athlete flow", () => {
  const roster = readFileSync(root + "src/app/teams/[teamId]/roster/actions.ts", "utf8");
  assert.match(roster, /export async function createManagedAthlete/);
  assert.match(roster, /requireRosterManager\(teamId\)/);
});
