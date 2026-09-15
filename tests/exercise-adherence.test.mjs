import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const source = readFileSync(
  new URL("../src/lib/exercise-adherence.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText;
const runtime = { exports: {} };
new vm.Script(`(function(module, exports) { ${compiled} })`).runInThisContext()(
  runtime,
  runtime.exports,
);

const { calculateExerciseAdherence, aggregateExerciseAdherence } = runtime.exports;

function eligibleInput(overrides = {}) {
  const result = {
    id: "result-1",
    trainingSessionId: "session-1",
    athleteUserId: "athlete-1",
  };
  const attempt = {
    workoutResultId: result.id,
    trainingSessionId: result.trainingSessionId,
    athleteUserId: result.athleteUserId,
    finalizationState: "finalized_completed",
    measurementVersion: 1,
    measurementQuality: "complete",
    prescribedStepCount: 10,
    completedWorkBlocks: 10,
    skippedWorkBlocks: 0,
  };
  const prescription = {
    sessionId: result.trainingSessionId,
    schemaVersion: 1,
    stepCount: 10,
  };

  return {
    result,
    attempt,
    prescription,
    ...overrides,
  };
}

function unavailable(input) {
  assert.deepEqual(calculateExerciseAdherence(input), {
    available: false,
    completedBlocks: null,
    prescribedBlocks: null,
    skippedBlocks: null,
    ratio: null,
    percentage: null,
  });
}

test("eligible 10/10 has an exact 100 percent ratio", () => {
  assert.deepEqual(calculateExerciseAdherence(eligibleInput()), {
    available: true,
    completedBlocks: 10,
    prescribedBlocks: 10,
    skippedBlocks: 0,
    ratio: 1,
    percentage: 100,
  });
});

test("eligible 9/10 has an exact 90 percent ratio", () => {
  const input = eligibleInput();
  input.attempt.completedWorkBlocks = 9;
  input.attempt.skippedWorkBlocks = 1;
  assert.equal(calculateExerciseAdherence(input).percentage, 90);
});

test("eligible 0/10 is a valid zero percent result", () => {
  const input = eligibleInput();
  input.attempt.completedWorkBlocks = 0;
  input.attempt.skippedWorkBlocks = 10;
  const result = calculateExerciseAdherence(input);
  assert.equal(result.available, true);
  assert.equal(result.ratio, 0);
  assert.equal(result.percentage, 0);
});

test("a missing attempt is unavailable", () => unavailable(eligibleInput({ attempt: null })));
test("a missing canonical result is unavailable", () => unavailable(eligibleInput({ result: null })));

test("an attempt linked to another result is unavailable", () => {
  const input = eligibleInput();
  input.attempt.workoutResultId = "result-2";
  unavailable(input);
});

test("attempt, result, and prescription identity mismatches are unavailable", () => {
  const attemptSessionMismatch = eligibleInput();
  attemptSessionMismatch.attempt.trainingSessionId = "session-2";
  unavailable(attemptSessionMismatch);

  const athleteMismatch = eligibleInput();
  athleteMismatch.attempt.athleteUserId = "athlete-2";
  unavailable(athleteMismatch);

  const prescriptionSessionMismatch = eligibleInput();
  prescriptionSessionMismatch.prescription.sessionId = "session-2";
  unavailable(prescriptionSessionMismatch);
});

test("an open attempt is unavailable", () => {
  const input = eligibleInput();
  input.attempt.finalizationState = "open";
  unavailable(input);
});

test("partial and unknown measurement quality are unavailable", () => {
  for (const measurementQuality of ["partial", "unknown"]) {
    const input = eligibleInput();
    input.attempt.measurementQuality = measurementQuality;
    unavailable(input);
  }
});

test("a non-V1 attempt is unavailable", () => {
  const input = eligibleInput();
  input.attempt.measurementVersion = 2;
  unavailable(input);
});

test("a missing prescription is unavailable", () => unavailable(eligibleInput({ prescription: null })));

test("a non-V1 prescription is unavailable", () => {
  const input = eligibleInput();
  input.prescription.schemaVersion = 2;
  unavailable(input);
});

test("a prescription and attempt denominator mismatch is unavailable", () => {
  const input = eligibleInput();
  input.attempt.prescribedStepCount = 9;
  unavailable(input);
});

test("unresolved work-block outcomes are unavailable", () => {
  const input = eligibleInput();
  input.attempt.completedWorkBlocks = 8;
  input.attempt.skippedWorkBlocks = 1;
  unavailable(input);
});

test("zero prescribed blocks are unavailable", () => {
  const input = eligibleInput();
  input.attempt.prescribedStepCount = 0;
  input.attempt.completedWorkBlocks = 0;
  input.prescription.stepCount = 0;
  unavailable(input);
});

test("aggregate uses weighted block totals instead of averaging percentages", () => {
  const first = eligibleInput();
  first.attempt.completedWorkBlocks = 9;
  first.attempt.skippedWorkBlocks = 1;
  const second = eligibleInput({
    result: { id: "result-2", trainingSessionId: "session-2", athleteUserId: "athlete-2" },
    attempt: {
      workoutResultId: "result-2",
      trainingSessionId: "session-2",
      athleteUserId: "athlete-2",
      finalizationState: "finalized_completed",
      measurementVersion: 1,
      measurementQuality: "complete",
      prescribedStepCount: 2,
      completedWorkBlocks: 1,
      skippedWorkBlocks: 1,
    },
    prescription: { sessionId: "session-2", schemaVersion: 1, stepCount: 2 },
  });
  assert.deepEqual(aggregateExerciseAdherence([first, second]), {
    available: true,
    completedBlocks: 10,
    prescribedBlocks: 12,
    skippedBlocks: 2,
    eligibleSessionCount: 2,
    unavailableSessionCount: 0,
    ratio: 10 / 12,
    percentage: (10 / 12) * 100,
  });
});

test("aggregate ignores unavailable sessions while counting them", () => {
  const eligible = eligibleInput();
  const unavailableInput = eligibleInput({ attempt: null });
  const aggregate = aggregateExerciseAdherence([eligible, unavailableInput]);
  assert.equal(aggregate.eligibleSessionCount, 1);
  assert.equal(aggregate.unavailableSessionCount, 1);
  assert.equal(aggregate.prescribedBlocks, 10);
});

test("aggregate with no eligible sessions is unavailable", () => {
  assert.deepEqual(aggregateExerciseAdherence([eligibleInput({ attempt: null })]), {
    available: false,
    completedBlocks: 0,
    prescribedBlocks: 0,
    skippedBlocks: 0,
    eligibleSessionCount: 0,
    unavailableSessionCount: 1,
    ratio: null,
    percentage: null,
  });
});

test("rest counts do not affect exercise adherence", () => {
  const input = eligibleInput();
  input.attempt.completedRestBlocks = 999;
  input.attempt.skippedRestBlocks = 999;
  assert.deepEqual(calculateExerciseAdherence(input), calculateExerciseAdherence(eligibleInput()));
});

test("integer block counts remain authoritative without percentage rounding", () => {
  const input = eligibleInput();
  input.attempt.prescribedStepCount = 3;
  input.attempt.completedWorkBlocks = 1;
  input.attempt.skippedWorkBlocks = 2;
  input.prescription.stepCount = 3;
  const result = calculateExerciseAdherence(input);
  assert.equal(result.completedBlocks, 1);
  assert.equal(result.prescribedBlocks, 3);
  assert.equal(result.skippedBlocks, 2);
  assert.equal(result.percentage, (1 / 3) * 100);
});
