import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const page = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
const require = createRequire(import.meta.url);

function loadTs(path, mocks = {}) {
  const source = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  new vm.Script(`(function(require,module,exports){${source}\n})`).runInThisContext()(
    (name) => name in mocks ? mocks[name] : name === "@/lib/operational-log" ? { createOperationalReference: () => "reference", logOperationalFailure: () => {} } : require(name), loaded, loaded.exports,
  );
  return loaded.exports;
}

const contextModule = loadTs("src/lib/my-athlete-contexts-server.ts", {
  "server-only": {},
  "next/navigation": { redirect: () => { throw Error("unexpected redirect"); } },
  "@/lib/supabase/server": { createClient: async () => { throw Error("context loader is not used by this render fixture"); } },
});

const context = (athleteId, relationshipRole, displayName) => ({
  athleteId,
  displayName,
  graduationYear: null,
  relationshipRole,
  canManage: false,
  canAct: false,
});

function dashboardFixture({ profileId, contexts, memberships = [], requestedAthleteId, access } = {}) {
  const calls = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: profileId, email: "user@example.test" } }, error: null }) },
    from(table) {
      const filters = [];
      const query = {
        select() { return query; },
        eq(field, value) { filters.push([field, value]); return query; },
        order() { return query; },
        single() { return query; },
        then(resolve, reject) {
          calls.push({ table, filters });
          const data = table === "profiles"
            ? { full_name: "Test User", platform_role: "user" }
            : table === "team_memberships"
              ? memberships
              : [];
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const dashboard = loadTs("src/app/page.tsx", {
    "next/link": { default: (props) => React.createElement("a", props) },
    "next/navigation": { redirect: (path) => { throw Error(`REDIRECT:${path}`); } },
    "@/components/sign-out-button": { default: () => null },
    "@/lib/supabase/server": { createClient: async () => client },
    "@/lib/my-athlete-contexts-server": {
      loadMyFamilyAthleteContexts: async () => contexts,
      resolveActiveAthleteContext: contextModule.resolveActiveAthleteContext,
    },
    "@/lib/team-attendance": {
      localDate: () => "2026-10-04",
      shiftDate: (date) => date,
      formatScheduledDate: (date) => date,
      attendanceStatus: () => "pending",
    },
    "@/lib/athlete-dashboard": {
      activityBuckets: () => [],
      athleteDashboardMetrics: () => ({ weeklyWorkMs: 0, monthlyWorkMs: 0, totalCompletedWorkouts: 0, trainingDays: 0, currentStreak: 0 }),
      displayMinutes: () => 0,
      isCompleted: () => false,
    },
    "@/lib/athlete-exercise-adherence": { athleteExerciseAdherenceInput: () => ({}) },
    "@/lib/exercise-adherence": {
      aggregateExerciseAdherence: () => ({ available: false, completedBlocks: 0, prescribedBlocks: 0, unavailableSessionCount: 0, eligibleSessionCount: 0, percentage: 0 }),
      calculateExerciseAdherence: () => ({ available: false, completedBlocks: 0, prescribedBlocks: 0, percentage: 0 }),
    },
  }).default;
  return {
    render: async () => renderToStaticMarkup(await dashboard({ searchParams: Promise.resolve({ ...(requestedAthleteId ? { athlete: requestedAthleteId } : {}), ...(access ? { access } : {}) }) })),
    trainingQueryIds: () => calls.filter((call) => call.table === "training_sessions").flatMap((call) => call.filters.filter(([field]) => field === "athlete_id").map(([, value]) => value)),
  };
}

test("home validates the optional athlete URL request through the canonical family resolver", () => {
  assert.match(page, /searchParams: Promise<\{ athlete\?: string; access\?: string \}>/);
  assert.match(page, /loadMyFamilyAthleteContexts\(\)/);
  assert.match(page, /resolveActiveAthleteContext\(familyContexts, requestedAthleteId\)/);
});

test("home queries dashboard sessions by resolved durable athlete identity, never actor identity", () => {
  assert.match(page, /\.eq\("athlete_id", activeContext\.athleteId\)/);
  assert.doesNotMatch(page, /\.eq\("athlete_user_id", user\.id\)/);
  assert.match(page, /athleteId: row\.athlete_id/);
});

test("unauthorized and ambiguous requests fail closed without athlete dashboard data", () => {
  assert.match(page, /athleteResolution\.status === "unauthorized_request" \|\| athleteResolution\.status === "ambiguous_context"/);
  assert.match(page, /Training profile unavailable/);
  assert.match(page, /Return to dashboard/);
});

test("multiple contexts render an accessible durable-athlete selector", () => {
  assert.match(page, /familyContexts\.length > 1/);
  assert.match(page, /aria-label="Training profile"/);
  assert.match(page, /\/?athlete=\$\{encodeURIComponent\(context\.athleteId\)\}/);
  assert.match(page, /context\.displayName/);
  assert.match(page, /context\.relationshipRole === "self" \? "Your training" : "Guardian view"/);
  assert.match(page, /aria-current=\{context\.athleteId === activeContext\.athleteId \? "page" : undefined\}/);
});

test("dashboard describes SELF and guardian context without treating profile identity as athlete identity", () => {
  assert.match(page, /activeContext\.relationshipRole === "self" \? "Your training" : `Viewing \$\{activeContext\.displayName\} as guardian`/);
  assert.match(page, /You are viewing your own training context\./);
  assert.match(page, /You are viewing \$\{activeContext\.displayName\}'s training as their guardian\./);
  assert.match(page, /\.eq\("athlete_id", activeContext\.athleteId\)/);
  assert.doesNotMatch(page, /profile\.id\s*===\s*athlete\.id|user\.id\s*===\s*activeContext\.athleteId/);
});

test("zero contexts stay on the account dashboard without a misleading athlete training action", () => {
  assert.match(page, /activeContext && \(/);
  assert.match(page, /Training is not set up yet/);
  assert.match(page, /Team membership by itself does not create training access\./);
  assert.match(page, /membership\.role === "athlete" && !activeContext/);
  assert.match(page, /Open team management dashboard/);
  assert.doesNotMatch(page, /View your assigned training/);
  assert.doesNotMatch(page, /canAct\s*:\s*true|canActForTraining\s*=\s*true/);
  assert.doesNotMatch(page, /localStorage|cookies\(|document\.cookie/);
});

test("SELF dashboard rendering uses the selected durable athlete instead of the authenticated profile", async () => {
  const profileId = "PROFILE_A";
  const athleteId = "ATHLETE_A";
  const fixture = dashboardFixture({
    profileId,
    contexts: [context(athleteId, "self", "Alex Athlete")],
  });

  const markup = await fixture.render();
  assert.ok(markup.includes("Your training") && markup.includes("Your training today"));
  assert.deepEqual(fixture.trainingQueryIds(), [athleteId]);
  assert.notEqual(athleteId, profileId);
  assert.ok(!fixture.trainingQueryIds().includes(profileId));
});

test("guardian dashboard rendering identifies the child and queries the child's durable athlete ID", async () => {
  const profileId = "PROFILE_G";
  const athleteId = "ATHLETE_CHILD";
  const fixture = dashboardFixture({
    profileId,
    contexts: [context(athleteId, "guardian", "Casey Child")],
  });

  const markup = await fixture.render();
  assert.ok(markup.includes("Viewing Casey Child as guardian") && markup.includes("Casey Child") && markup.includes("training today"));
  assert.deepEqual(fixture.trainingQueryIds(), [athleteId]);
  assert.ok(!fixture.trainingQueryIds().includes(profileId));
});

test("completed family-access handoffs confirm only the selected authorized context", async () => {
  const self = dashboardFixture({ profileId: "PROFILE_A", contexts: [context("ATHLETE_A", "self", "Alex Athlete")], requestedAthleteId: "ATHLETE_A", access: "child-login-claimed" });
  assert.match(await self.render(), /Child login is active/);

  const guardian = dashboardFixture({ profileId: "PROFILE_G", contexts: [context("ATHLETE_CHILD", "guardian", "Casey Child")], requestedAthleteId: "ATHLETE_CHILD", access: "guardian-invitation-accepted" });
  assert.match(await guardian.render(), /Guardian access is active/);
});

test("family-management authorization loss gives a generic recovery message without selecting family data", async () => {
  const fixture = dashboardFixture({ profileId: "PROFILE_G", contexts: [], access: "family-management-unavailable" });
  const markup = await fixture.render();
  assert.match(markup, /You no longer have permission to manage that family access/);
  assert.doesNotMatch(markup, /Casey Child|Alex Athlete/);
  assert.deepEqual(fixture.trainingQueryIds(), []);
});

test("multiple accessible contexts render selected context, role labels, and durable-ID navigation", async () => {
  const selfAthleteId = "ATHLETE_A";
  const childAthleteId = "ATHLETE_CHILD";
  const fixture = dashboardFixture({
    profileId: "PROFILE_A",
    requestedAthleteId: childAthleteId,
    contexts: [
      context(selfAthleteId, "self", "Alex Athlete"),
      context(childAthleteId, "guardian", "Casey Child"),
    ],
  });

  const markup = await fixture.render();
  assert.ok(markup.includes("Viewing Casey Child as guardian"));
  assert.ok(markup.includes("Alex Athlete") && markup.includes("Casey Child"));
  assert.ok(markup.includes("Your training") && markup.includes("Guardian view"));
  assert.ok(markup.includes(`href="/?athlete=${selfAthleteId}"`) && markup.includes(`href="/?athlete=${childAthleteId}"`));
  assert.deepEqual(fixture.trainingQueryIds(), [childAthleteId]);
});

test("team-only users render setup guidance without athlete training navigation and retain staff access", async () => {
  const fixture = dashboardFixture({
    profileId: "PROFILE_STAFF",
    contexts: [],
    memberships: [
      { id: "member-athlete", role: "athlete", team_id: "TEAM_ATHLETE", teams: { id: "TEAM_ATHLETE", name: "Athlete Team" } },
      { id: "member-coach", role: "coach", team_id: "TEAM_STAFF", teams: { id: "TEAM_STAFF", name: "Staff Team" } },
    ],
  });

  const markup = await fixture.render();
  assert.ok(markup.includes("Training is not set up yet") && markup.includes("Team membership by itself does not create training access."));
  assert.ok(!markup.includes("Open current training context") && !markup.includes('href="/#athlete-training"'));
  assert.ok(markup.includes("Open team management dashboard") && markup.includes('href="/teams/TEAM_STAFF"'));
  assert.deepEqual(fixture.trainingQueryIds(), []);
});
