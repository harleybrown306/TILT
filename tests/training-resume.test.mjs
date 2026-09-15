import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
const exerciseModule = { exports: {} };
new vm.Script(`(function(module,exports){${compile(readFileSync(new URL("../src/lib/exercise-adherence.ts", import.meta.url), "utf8"))}})`).runInThisContext()(exerciseModule, exerciseModule.exports);
const shiftDate = (date, days) => {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};
const resumeSource = readFileSync(new URL("../src/lib/training-resume.ts", import.meta.url), "utf8")
  .replace(/import\s*\{([\s\S]*?)\}\s*from "\.\/exercise-adherence";/, "const { aggregateExerciseAdherence } = require('./exercise-adherence');")
  .replace('import { shiftDate } from "./team-attendance";', "const { shiftDate } = require('./team-attendance');");
const resumeModule = { exports: {} };
new vm.Script(`(function(module,exports,require){${compile(resumeSource)}})`).runInThisContext()(
  resumeModule,
  resumeModule.exports,
  (name) => name === "./exercise-adherence" ? exerciseModule.exports : name === "./team-attendance" ? { shiftDate } : {},
);
const { trainingResumeSummary } = resumeModule.exports;
const today = "2026-09-15";

function session(id, date, overrides = {}) {
  const athleteUserId = "athlete-1";
  const result = { id: `result-${id}`, trainingSessionId: id, athleteUserId };
  const prescription = { sessionId: id, schemaVersion: 1, prescribedWorkMs: 60_000, stepCount: 1 };
  const attempt = {
    workoutResultId: result.id,
    trainingSessionId: id,
    athleteUserId,
    finalizationState: "finalized_completed",
    measurementVersion: 1,
    measurementQuality: "complete",
    prescribedStepCount: 1,
    completedWorkBlocks: 1,
    skippedWorkBlocks: 0,
  };
  return { id, athleteUserId, scheduledDate: date, result, prescription, attempts: [attempt], ...overrides };
}

test("no completed workouts returns zero counts and unavailable range", () => {
  const summary = trainingResumeSummary([], today);
  assert.deepEqual(summary.overview, { completedWorkouts: 0, trainingDays: 0, firstTrainingDate: null, latestTrainingDate: null });
  assert.equal(summary.prescribedTrainingTime.coverageRatio, null);
});

test("one canonical completed workout supplies overview and documented time", () => {
  const summary = trainingResumeSummary([session("a", "2026-09-14")], today);
  assert.equal(summary.overview.completedWorkouts, 1);
  assert.equal(summary.overview.trainingDays, 1);
  assert.equal(summary.prescribedTrainingTime.prescribedWorkMs, 60_000);
});

test("a completed status without a canonical result does not count", () => {
  const source = session("a", "2026-09-14", { result: null, attempts: [] });
  assert.equal(trainingResumeSummary([source], today).overview.completedWorkouts, 0);
});

test("multiple canonical workouts on one date count as one training day", () => {
  const summary = trainingResumeSummary([session("a", "2026-09-14"), session("b", "2026-09-14")], today);
  assert.equal(summary.overview.completedWorkouts, 2);
  assert.equal(summary.overview.trainingDays, 1);
});

test("distinct dates count as distinct training days", () => {
  assert.equal(trainingResumeSummary([session("a", "2026-09-13"), session("b", "2026-09-14")], today).overview.trainingDays, 2);
});

test("first and latest training dates are chronological", () => {
  const summary = trainingResumeSummary([session("a", "2025-12-31"), session("b", "2026-09-14"), session("c", "2026-01-01")], today);
  assert.equal(summary.overview.firstTrainingDate, "2025-12-31");
  assert.equal(summary.overview.latestTrainingDate, "2026-09-14");
});

test("prescribed time sums only covered completed sessions", () => {
  const covered = session("a", "2026-09-14");
  covered.prescription.prescribedWorkMs = 120_000;
  const uncovered = session("b", "2026-09-14", { prescription: null });
  assert.equal(trainingResumeSummary([covered, uncovered], today).prescribedTrainingTime.prescribedWorkMs, 120_000);
});

test("missing prescription never contributes zero time as covered", () => {
  const summary = trainingResumeSummary([session("a", "2026-09-14", { prescription: null })], today);
  assert.equal(summary.prescribedTrainingTime.coveredWorkoutCount, 0);
  assert.equal(summary.prescribedTrainingTime.uncoveredWorkoutCount, 1);
});

test("prescribed-time coverage counts are explicit", () => {
  const summary = trainingResumeSummary([session("a", "2026-09-14"), session("b", "2026-09-13", { prescription: null })], today);
  assert.deepEqual(summary.prescribedTrainingTime, { prescribedWorkMs: 60_000, coveredWorkoutCount: 1, uncoveredWorkoutCount: 1, totalCompletedWorkoutCount: 2, coverageRatio: 0.5 });
});

test("full prescription coverage is 100 percent", () => {
  assert.equal(trainingResumeSummary([session("a", "2026-09-14")], today).prescribedTrainingTime.coverageRatio, 1);
});

test("partial prescription coverage remains explicit", () => {
  assert.equal(trainingResumeSummary([session("a", "2026-09-14"), session("b", "2026-09-13", { prescription: null })], today).prescribedTrainingTime.coverageRatio, 0.5);
});

test("zero prescription coverage remains explicit", () => {
  assert.equal(trainingResumeSummary([session("c", "2026-09-12", { prescription: null })], today).prescribedTrainingTime.coverageRatio, 0);
});

test("monthly history groups completed workouts", () => {
  const records = trainingResumeSummary([session("a", "2026-09-14"), session("b", "2026-09-01"), session("c", "2026-08-31")], today).history.monthly;
  assert.deepEqual(records.map((record) => [record.period, record.completedWorkouts]), [["2026-08", 1], ["2026-09", 2]]);
});

test("monthly history counts distinct training days", () => {
  const record = trainingResumeSummary([session("a", "2026-09-14"), session("b", "2026-09-14")], today).history.monthly[0];
  assert.equal(record.trainingDays, 1);
});

test("monthly history retains prescription coverage", () => {
  const record = trainingResumeSummary([session("a", "2026-09-14"), session("b", "2026-09-13", { prescription: null })], today).history.monthly[0];
  assert.deepEqual([record.prescribedWorkMs, record.prescribedTimeCoveredWorkoutCount, record.prescribedTimeUncoveredWorkoutCount], [60_000, 1, 1]);
});

test("yearly history groups by scheduled year", () => {
  const records = trainingResumeSummary([session("a", "2025-12-31"), session("b", "2026-01-01")], today).history.yearly;
  assert.deepEqual(records.map((record) => record.period), ["2025", "2026"]);
});

test("current streak ends today", () => {
  assert.equal(trainingResumeSummary([session("a", "2026-09-15"), session("b", "2026-09-14")], today).streaks.current, 2);
});

test("current streak may end yesterday", () => {
  assert.equal(trainingResumeSummary([session("a", "2026-09-14"), session("b", "2026-09-13")], today).streaks.current, 2);
});

test("a broken current streak is zero", () => {
  assert.equal(trainingResumeSummary([session("a", "2026-09-13")], today).streaks.current, 0);
});

test("longest streak spans the complete canonical history", () => {
  const dates = ["2026-09-01", "2026-09-02", "2026-09-04", "2026-09-05", "2026-09-06"];
  assert.equal(trainingResumeSummary(dates.map((date, index) => session(String(index), date)), today).streaks.longest, 3);
});

test("multiple workouts on one day do not inflate streaks", () => {
  assert.equal(trainingResumeSummary([session("a", "2026-09-14"), session("b", "2026-09-14")], today).streaks.longest, 1);
});

test("qualifying exercise adherence reuses the Phase 9 aggregate", () => {
  const summary = trainingResumeSummary([session("a", "2026-09-14")], today);
  assert.equal(summary.exerciseAdherence.available, true);
  assert.equal(summary.exerciseAdherence.percentage, 100);
});

test("legacy adherence remains unavailable", () => {
  const legacy = session("a", "2026-09-14", { attempts: [] });
  assert.equal(trainingResumeSummary([legacy], today).exerciseAdherence.available, false);
});

test("partial adherence remains unavailable", () => {
  const partial = session("b", "2026-09-13"); partial.attempts[0].measurementQuality = "partial";
  assert.equal(trainingResumeSummary([partial], today).exerciseAdherence.available, false);
});

test("unknown adherence remains unavailable", () => {
  const unknown = session("c", "2026-09-12"); unknown.attempts[0].measurementQuality = "unknown";
  const adherence = trainingResumeSummary([unknown], today).exerciseAdherence;
  assert.equal(adherence.available, false);
  assert.equal(adherence.unavailableSessionCount, 1);
});

test("lifetime adherence is weighted across eligible sessions", () => {
  const first = session("a", "2026-09-14"); first.attempts[0].prescribedStepCount = 10; first.attempts[0].completedWorkBlocks = 9; first.attempts[0].skippedWorkBlocks = 1; first.prescription.stepCount = 10;
  const second = session("b", "2026-09-13"); second.attempts[0].prescribedStepCount = 2; second.attempts[0].completedWorkBlocks = 1; second.attempts[0].skippedWorkBlocks = 1; second.prescription.stepCount = 2;
  const adherence = trainingResumeSummary([first, second], today).exerciseAdherence;
  assert.deepEqual([adherence.completedBlocks, adherence.prescribedBlocks, adherence.ratio], [10, 12, 10 / 12]);
});

test("unavailable adherence sessions stay out of denominator but count for coverage", () => {
  const summary = trainingResumeSummary([session("a", "2026-09-14"), session("b", "2026-09-13", { attempts: [] })], today).exerciseAdherence;
  assert.deepEqual([summary.completedBlocks, summary.prescribedBlocks, summary.eligibleSessionCount, summary.unavailableSessionCount], [1, 1, 1, 1]);
});

test("eligible zero completed blocks remains zero percent", () => {
  const zero = session("a", "2026-09-14"); zero.attempts[0].completedWorkBlocks = 0; zero.attempts[0].skippedWorkBlocks = 1;
  assert.equal(trainingResumeSummary([zero], today).exerciseAdherence.percentage, 0);
});

test("zero eligible adherence denominator is unavailable", () => {
  assert.equal(trainingResumeSummary([session("a", "2026-09-14", { attempts: [] })], today).exerciseAdherence.available, false);
});

test("resume inputs and metrics have no raw telemetry or verified activity claims", () => {
  const source = readFileSync(new URL("../src/lib/training-resume.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /workout_session_events|pause|hidden|visibility|active training|verified training|physical activity/i);
  assert.match(source, /prescribedWorkMs/);
});
