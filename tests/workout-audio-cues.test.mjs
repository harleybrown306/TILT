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
const planVoice = (before, result, command = "tick", extra = {}) => cues.planWorkoutVoicePrompts({ before, after: result.checkpoint, command, events: result.events, foreground: true, recovery: false, ...extra });
const kinds = (planned) => planned.map((cue) => cue.kind);

function audioHarness(speech = {}) {
  const oldWindow = globalThis.window;
  const effects = [], oscillatorStarts = [];
  class FakeAudioContext {
    state = "running"; currentTime = 0; destination = {};
    resume() { return Promise.resolve(); } close() { this.state = "closed"; return Promise.resolve(); }
    createGain() { const gain = { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() { return this; } }; return gain; }
    createOscillator() {
      return { type: "sine", frequency: { setValueAtTime() {} }, connect(node) { return node; }, start() { oscillatorStarts.push("start"); }, stop() {} };
    }
  }
  const fakeReact = {
    useState: (value) => [value, () => {}], useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn, useEffect: (fn) => effects.push(fn),
  };
  globalThis.window = { AudioContext: FakeAudioContext, ...speech };
  const audio = load("src/components/workout/use-workout-audio.ts", { react: fakeReact, "@/lib/workout-audio-cues": cues });
  const controller = audio.useWorkoutAudio();
  const cleanups = effects.map((effect) => effect()).filter(Boolean);
  return {
    controller, oscillatorStarts, window: globalThis.window,
    cleanup: () => cleanups.forEach((cleanup) => cleanup()),
    restore: () => { globalThis.window = oldWindow; },
  };
}
function audioAvailabilityHarness(windowImpl) {
  const oldWindow = globalThis.window; const values = [], refs = [], effects = []; let slot = 0;
  const fakeReact = {
    useState: (value) => { const index = slot++; if (!(index in values)) values[index] = value; return [values[index], (next) => { values[index] = typeof next === "function" ? next(values[index]) : next; }]; },
    useRef: (value) => { const index = slot++; return refs[index] ?? (refs[index] = { current: value }); },
    useCallback: (fn) => fn, useEffect: (fn) => effects.push(fn),
  };
  globalThis.window = windowImpl;
  const audio = load("src/components/workout/use-workout-audio.ts", { react: fakeReact, "@/lib/workout-audio-cues": cues }); let controller;
  const render = () => { slot = 0; effects.length = 0; controller = audio.useWorkoutAudio(); return controller; };
  render();
  return { render, get: () => controller, restore: () => { globalThis.window = oldWindow; } };
}

function qualifyingRest() {
  const initial = begin().checkpoint;
  const rest = change(initial, "tick", 20_000);
  return { initial, rest };
}

function transition(before, result, command = "tick", extra = {}) {
  return { before, after: result.checkpoint, command, events: result.events, foreground: true, recovery: false, ...extra };
}

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
test("qualifying foreground rest announces the normalized frozen next exercise once", () => {
  const initial = begin({ steps: [step({ restSeconds: 4 }), step({ id: id(5), position: 1, exerciseName: "  Split\n\tStance   Cradle  " })] }).checkpoint;
  const rest = change(initial, "tick", 20_000);
  const prompts = planVoice(initial, rest);
  assert.deepEqual(prompts.map((prompt) => [prompt.kind, prompt.text]), [["upcoming_exercise", "Next up, Split Stance Cradle. Ready."]]);
  const claimed = new Set();
  assert.equal(cues.claimWorkoutVoicePrompts(prompts, claimed).length, 1);
  assert.equal(cues.claimWorkoutVoicePrompts(prompts, claimed).length, 0);
});
test("voice excludes short, terminal, recovered, malformed, and first-work transitions", () => {
  const short = begin({ steps: [step({ restSeconds: 3 }), step({ id: id(5), position: 1 })] }).checkpoint;
  assert.equal(planVoice(short, change(short, "tick", 20_000)).length, 0);
  const zero = begin({ steps: [step({ restSeconds: 0 }), step({ id: id(5), position: 1 })] }).checkpoint;
  assert.equal(planVoice(zero, change(zero, "tick", 20_000)).length, 0);
  const terminal = begin({ steps: [step({ restSeconds: 4 })] }).checkpoint;
  assert.equal(planVoice(terminal, change(terminal, "tick", 20_000)).length, 0);
  const malformed = begin({ steps: [step({ restSeconds: 4 }), step({ id: id(5), position: 1, exerciseName: "\u0000bad" })] }).checkpoint;
  assert.equal(planVoice(malformed, change(malformed, "tick", 20_000)).length, 0);
  const overLimit = begin({ steps: [step({ restSeconds: 4 }), step({ id: id(5), position: 1, exerciseName: "x".repeat(81) })] }).checkpoint;
  assert.equal(planVoice(overLimit, change(overLimit, "tick", 20_000)).length, 0);
  const exactLimit = begin({ steps: [step({ restSeconds: 4 }), step({ id: id(5), position: 1, exerciseName: "x".repeat(80) })] }).checkpoint;
  assert.equal(planVoice(exactLimit, change(exactLimit, "tick", 20_000)).length, 1);
  const initial = begin().checkpoint;
  assert.equal(planVoice(null, { checkpoint: initial, events: [] }, "begin").length, 0);
  assert.equal(planVoice(initial, change(initial, "recover", 20_000, false), "recover", { foreground: false, recovery: true }).length, 0);
});
test("voice adapter claims unavailable speech APIs without historical retry", () => {
  const harness = audioHarness();
  const { initial, rest } = qualifyingRest();
  try {
    harness.controller.unlock();
    assert.doesNotThrow(() => harness.controller.handleTransition(transition(initial, rest)));
    const spoken = [];
    harness.window.speechSynthesis = { cancel() {}, speak: (utterance) => spoken.push(utterance.text) };
    harness.window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    harness.controller.handleTransition(transition(initial, rest));
    assert.deepEqual(spoken, []);
    const noUtterance = qualifyingRest();
    delete harness.window.SpeechSynthesisUtterance;
    assert.doesNotThrow(() => harness.controller.handleTransition(transition(noUtterance.initial, noUtterance.rest)));
    harness.window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    harness.controller.handleTransition(transition(noUtterance.initial, noUtterance.rest));
    assert.deepEqual(spoken, []);
  } finally { harness.cleanup(); harness.restore(); }
});
test("voice adapter contains utterance construction and speak failures without retry", () => {
  for (const mode of ["constructor", "speak"]) {
    const spoken = [];
    const synthesis = { cancel() {}, speak: mode === "speak" ? () => { throw Error("speak failed"); } : (utterance) => spoken.push(utterance.text) };
    const Utterance = mode === "constructor" ? class { constructor() { throw Error("construct failed"); } } : class { constructor(text) { this.text = text; } };
    const harness = audioHarness({ speechSynthesis: synthesis, SpeechSynthesisUtterance: Utterance });
    const { initial, rest } = qualifyingRest();
    try {
      harness.controller.unlock();
      assert.doesNotThrow(() => harness.controller.handleTransition(transition(initial, rest)));
      synthesis.speak = (utterance) => spoken.push(utterance.text);
      harness.window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
      harness.controller.handleTransition(transition(initial, rest));
      assert.deepEqual(spoken, []);
    } finally { harness.cleanup(); harness.restore(); }
  }
});
test("muted voice is claimed, unmute does not replay, and muting cancels active speech", () => {
  const spoken = []; let canceled = 0;
  const harness = audioHarness({ speechSynthesis: { cancel: () => { canceled++; }, speak: (utterance) => spoken.push(utterance.text) }, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } } });
  const { initial, rest } = qualifyingRest();
  try {
    harness.controller.handleTransition(transition(initial, rest));
    assert.deepEqual(spoken, []);
    harness.controller.setEnabled(true);
    harness.controller.handleTransition(transition(initial, rest));
    assert.deepEqual(spoken, []);
    const later = qualifyingRest();
    harness.controller.handleTransition(transition(later.initial, later.rest));
    assert.deepEqual(spoken, ["Next up, Cradle. Ready."]);
    harness.controller.setEnabled(false);
    assert.ok(canceled >= 2);
  } finally { harness.cleanup(); harness.restore(); }
});
test("pause, rest skip, and hidden transitions cancel speech without replay", () => {
  for (const command of ["pause", "skip", "hidden"]) {
    const spoken = []; let canceled = 0;
    const harness = audioHarness({ speechSynthesis: { cancel: () => { canceled++; }, speak: (utterance) => spoken.push(utterance.text) }, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } } });
    const { initial, rest } = qualifyingRest();
    try {
      harness.controller.unlock();
      harness.controller.handleTransition(transition(initial, rest));
      const at = command === "skip" ? 21_000 : 20_500;
      const next = change(rest.checkpoint, command, at);
      harness.controller.handleTransition(transition(rest.checkpoint, next, command, command === "hidden" ? { foreground: false } : {}));
      assert.ok(canceled >= 2, command);
      const resumed = command === "pause" ? change(next.checkpoint, "resume", 21_000) : command === "hidden" ? change(next.checkpoint, "visible", 21_000) : next;
      harness.controller.handleTransition(transition(next.checkpoint, resumed, command === "pause" ? "resume" : command === "hidden" ? "visible" : "skip", { foreground: false }));
      assert.deepEqual(spoken, ["Next up, Cradle. Ready."], command);
    } finally { harness.cleanup(); harness.restore(); }
  }
});
test("unmount and cancel failure are contained; work-start beep remains independent", () => {
  let canceled = 0; let failCancel = false;
  const harness = audioHarness({ speechSynthesis: { cancel: () => { canceled++; if (failCancel) throw Error("cancel failed"); }, speak() {} }, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } } });
  const { initial, rest } = qualifyingRest();
  try {
    harness.controller.unlock();
    harness.controller.handleTransition(transition(initial, rest));
    failCancel = true;
    const work = change(rest.checkpoint, "tick", 25_000);
    assert.doesNotThrow(() => harness.controller.handleTransition(transition(rest.checkpoint, work)));
    assert.ok(canceled >= 2);
    assert.equal(harness.oscillatorStarts.length, 2);
    assert.doesNotThrow(() => harness.cleanup());
  } finally { harness.restore(); }
});
test("ten-second and completion transitions remain beep-only", () => {
  const initial = begin().checkpoint;
  const tenSeconds = change(initial, "tick", 10_001);
  assert.deepEqual(kinds(plan(initial, tenSeconds)), ["ten_seconds"]);
  assert.deepEqual(planVoice(initial, tenSeconds), []);
  const finalStart = begin({ steps: [step({ durationSeconds: 20, restSeconds: 0 })] }).checkpoint;
  const complete = change(finalStart, "tick", 20_000);
  assert.deepEqual(kinds(plan(finalStart, complete)), ["workout_complete"]);
  assert.deepEqual(planVoice(finalStart, complete), []);
  const finalRestStart = begin({ steps: [step({ durationSeconds: 20, restSeconds: 4 })] }).checkpoint;
  const finalRest = change(finalRestStart, "tick", 20_000);
  const finalRestComplete = change(finalRest.checkpoint, "tick", 24_000);
  assert.deepEqual(kinds(plan(finalRest.checkpoint, finalRestComplete)), ["workout_complete"]);
  assert.deepEqual(planVoice(finalRest.checkpoint, finalRestComplete), []);
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
test("audio availability is truthful for absent, failed, successful, and retried Web Audio", async () => {
  const absent = audioAvailabilityHarness({});
  try { absent.get().unlock(); let current = absent.render(); assert.equal(current.soundEnabled, true); assert.equal(current.audioAvailability, "unavailable"); } finally { absent.restore(); }
  const failed = audioAvailabilityHarness({ AudioContext: class { constructor() { throw Error("unsupported"); } } });
  try { failed.get().unlock(); assert.equal(failed.render().audioAvailability, "unavailable"); } finally { failed.restore(); }
  class Suspended { constructor() { this.state = "suspended"; } resume() { return Promise.reject(Error("blocked")); } close() { return Promise.resolve(); } }
  const rejected = audioAvailabilityHarness({ AudioContext: Suspended });
  try { rejected.get().unlock(); await Promise.resolve(); await Promise.resolve(); assert.equal(rejected.render().audioAvailability, "unavailable"); } finally { rejected.restore(); }
  class Running { constructor() { this.state = "running"; } close() { return Promise.resolve(); } }
  const available = audioAvailabilityHarness({ AudioContext: Running });
  try { available.get().unlock(); assert.equal(available.render().audioAvailability, "available"); } finally { available.restore(); }
  let fail = true; class Retry { constructor() { if (fail) throw Error("blocked"); this.state = "running"; } close() { return Promise.resolve(); } }
  const retry = audioAvailabilityHarness({ AudioContext: Retry });
  try { retry.get().unlock(); assert.equal(retry.render().audioAvailability, "unavailable"); retry.get().setEnabled(false); fail = false; retry.get().setEnabled(true); const current = retry.render(); assert.equal(current.soundEnabled, true); assert.equal(current.audioAvailability, "available"); } finally { retry.restore(); }
});
test("speech absence does not mark available Web Audio unavailable", () => {
  class Running { constructor() { this.state = "running"; } close() { return Promise.resolve(); } }
  const harness = audioAvailabilityHarness({ AudioContext: Running });
  try { harness.get().unlock(); assert.equal(harness.render().audioAvailability, "available"); } finally { harness.restore(); }
});
test("latest Web Audio unlock attempt owns availability regardless of deferred settlement order", async () => {
  const deferred = [], instances = [];
  class DeferredContext {
    constructor() { this.state = "suspended"; instances.push(this); }
    resume() { let resolve; let reject; const promise = new Promise((ok, no) => { resolve = ok; reject = no; }); deferred.push({ resolve, reject }); return promise; }
    close() { return Promise.resolve(); }
  }
  const harness = audioAvailabilityHarness({ AudioContext: DeferredContext });
  try {
    harness.get().unlock(); harness.get().unlock();
    instances[0].state = "running"; deferred[1].resolve(); await Promise.resolve(); assert.equal(harness.render().audioAvailability, "available");
    deferred[0].reject(Error("old failure")); await Promise.resolve(); await Promise.resolve(); assert.equal(harness.render().audioAvailability, "available");
  } finally { harness.restore(); }
});
test("newer failed unlock remains unavailable when an older attempt later succeeds, including Sound Off invalidation", async () => {
  const deferred = [], instances = [];
  class DeferredContext {
    constructor() { this.state = "suspended"; instances.push(this); }
    resume() { let resolve; let reject; const promise = new Promise((ok, no) => { resolve = ok; reject = no; }); deferred.push({ resolve, reject }); return promise; }
    close() { return Promise.resolve(); }
  }
  const harness = audioAvailabilityHarness({ AudioContext: DeferredContext });
  try {
    harness.get().unlock(); harness.get().unlock(); deferred[1].reject(Error("new failure")); await Promise.resolve(); await Promise.resolve(); assert.equal(harness.render().audioAvailability, "unavailable");
    instances[0].state = "running"; deferred[0].resolve(); await Promise.resolve(); assert.equal(harness.render().audioAvailability, "unavailable");
    instances[0].state = "suspended"; harness.get().setEnabled(false); harness.get().setEnabled(true); harness.get().setEnabled(false);
    instances[0].state = "running"; deferred[2].resolve(); await Promise.resolve(); assert.equal(harness.render().audioAvailability, "unavailable");
    harness.get().setEnabled(true); assert.equal(harness.render().audioAvailability, "available");
  } finally { harness.restore(); }
});
