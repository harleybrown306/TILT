import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const resumePage = readFileSync(new URL("../src/app/training-resume/page.tsx", import.meta.url), "utf8");
const resumeLoader = readFileSync(new URL("../src/lib/training-resume-server.ts", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
const training = readFileSync(new URL("../src/app/training/[sessionId]/page.tsx", import.meta.url), "utf8");
const storage = readFileSync(new URL("../src/lib/workout-session-storage.ts", import.meta.url), "utf8");

test("resume validates optional family athlete context and fails closed", () => {
  assert.match(resumePage, /searchParams: Promise<\{ athlete\?: string \}>/);
  assert.match(resumePage, /loadMyFamilyAthleteContexts\(\)/);
  assert.match(resumePage, /resolveActiveAthleteContext/);
  assert.match(resumePage, /status === "unauthorized_request" \|\| resolution\.status === "ambiguous_context"/);
  assert.match(resumePage, /status === "none"/);
});

test("resume ownership uses only validated durable athlete IDs", () => {
  assert.match(resumePage, /loadTrainingResumeForAthlete\(activeAthleteId\)/);
  assert.match(resumeLoader, /\.eq\("athlete_id", athleteId\)/);
  assert.match(resumeLoader, /workout_results\(id,training_session_id,athlete_id\)/);
  assert.match(resumeLoader, /workout_session_attempts\(workout_result_id,training_session_id,athlete_id/);
  assert.doesNotMatch(resumeLoader, /athlete_user_id/);
});

test("dashboard and resume preserve the durable context through their direct links", () => {
  assert.match(dashboard, /\/training-resume\?athlete=\$\{encodeURIComponent\(activeContext\.athleteId\)\}/);
  assert.match(resumePage, /\/\?athlete=\$\{encodeURIComponent\(activeAthleteId\)\}/);
  assert.doesNotMatch(`${dashboard}\n${resumePage}`, /localStorage|document\.cookie|cookies\(/);
});

test("training session ownership and ACT remain session-authoritative", () => {
  assert.match(training, /\.eq\("id", sessionId\)/);
  assert.match(training, /can_act_for_training_session/);
  assert.match(training, /athleteId=\{session\.athlete_id\}/);
  assert.doesNotMatch(training, /searchParams/);
});

test("workout recovery remains partitioned by authoritative durable athlete identity", () => {
  assert.match(storage, /keyPath: "athleteId"/);
  assert.match(storage, /mutateBundle\(athleteId/);
  assert.match(storage, /flushEvents\(athleteId/);
});
