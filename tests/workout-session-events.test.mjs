import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(path, mocks = {}) {
  const source = ts.transpileModule(readFileSync(new URL("../" + path, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const loadedModule = { exports: {} };
  new vm.Script(`(function(require,module,exports){${source}\n})`).runInThisContext()(
    (name) => name in mocks ? mocks[name] : require(name), loadedModule, loadedModule.exports);
  return loadedModule.exports;
}
const logic = load("src/lib/workout-session-events.ts");
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const event = (changes = {}) => ({
  id: id(1), session_id: id(2), attempt_id: id(3), sequence: 0,
  event_type: "workout_started", phase: "ready", elapsed_ms: 0,
  occurred_at: "2026-09-14T12:00:00.000Z", ...changes,
});
const work = { event_type: "exercise_skipped", phase: "work", workout_exercise_id: id(4),
  step_position: 0, phase_duration_ms: 1000, phase_elapsed_ms: 500 };

for (const type of logic.EVENT_TYPES) {
  test("accept reviewed event " + type, () => {
    const phase = type.startsWith("exercise_") || type.startsWith("timer_") ? "work"
      : type.startsWith("rest_") ? "rest" : type === "workout_completed" ? "finished" : "ready";
    const data = event({ ...(["work", "rest"].includes(phase) ? work : {}), event_type: type, phase });
    assert.equal(logic.parseEventBatch({ events: [data] })[0].event_type, type);
  });
}
const invalidChanges = [
  { created_at: "2026-09-14T12:00:00.000Z" }, { metadata: {} }, { url: "https://example.com" },
  { athlete_user_id: id(9) }, { event_type: "unknown" }, { phase: "invalid" },
  { id: "bad" }, { session_id: "bad" }, { sequence: -1 }, { sequence: 1.5 },
  { elapsed_ms: -1 }, { elapsed_ms: Number.MAX_SAFE_INTEGER }, { occurred_at: "2026-02-30T12:00:00.000Z" },
  { occurred_at: "yesterday" }, { ...work, phase_elapsed_ms: 1001 },
  { ...work, step_position: null }, { ...work, workout_exercise_id: null },
  { ...work, phase_duration_ms: null }, { ...work, phase: "rest" },
  { event_type: "rest_started", phase: "ready" }, { event_type: "timer_paused", phase: "ready" },
  { event_type: "workout_completed", phase: "ready" }, { ...work, event_type: "workout_started" },
];
invalidChanges.forEach((changes, index) => test("reject malformed event " + index, () =>
  assert.throws(() => logic.parseEventBatch({ events: [event(changes)] }), logic.EventPayloadError)));
test("reject empty, unknown envelope, and oversized batch", () => {
  for (const payload of [{ events: [] }, { events: [event()], other: true }, []]) {
    assert.throws(() => logic.parseEventBatch(payload));
  }
  assert.throws(() => logic.parseEventBatch({ events: Array(26).fill(event()) }), (e) => e.status === 413);
});

function setup(options = {}) {
  const rows = [], writes = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: options.signedOut ? null : { id: id(10) } }, error: null }) },
    from(table) {
      let payload, selector;
      const query = {
        select() { return query; }, in() { return query; }, eq() { return query; },
        or(value) { selector = value; return query; }, limit() { return query; },
        insert(value) { payload = value; return query; },
        then(resolve, reject) {
          if (table === "training_sessions") return Promise.resolve({
            data: options.unauthorized ? [] : [{ id: id(2) }], error: options.readFailure ? { code: "bad" } : null,
          }).then(resolve, reject);
          assert.equal(table, "workout_session_events");
          if (!payload) {
            const selected = rows.filter((r) => selector.includes("id.eq." + r.id) ||
              selector.includes(`session_id.eq.${r.session_id},attempt_id.eq.${r.attempt_id},sequence.eq.${r.sequence}`));
            return Promise.resolve({ data: selected, error: options.lookupFailure ? {} : null }).then(resolve, reject);
          }
          writes.push(payload);
          if (options.rejectId === payload.id) return Promise.resolve({ error: { code: "42501" } }).then(resolve, reject);
          if (options.throwWrite) return Promise.reject(Error("network")).then(resolve, reject);
          if (options.writeCode) return Promise.resolve({ error: { code: options.writeCode } }).then(resolve, reject);
          if (rows.some((r) => r.id === payload.id || (r.session_id === payload.session_id &&
              r.attempt_id === payload.attempt_id && r.sequence === payload.sequence))) {
            return Promise.resolve({ error: { code: "23505" } }).then(resolve, reject);
          }
          rows.push({ ...payload, created_at: "server receipt" });
          return Promise.resolve({ error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const route = load("src/app/api/workout-session-events/route.ts", {
    "@/lib/supabase/server": { createClient: async () => client },
    "@/lib/workout-session-events": logic,
  });
  return { post: route.POST, rows, writes };
}
function request(payload = { events: [event()] }, headers = {}) {
  return new Request("http://localhost/api/workout-session-events", {
    method: "POST", headers: { origin: "http://localhost", "content-type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}
test("unauthenticated denied without writes", async () => {
  const s = setup({ signedOut: true }); assert.equal((await s.post(request())).status, 401); assert.equal(s.writes.length, 0);
});
test("valid batch accepts and strips nothing beyond canonical null normalization", async () => {
  const s = setup(); const response = await s.post(request());
  assert.equal(response.status, 200); assert.equal((await response.json()).acknowledgements[0].status, "accepted");
  assert.equal(s.rows.length, 1); assert.ok(!("created_at" in s.writes[0]));
});
test("identical retry acknowledged once; changed UUID/sequence payload conflicts without mutation", async () => {
  const s = setup(); await s.post(request());
  assert.equal((await (await s.post(request())).json()).acknowledgements[0].status, "duplicate");
  for (const change of [{ elapsed_ms: 1 }, { id: id(8) }, { sequence: 1 }]) {
    assert.equal((await (await s.post(request({ events: [event(change)] }))).json()).acknowledgements[0].status, "conflict");
  }
  assert.equal(s.rows.length, 1); assert.equal(s.rows[0].elapsed_ms, 0);
});
test("duplicate entries in same batch are safe", async () => {
  const s = setup(); const body = await (await s.post(request({ events: [event(), event()] }))).json();
  assert.deepEqual(body.acknowledgements.map((a) => a.status), ["accepted", "duplicate"]);
  assert.equal(s.rows.length, 1);
});
test("batch acknowledgements retain independent successes and RLS rejections", async () => {
  const s = setup({ rejectId: id(8) });
  const body = await (await s.post(request({ events: [event(), event({ id: id(8), sequence: 1 })] }))).json();
  assert.deepEqual(body.acknowledgements.map((a) => a.status), ["accepted", "rejected"]);
  assert.equal(s.rows.length, 1);
});
test("uses existing normal SSR client without privileged credentials or history writes", () => {
  const source = readFileSync(new URL("../src/app/api/workout-session-events/route.ts", import.meta.url), "utf8");
  assert.match(source, /@\/lib\/supabase\/server/);
  assert.doesNotMatch(source, /service[_-]role|SUPABASE_SECRET|process\.env/);
});
for (const [name, payload, headers, status] of [
  ["malformed JSON", "{", {}, 400], ["unknown data", { events: [event({ metadata: {} })] }, {}, 400],
  ["batch limit", { events: Array(26).fill(event()) }, {}, 413],
  ["byte limit", " ".repeat(65537), {}, 413], ["declared byte limit", {}, { "content-length": "65537" }, 413],
  ["cross-origin", undefined, { origin: "https://other.example" }, 403],
  ["missing origin", undefined, { origin: "" }, 403],
  ["fetch site", undefined, { "sec-fetch-site": "cross-site" }, 403],
  ["non JSON", undefined, { "content-type": "text/plain" }, 415],
]) {
  test(name + " rejected without writes", async () => {
    const s = setup(); assert.equal((await s.post(request(payload, headers))).status, status); assert.equal(s.writes.length, 0);
  });
}
test("unowned session denied even if coach may otherwise read it", async () => {
  const s = setup({ unauthorized: true }); assert.equal((await s.post(request())).status, 403); assert.equal(s.writes.length, 0);
});
test("verification failure produces retry response", async () => {
  assert.equal((await setup({ readFailure: true }).post(request())).status, 503);
});
for (const code of ["42501", "23514", "23503", "22003", "08006"]) {
  test("database failure " + code + " leaves history untouched", async () => {
    const s = setup({ writeCode: code });
    const ack = (await (await s.post(request())).json()).acknowledgements[0];
    assert.equal(ack.status, code === "08006" ? "retry" : "rejected"); assert.equal(s.rows.length, 0);
  });
}
test("uncertain network write remains retryable", async () => {
  assert.equal((await (await setup({ throwWrite: true }).post(request())).json()).acknowledgements[0].status, "retry");
});
test("duplicate lookup failure remains retryable", async () => {
  const s = setup({ lookupFailure: true }); await s.post(request());
  assert.equal((await (await s.post(request())).json()).acknowledgements[0].status, "retry");
});
