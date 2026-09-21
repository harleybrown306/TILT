import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const compile = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const attendance = { exports: {} };
new vm.Script(`(function(module,exports){${compile("../src/lib/team-attendance.ts")}})`).runInThisContext()(attendance, attendance.exports);
const exercise = { exports: {} };
new vm.Script(`(function(module,exports){${compile("../src/lib/exercise-adherence.ts")}})`).runInThisContext()(exercise, exercise.exports);
const signals = { exports: {} };
const source = compile("../src/lib/coach-attention-signals.ts").replace(/require\("\.\/exercise-adherence"\)/g, "require('./exercise-adherence')").replace(/require\("\.\/team-attendance"\)/g, "require('./team-attendance')");
new vm.Script(`(function(module,exports,require){${source}})`).runInThisContext()(signals, signals.exports, (name) => name === "./exercise-adherence" ? exercise.exports : attendance.exports);
const { deriveCoachAttentionSignals } = signals.exports;
const today = "2026-09-21";
const input = (sessions) => ({ sessions, today });
const session = (id, date, overrides = {}) => ({ id, athleteId: "child-1", athleteName: "Child", scheduledDate: date, storedStatus: "scheduled", workoutName: "TILT", completedAt: null, prescribedWorkMs: null, ...overrides });
const complete = (id, date, overrides = {}) => session(id, date, { storedStatus: "completed", completedAt: `${date}T18:00:00Z`, ...overrides });
const adherence = (id, date, completedBlocks, prescribedBlocks) => complete(id, date, { exerciseAdherenceInput: { result: { id: `r-${id}`, trainingSessionId: id, athleteId: "child-1" }, attempt: { workoutResultId: `r-${id}`, trainingSessionId: id, athleteId: "child-1", finalizationState: "finalized_completed", measurementVersion: 1, measurementQuality: "complete", prescribedStepCount: prescribedBlocks, completedWorkBlocks: completedBlocks, skippedWorkBlocks: prescribedBlocks - completedBlocks }, prescription: { sessionId: id, schemaVersion: 1, stepCount: prescribedBlocks } } });
const kinds = (rows) => deriveCoachAttentionSignals(input(rows)).map((item) => item.kind);

test("closed windows exclude today and future sessions, and cancelled sessions", () => {
  const result = deriveCoachAttentionSignals(input([session("old", "2026-09-14"), session("today", today), session("future", "2026-09-22"), session("cancel", "2026-09-20", { storedStatus: "cancelled" })]));
  assert.deepEqual(result.filter((item) => item.kind === "recent_missed_training").map((item) => item.affectedSessionCount), [1]);
});
test("late canonical completion remains completed in its scheduled-date window", () => assert.ok(kinds([complete("late-a", "2026-09-20", { completedAt: "2026-09-21T04:00:00Z" }), complete("late-b", "2026-09-19", { completedAt: "2026-09-21T04:00:00Z" })]).includes("completion_consistency")));
test("durable no-login child identity produces factual signals", () => assert.equal(deriveCoachAttentionSignals(input([session("miss", "2026-09-20", { athleteId: "child-no-login" })]))[0].athleteId, "child-no-login"));
test("adherence is N/A with fewer than two eligible sessions per closed window", () => assert.ok(!kinds([adherence("a", "2026-09-20", 1, 2), adherence("b", "2026-09-13", 2, 2), adherence("c", "2026-09-12", 2, 2)]).includes("exercise_adherence_change")));
test("adherence change is weighted by prescribed work blocks", () => {
  const result = deriveCoachAttentionSignals(input([adherence("a", "2026-09-20", 1, 2), adherence("b", "2026-09-19", 9, 10), adherence("c", "2026-09-13", 2, 10), adherence("d", "2026-09-12", 2, 10)]));
  assert.match(result.find((item) => item.kind === "exercise_adherence_change").text, /20% to 83%/);
});
test("bounded contract exposes only the three team-scoped signal kinds", () => {
  const result = kinds([complete("a", "2026-09-20"), complete("b", "2026-09-19"), session("miss", "2026-09-18")]);
  assert.ok(result.every((kind) => ["recent_missed_training", "completion_consistency", "exercise_adherence_change"].includes(kind)));
  assert.doesNotMatch(readFileSync(new URL("../src/lib/coach-attention-signals.ts", import.meta.url), "utf8"), /first_tilt_completion|return_to_completed_training/);
});
test("a completed status without a canonical result is not a completion", () => {
  const result = kinds([session("status-only", "2026-09-20", { storedStatus: "completed" })]);
  assert.ok(result.includes("recent_missed_training")); assert.ok(!result.includes("completion_consistency"));
});
test("completion consistency requires at least two expected sessions", () => {
  assert.ok(!kinds([]).includes("completion_consistency"));
  assert.ok(!kinds([complete("one", "2026-09-20")]).includes("completion_consistency"));
  assert.ok(kinds([complete("one", "2026-09-20"), complete("two", "2026-09-19")]).includes("completion_consistency"));
});
test("duplicate session rows do not duplicate canonical completion signals", () => assert.equal(kinds([complete("same", "2026-09-20"), complete("same", "2026-09-20"), complete("other", "2026-09-19")]).filter((kind) => kind === "completion_consistency").length, 1));
test("ordering is date, affected-session count, percentage-point change, then stable athlete identity", () => {
  const result = deriveCoachAttentionSignals(input([session("a", "2026-09-20", { athleteId: "z" }), session("b", "2026-09-20", { athleteId: "a" }), session("c", "2026-09-19", { athleteId: "a" })]));
  assert.deepEqual(result.filter((item) => item.kind === "recent_missed_training").map((item) => item.athleteId), ["a", "z"]);
});
test("factual positive and negative attendance observations can coexist", () => {
  const result = kinds([complete("done", "2026-09-20"), session("miss", "2026-09-19")]);
  assert.ok(result.includes("recent_missed_training")); assert.ok(!result.includes("completion_consistency"));
  assert.ok(kinds([complete("done-a", "2026-09-20"), complete("done-b", "2026-09-19")]).includes("completion_consistency"));
});
