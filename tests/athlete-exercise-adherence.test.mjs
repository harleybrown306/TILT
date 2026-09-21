import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const adherenceSource = readFileSync(
  new URL("../src/lib/exercise-adherence.ts", import.meta.url),
  "utf8",
);
const mappingSource = readFileSync(
  new URL("../src/lib/athlete-exercise-adherence.ts", import.meta.url),
  "utf8",
).replace(
  /import\s*\{([\s\S]*?)\}\s*from "\.\/exercise-adherence";/,
  "const { calculateExerciseAdherence } = require('./exercise-adherence');",
);
const compile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
const modules = {};
const require = (name) => {
  if (name !== "./exercise-adherence") throw new Error(`Unexpected module: ${name}`);
  return modules.exercise;
};
const exerciseModule = { exports: {} };
new vm.Script(`(function(module,exports,require){${compile(adherenceSource)}})`).runInThisContext()(
  exerciseModule,
  exerciseModule.exports,
  require,
);
modules.exercise = exerciseModule.exports;
const mappingModule = { exports: {} };
new vm.Script(`(function(module,exports,require){${compile(mappingSource)}})`).runInThisContext()(
  mappingModule,
  mappingModule.exports,
  require,
);
const { athleteExerciseAdherence, athleteExerciseAdherenceInput } = mappingModule.exports;

function source(overrides = {}) {
  const result = { id: "result-1", trainingSessionId: "session-1", athleteId: "athlete-1" };
  const attempt = {
    workoutResultId: result.id,
    trainingSessionId: "session-1",
    athleteId: "athlete-1",
    finalizationState: "finalized_completed",
    measurementVersion: 1,
    measurementQuality: "complete",
    prescribedStepCount: 10,
    completedWorkBlocks: 9,
    skippedWorkBlocks: 1,
  };
  return {
    sessionId: "session-1",
    athleteId: "athlete-1",
    result,
    attempts: [attempt],
    prescription: { sessionId: "session-1", schemaVersion: 1, stepCount: 10 },
    ...overrides,
  };
}

test("an eligible recent session maps to available adherence", () => {
  assert.deepEqual(athleteExerciseAdherence(source()), {
    available: true,
    completedBlocks: 9,
    prescribedBlocks: 10,
    skippedBlocks: 1,
    ratio: 0.9,
    percentage: 90,
  });
});

test("a legacy session without an attempt maps to N/A", () => {
  assert.equal(athleteExerciseAdherence(source({ attempts: [] })).available, false);
});

test("an attempt not linked to the canonical result maps to N/A", () => {
  const input = source();
  input.attempts[0].workoutResultId = "another-result";
  assert.equal(athleteExerciseAdherence(input).available, false);
});

test("a partial attempt maps to N/A", () => {
  const input = source();
  input.attempts[0].measurementQuality = "partial";
  assert.equal(athleteExerciseAdherence(input).available, false);
});

test("a complete 0/N attempt remains available at 0 percent", () => {
  const input = source();
  input.attempts[0].completedWorkBlocks = 0;
  input.attempts[0].skippedWorkBlocks = 10;
  const result = athleteExerciseAdherence(input);
  assert.equal(result.available, true);
  assert.equal(result.percentage, 0);
});

test("the UI renders completed and prescribed text with display-only rounding", () => {
  const page = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /Exercise adherence: \$\{session\.exerciseAdherence\.completedBlocks\} of \$\{session\.exerciseAdherence\.prescribedBlocks\} prescribed work blocks completed/);
  assert.match(page, /Math\.round\(session\.exerciseAdherence\.percentage\)/);
  const adherence = athleteExerciseAdherence(source({
    attempts: [{
      ...source().attempts[0],
      prescribedStepCount: 3,
      completedWorkBlocks: 1,
      skippedWorkBlocks: 2,
    }],
    prescription: { sessionId: "session-1", schemaVersion: 1, stepCount: 3 },
  }));
  assert.equal(adherence.completedBlocks, 1);
  assert.equal(adherence.prescribedBlocks, 3);
  assert.equal(adherence.percentage, (1 / 3) * 100);
});

test("multiple attempts never select an arbitrary matching result attempt", () => {
  const input = source();
  input.attempts = [input.attempts[0], { ...input.attempts[0] }];
  assert.equal(athleteExerciseAdherence(input).available, false);
  assert.equal(athleteExerciseAdherenceInput(input).attempt, null);
});

test("the dashboard fetches durable result attempt and prescription fields without raw telemetry", () => {
  const page = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /workout_results\(id,training_session_id,athlete_user_id,completed_at\)/);
  assert.match(page, /workout_session_attempts\(workout_result_id,training_session_id,athlete_user_id,finalization_state,measurement_version,measurement_quality,prescribed_step_count,completed_work_blocks,skipped_work_blocks\)/);
  assert.match(page, /training_session_prescriptions\(workout_name,prescribed_work_ms,prescribed_total_ms,schema_version,step_count\)/);
  assert.doesNotMatch(page, /workout_session_events/);
});

test("the seven-day summary uses weighted eligible results and reports coverage", () => {
  const first = source();
  const second = source({
    sessionId: "session-2",
    athleteId: "athlete-2",
    result: { id: "result-2", trainingSessionId: "session-2", athleteId: "athlete-2" },
    attempts: [{
      workoutResultId: "result-2",
      trainingSessionId: "session-2",
      athleteId: "athlete-2",
      finalizationState: "finalized_completed",
      measurementVersion: 1,
      measurementQuality: "complete",
      prescribedStepCount: 2,
      completedWorkBlocks: 1,
      skippedWorkBlocks: 1,
    }],
    prescription: { sessionId: "session-2", schemaVersion: 1, stepCount: 2 },
  });
  const aggregate = modules.exercise.aggregateExerciseAdherence([
    athleteExerciseAdherenceInput(first),
    athleteExerciseAdherenceInput(second),
    athleteExerciseAdherenceInput(source({ attempts: [] })),
  ]);
  assert.equal(aggregate.completedBlocks, 10);
  assert.equal(aggregate.prescribedBlocks, 12);
  assert.equal(aggregate.eligibleSessionCount, 2);
  assert.equal(aggregate.unavailableSessionCount, 1);
  const page = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /eligible of .*completed workouts in 7 days/);
});

test("a seven-day summary with zero eligible sessions is N/A", () => {
  const aggregate = modules.exercise.aggregateExerciseAdherence([
    athleteExerciseAdherenceInput(source({ attempts: [] })),
  ]);
  assert.equal(aggregate.available, false);
  assert.equal(aggregate.ratio, null);
});
