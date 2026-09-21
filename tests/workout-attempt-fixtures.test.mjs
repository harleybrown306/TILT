import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const document = JSON.parse(readFileSync(new URL("./fixtures/workout-attempt-measurement-v1.json", import.meta.url)));
const types = new Set(["workout_started","exercise_started","exercise_completed","exercise_skipped","rest_started","rest_completed","rest_skipped","timer_paused","timer_resumed","page_hidden","page_visible","workout_completed"]);
const phases = new Set(["ready","work","rest","finished"]);
const steps = new Map(document.prescription.steps.map((step) => [step.key, step]));
function expand(fixture) {
  return fixture.events.map((raw, index) => {
    const [event_type, phase, elapsed_ms, phase_elapsed_ms, step_key] = raw;
    const step = step_key === null ? null : steps.get(step_key);
    return {id:"00000000-0000-4000-8000-" + String(index + 1).padStart(12,"0"),session_id:"00000000-0000-4000-8000-000000000101",attempt_id:"00000000-0000-4000-8000-000000000102",sequence:fixture.sequence?.[index] ?? index,event_type,phase,elapsed_ms,occurred_at:new Date(Date.UTC(2026,8,15,12,0,0,elapsed_ms)).toISOString(),workout_exercise_id:step ? "00000000-0000-4000-8000-000000000" + (step.position + 11) : step_key === "unknown" ? "00000000-0000-4000-8000-000000000099" : null,step_position:fixture.positions?.[index] ?? step?.position ?? null,phase_duration_ms:fixture.durations?.[index] ?? (step ? (phase === "work" ? step.work_ms : step.rest_ms) : null),phase_elapsed_ms:fixture.phase_elapsed?.[index] ?? phase_elapsed_ms};
  });
}
test("measurement V1 fixtures are uniquely named and expand to persisted-event shapes", () => {
  assert.equal(document.measurement_version, 1); assert.equal(document.fixtures.length, 34);
  assert.equal(new Set(document.fixtures.map((fixture) => fixture.name)).size, document.fixtures.length);
  for (const fixture of document.fixtures) {
    assert.equal(typeof fixture.valid,"boolean",fixture.name); assert.ok(["emitter","mutated"].includes(fixture.origin),fixture.name); assert.ok(["complete","partial","unknown"].includes(fixture.quality),fixture.name);
    assert.equal(typeof fixture.finalizable,"boolean",fixture.name); assert.equal(typeof fixture.canonical_result,"boolean",fixture.name);
    for (const event of expand(fixture)) { assert.ok(types.has(event.event_type),fixture.name); assert.ok(phases.has(event.phase),fixture.name); assert.ok(Number.isSafeInteger(event.sequence),fixture.name); assert.ok(Number.isSafeInteger(event.elapsed_ms) && event.elapsed_ms >= 0,fixture.name); assert.equal(new Date(event.occurred_at).toISOString(),event.occurred_at,fixture.name); }
  }
});
test("V1 defers timer-progress metrics and never finalizes incomplete quality", () => {
  for (const fixture of document.fixtures) { assert.equal(fixture.expected.work_timer_progressed_ms,null,fixture.name); assert.equal(fixture.expected.rest_timer_progressed_ms,null,fixture.name); if (fixture.quality !== "complete") { assert.equal(fixture.finalizable,false,fixture.name); assert.equal(fixture.expected.elapsed_attempt_ms,null,fixture.name); } }
});
const compiled=ts.transpileModule(readFileSync(new URL("../src/lib/workout-attempt-summary.ts",import.meta.url),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText;
const runtime={exports:{}};new vm.Script("(function(module,exports){"+compiled+"})").runInThisContext()(runtime,runtime.exports);
const prescription={schemaVersion:1,prescribedWorkMs:3000,prescribedRestMs:500,prescribedTotalMs:3500,steps:document.prescription.steps.map((step)=>({workoutExerciseId:"00000000-0000-4000-8000-000000000"+(step.position+11),position:step.position,workMs:step.work_ms,restMs:step.rest_ms}))};
test("all authoritative fixtures match the Measurement V1 TypeScript builder",()=>{for(const fixture of document.fixtures){const actual=runtime.exports.summarizeWorkoutAttempt(prescription,expand(fixture),fixture.canonical_result);assert.equal(actual.quality,fixture.quality,fixture.name);assert.equal(actual.finalizationEligible,fixture.finalizable,fixture.name);assert.equal(actual.elapsedAttemptMs,fixture.expected.elapsed_attempt_ms,fixture.name);assert.equal(actual.explicitPauseMs,fixture.expected.explicit_pause_ms,fixture.name);assert.equal(actual.hiddenMs,fixture.expected.hidden_ms,fixture.name);assert.equal(actual.workTimerProgressedMs,fixture.expected.work_timer_progressed_ms,fixture.name);assert.equal(actual.restTimerProgressedMs,fixture.expected.rest_timer_progressed_ms,fixture.name);assert.equal(actual.completedWorkBlocks,fixture.expected.completed_work_blocks,fixture.name);assert.equal(actual.skippedWorkBlocks,fixture.expected.skipped_work_blocks,fixture.name);assert.equal(actual.completedRestBlocks,fixture.expected.completed_rest_blocks,fixture.name);assert.equal(actual.skippedRestBlocks,fixture.expected.skipped_rest_blocks,fixture.name);assert.equal(actual.firstSequence,fixture.events.length?(fixture.sequence?.[0]??0):null,fixture.name);assert.equal(actual.lastSequence,fixture.events.length?(fixture.sequence?.at(-1)??fixture.events.length-1):null,fixture.name);assert.equal(actual.eventCount,fixture.events.length,fixture.name);}});
