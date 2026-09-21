import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
const modules = {};
const require = (name) => {
  if (name !== "./exercise-adherence") throw new Error(`Unexpected module: ${name}`);
  return modules.exercise;
};
const exerciseModule = { exports: {} };
new vm.Script(`(function(module,exports,require){${compile(readFileSync(new URL("../src/lib/exercise-adherence.ts", import.meta.url), "utf8"))}})`).runInThisContext()(exerciseModule, exerciseModule.exports, require);
modules.exercise = exerciseModule.exports;
const mappingSource = readFileSync(new URL("../src/lib/athlete-exercise-adherence.ts", import.meta.url), "utf8")
  .replace(/import\s*\{([\s\S]*?)\}\s*from "\.\/exercise-adherence";/, "const { calculateExerciseAdherence } = require('./exercise-adherence');");
const mappingModule = { exports: {} };
new vm.Script(`(function(module,exports,require){${compile(mappingSource)}})`).runInThisContext()(mappingModule, mappingModule.exports, require);
const { athleteExerciseAdherence, athleteExerciseAdherenceInput } = mappingModule.exports;

function row(overrides = {}) {
  const result = { id: "result-1", trainingSessionId: "session-1", athleteId: "athlete-1" };
  return {
    sessionId: "session-1",
    athleteId: "athlete-1",
    result,
    attempts: [{
      workoutResultId: result.id,
      trainingSessionId: result.trainingSessionId,
      athleteId: result.athleteId,
      finalizationState: "finalized_completed",
      measurementVersion: 1,
      measurementQuality: "complete",
      prescribedStepCount: 10,
      completedWorkBlocks: 9,
      skippedWorkBlocks: 1,
    }],
    prescription: { sessionId: "session-1", schemaVersion: 1, stepCount: 10 },
    ...overrides,
  };
}

test("coach athlete history renders authoritative block counts and display rounding", () => {
  const adherence = athleteExerciseAdherence(row());
  assert.equal(adherence.available, true);
  assert.equal(adherence.completedBlocks, 9);
  assert.equal(adherence.prescribedBlocks, 10);
  assert.equal(adherence.percentage, 90);
  const page = readFileSync(new URL("../src/app/teams/[teamId]/athletes/[athleteId]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /Exercise adherence: \$\{session\.exerciseAdherence\.completedBlocks\} of \$\{session\.exerciseAdherence\.prescribedBlocks\} prescribed work blocks completed/);
  assert.match(page, /Math\.round\(session\.exerciseAdherence\.percentage\)/);
});

test("coach history maps legacy partial and unlinked attempts to N/A", () => {
  assert.equal(athleteExerciseAdherence(row({ attempts: [] })).available, false);
  const partial = row(); partial.attempts[0].measurementQuality = "partial";
  assert.equal(athleteExerciseAdherence(partial).available, false);
  const unlinked = row(); unlinked.attempts[0].workoutResultId = "different";
  assert.equal(athleteExerciseAdherence(unlinked).available, false);
});

test("coach history keeps eligible 0/N available", () => {
  const input = row();
  input.attempts[0].completedWorkBlocks = 0;
  input.attempts[0].skippedWorkBlocks = 10;
  const adherence = athleteExerciseAdherence(input);
  assert.equal(adherence.available, true);
  assert.equal(adherence.percentage, 0);
});

test("multiple matching attempts are unavailable rather than inflated", () => {
  const input = row();
  input.attempts = [input.attempts[0], { ...input.attempts[0] }];
  assert.equal(athleteExerciseAdherence(input).available, false);
  assert.equal(athleteExerciseAdherenceInput(input).attempt, null);
});

test("team and athlete aggregates use weighted blocks and preserve unavailable coverage", () => {
  const first = row();
  const second = row({
    sessionId: "session-2",
    athleteId: "athlete-2",
    result: { id: "result-2", trainingSessionId: "session-2", athleteId: "athlete-2" },
    attempts: [{
      workoutResultId: "result-2", trainingSessionId: "session-2", athleteId: "athlete-2",
      finalizationState: "finalized_completed", measurementVersion: 1, measurementQuality: "complete",
      prescribedStepCount: 2, completedWorkBlocks: 1, skippedWorkBlocks: 1,
    }],
    prescription: { sessionId: "session-2", schemaVersion: 1, stepCount: 2 },
  });
  const aggregate = modules.exercise.aggregateExerciseAdherence([
    athleteExerciseAdherenceInput(first),
    athleteExerciseAdherenceInput(second),
    athleteExerciseAdherenceInput(row({ attempts: [] })),
  ]);
  assert.deepEqual(
    { completed: aggregate.completedBlocks, prescribed: aggregate.prescribedBlocks, eligible: aggregate.eligibleSessionCount, unavailable: aggregate.unavailableSessionCount },
    { completed: 10, prescribed: 12, eligible: 2, unavailable: 1 },
  );
  const perAthlete = modules.exercise.aggregateExerciseAdherence([athleteExerciseAdherenceInput(first)]);
  assert.equal(perAthlete.ratio, 0.9);
});

test("zero eligible athlete or team aggregate remains N/A", () => {
  const aggregate = modules.exercise.aggregateExerciseAdherence([
    athleteExerciseAdherenceInput(row({ attempts: [] })),
  ]);
  assert.equal(aggregate.available, false);
  assert.equal(aggregate.percentage, null);
});

test("coach paths use durable records only and do not add adherence to sorting or follow-up", () => {
  const detail = readFileSync(new URL("../src/app/teams/[teamId]/athletes/[athleteId]/page.tsx", import.meta.url), "utf8");
  const loader = readFileSync(new URL("../src/lib/team-attendance-server.ts", import.meta.url), "utf8");
  const analytics = readFileSync(new URL("../src/app/teams/[teamId]/analytics/page.tsx", import.meta.url), "utf8");
  for (const source of [detail, loader, analytics]) assert.doesNotMatch(source, /workout_session_events/);
  assert.match(loader, /workout_session_attempts\(workout_result_id/);
  assert.match(analytics, /aggregateExerciseAdherence/);
  assert.doesNotMatch(analytics, /\["adherence",\s*"Adherence"\]|followUp.*adherence|adherence.*followUp/);
});
