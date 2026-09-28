import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);

function load(path, mocks = {}) {
  const code = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  const loaded = { exports: {} };
  new vm.Script(`(function(require,module,exports){${code}\n})`).runInThisContext()((name) => name in mocks ? mocks[name] : require(name), loaded, loaded.exports);
  return loaded.exports;
}

const state = load("src/lib/workout-session-state.ts");
const cues = load("src/lib/workout-audio-cues.ts", { "./workout-session-state": state });
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const start = Date.parse("2026-09-28T12:00:00.000Z");
let next = 100;
const uuid = () => id(next++);
const step = (changes = {}) => ({ id: id(4), position: 0, exerciseName: "Cradle", durationSeconds: 20, restSeconds: 5, offHand: false, notes: null, videoUrl: null, ...changes });
const input = (changes = {}) => ({ athleteId: id(1), sessionId: id(2), workoutId: id(3), workoutName: "Test", steps: [step(), step({ id: id(5), position: 1, restSeconds: 0 })], ...changes });
const begin = (changes = {}) => state.beginAttempt(input(changes), start, uuid);
const change = (checkpoint, command, at, observed = true) => state.changeAttempt(checkpoint, command, start + at, uuid, observed);
const plan = (before, result, command = "tick", extra = {}) => cues.planWorkoutAudioCues({ before, after: result.checkpoint, command, events: result.events, foreground: true, recovery: false, ...extra });
const kinds = (planned) => planned.map((cue) => cue.kind);

test("foreground work start emits exactly one start cue", () => {
  const result = begin();
  assert.deepEqual(kinds(plan(null, result, "begin")), ["work_start"]);
  assert.deepEqual(kinds(plan(result.checkpoint, { checkpoint: result.checkpoint, events: [] })), []);
});
test("work crosses ten seconds once and later ticks do not duplicate it", () => {
  const initial = begin().checkpoint;
  const crossing = change(initial, "tick", 10_001);
  assert.deepEqual(kinds(plan(initial, crossing)), ["ten_seconds"]);
  const later = change(crossing.checkpoint, "tick", 12_000);
  assert.deepEqual(kinds(plan(crossing.checkpoint, later)), []);
});
test("short work, rest, pause/resume, and recovery never produce a ten-second warning", () => {
  const short = begin({ steps: [step({ durationSeconds: 10, restSeconds: 5 })] }).checkpoint;
  assert.deepEqual(kinds(plan(short, change(short, "tick", 1))), []);
  const initial = begin().checkpoint;
  const rest = change(initial, "tick", 20_000);
  assert.deepEqual(kinds(plan(initial, rest)), ["rest_start"]);
  const paused = change(initial, "pause", 9_000);
  assert.deepEqual(kinds(plan(initial, paused, "pause")), []);
  const resumed = change(paused.checkpoint, "resume", 20_000);
  assert.deepEqual(kinds(plan(paused.checkpoint, resumed, "resume")), []);
  const recovered = change(initial, "recover", 15_000, false);
  assert.deepEqual(kinds(plan(initial, recovered, "recover", { foreground: false, recovery: true })), []);
});
test("background crossing and recovery into a new work interval are silent", () => {
  const initial = begin().checkpoint;
  const crossing = change(initial, "tick", 12_000);
  assert.deepEqual(kinds(plan(initial, crossing, "tick", { foreground: false })), []);
  const nextWork = change(initial, "recover", 25_000, false);
  assert.deepEqual(kinds(plan(initial, nextWork, "recover", { foreground: false, recovery: true })), []);
});
test("foreground work completion/rest entry and final completion have distinct cues", () => {
  const first = begin().checkpoint;
  const rest = change(first, "tick", 20_000);
  assert.deepEqual(kinds(plan(first, rest)), ["rest_start"]);
  const secondWork = change(rest.checkpoint, "tick", 25_000);
  assert.deepEqual(kinds(plan(rest.checkpoint, secondWork)), ["work_start"]);
  const final = change(secondWork.checkpoint, "tick", 45_000);
  assert.deepEqual(kinds(plan(secondWork.checkpoint, final)), ["workout_complete"]);
});
test("the final rest interval also produces the final completion cue", () => {
  const initial = begin({ steps: [step({ durationSeconds: 20, restSeconds: 5 })] }).checkpoint;
  const rest = change(initial, "tick", 20_000);
  const final = change(rest.checkpoint, "tick", 25_000);
  assert.deepEqual(kinds(plan(rest.checkpoint, final)), ["workout_complete"]);
});
test("cue keys are stable per attempt phase and kind", () => {
  const started = begin();
  const [first] = plan(null, started, "begin");
  const [again] = plan(null, started, "begin");
  assert.equal(first.key, again.key);
});
test("claimed cues do not replay after sound is re-enabled", () => {
  const started = begin();
  const planned = plan(null, started, "begin");
  const emitted = new Set();
  // The adapter claims this while sound is off, then intentionally has nothing
  // left to play when the athlete turns sound back on.
  assert.equal(cues.claimWorkoutAudioCues(planned, emitted).length, 1);
  assert.equal(cues.claimWorkoutAudioCues(planned, emitted).length, 0);
});
test("real audio unlock failure is contained", () => {
  const oldWindow = globalThis.window;
  const effects = [];
  const fakeReact = {
    useState: (value) => [value, () => {}], useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn, useEffect: (fn) => effects.push(fn),
  };
  globalThis.window = { AudioContext: class { constructor() { throw Error("unsupported"); } } };
  try {
    const audio = load("src/components/workout/use-workout-audio.ts", { react: fakeReact, "@/lib/workout-audio-cues": cues });
    assert.doesNotThrow(() => audio.useWorkoutAudio().unlock());
  } finally { globalThis.window = oldWindow; }
});
