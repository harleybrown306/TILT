import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const training = readFileSync(new URL("../src/app/training/[sessionId]/page.tsx", import.meta.url), "utf8");
const player = readFileSync(new URL("../src/components/workout/workout-player.tsx", import.meta.url), "utf8");

test("training derives its dashboard return context only from the authoritative durable session athlete", () => {
  assert.match(training, /const dashboardHref = session\.athlete_id[\s\S]*encodeURIComponent\(session\.athlete_id\)/);
  assert.match(training, /const backHref = canActForTraining[\s\S]*\? dashboardHref/);
  const dashboardContext = training.slice(training.indexOf("const dashboardHref"), training.indexOf("const backHref"));
  assert.doesNotMatch(dashboardContext, /user\.id|athlete_user_id|searchParams|localStorage|document\.cookie/);
});

test("training remains session-authoritative and completion does not reconstruct an athlete context", () => {
  assert.match(training, /\.eq\("id", sessionId\)/);
  assert.match(training, /can_act_for_training_session/);
  assert.doesNotMatch(training, /searchParams/);
  assert.match(player, /completeTrainingSession\(supabase, sessionId\)/);
  assert.doesNotMatch(player, /router\.push\([^\n]*athlete|athleteId=\{user\.id\}/);
});
