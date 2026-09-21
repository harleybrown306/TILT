import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../src/app/training-resume/page.tsx", import.meta.url), "utf8");
const loader = readFileSync(new URL("../src/lib/training-resume-server.ts", import.meta.url), "utf8");

test("unauthenticated resume access redirects through the existing login behavior", () => {
  assert.match(loader, /if \(!user\) redirect\("\/login"\)/);
});

test("resume query is scoped to the authenticated athlete", () => {
  assert.match(loader, /\.eq\("athlete_user_id", user\.id\)/);
});

test("canonical result identity maps into the resume helper input", () => {
  assert.match(loader, /trainingSessionId: result\.training_session_id/);
  assert.match(loader, /athleteId: result\.athlete_user_id/);
});

test("session status is not used as resume completion truth", () => {
  assert.doesNotMatch(loader, /status/);
});

test("lifetime query pages rather than relying on a default row limit", () => {
  assert.match(loader, /const PAGE_SIZE = 1_000/);
  assert.match(loader, /for \(let from = 0; ; from \+= PAGE_SIZE\)/);
  assert.match(loader, /\.range\(from, from \+ PAGE_SIZE - 1\)/);
});

test("resume query does not fetch raw telemetry events", () => {
  assert.doesNotMatch(loader, /workout_session_events/);
  assert.doesNotMatch(page, /workout_session_events/);
});

test("overview displays completed workouts", () => assert.match(page, /Completed Workouts/));
test("overview displays training days", () => assert.match(page, /Training Days/));
test("overview displays the current streak", () => assert.match(page, /Current Streak/));
test("overview displays the longest streak", () => assert.match(page, /Longest Streak/));

test("documented prescribed time formats milliseconds in the UI", () => {
  assert.match(page, /function formatDuration/);
  assert.match(page, /Documented Prescribed Training Time/);
  assert.match(page, /formatDuration\(prescribedTrainingTime\.prescribedWorkMs\)/);
});

test("partial prescription coverage is visible", () => {
  assert.match(page, /Documented for \$\{prescribedTrainingTime\.coveredWorkoutCount\} of \$\{prescribedTrainingTime\.totalCompletedWorkoutCount\} completed workouts/);
});

test("uncovered workouts are not displayed as zero-time coverage", () => {
  assert.match(page, /coveredWorkoutCount === prescribedTrainingTime\.totalCompletedWorkoutCount/);
  assert.doesNotMatch(page, /uncovered.*0 time/i);
});

test("qualifying adherence displays its weighted percentage", () => {
  assert.match(page, /Math\.round\(exerciseAdherence\.percentage\)/);
});

test("adherence displays authoritative block counts", () => {
  assert.match(page, /exerciseAdherence\.completedBlocks\} of \{exerciseAdherence\.prescribedBlocks\} prescribed work blocks completed/);
});

test("adherence displays qualifying-session coverage", () => {
  assert.match(page, /eligibleSessionCount\} of \{exerciseAdherence\.eligibleSessionCount \+ exerciseAdherence\.unavailableSessionCount\} completed workouts have qualifying adherence data/);
});

test("unavailable adherence displays N/A", () => assert.match(page, />N\/A</));

test("eligible zero adherence is not converted to N/A", () => {
  assert.match(page, /exerciseAdherence\.available \? \(/);
  assert.doesNotMatch(page, /percentage \? .*N\/A/);
});

test("monthly history displays workout and training-day counts", () => {
  assert.match(page, /record\.completedWorkouts\} completed workouts/);
  assert.match(page, /record\.trainingDays\} training days/);
});

test("monthly partial prescribed-time coverage is represented honestly", () => {
  assert.match(page, /record\.prescribedTimeCoveredWorkoutCount !== record\.completedWorkouts/);
  assert.match(page, /Documented for \{record\.prescribedTimeCoveredWorkoutCount\} of \{record\.completedWorkouts\} completed workouts/);
});

test("page avoids active and verified training-time labels", () => {
  assert.doesNotMatch(page, /Active Training Time|Verified Training Time/);
});

test("explanatory copy declines physical activity verification", () => {
  assert.match(page, /does not verify physical effort or activity/);
});

test("page does not add team category skill or position distributions", () => {
  assert.doesNotMatch(page, /Teams\/Programs|Category Distribution|Skill Distribution|Position Distribution/);
});

test("page does not add attendance adherence", () => assert.doesNotMatch(page, /Attendance Adherence/));

test("page adds no public or share-token architecture", () => {
  assert.doesNotMatch(page, /share|token|public/i);
  assert.doesNotMatch(loader, /share|token|public/i);
});
