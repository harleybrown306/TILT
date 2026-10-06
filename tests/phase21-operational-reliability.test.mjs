import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);

function load(path, mocks = {}) {
  const source = ts.transpileModule(readFileSync(new URL(path, root), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const loaded = { exports: {} };
  new vm.Script(`(function(require,module,exports){${source}\n})`).runInThisContext()(
    (name) => name in mocks ? mocks[name] : require(name), loaded, loaded.exports);
  return loaded.exports;
}

test("operational logging emits only an opaque reference and allowlisted failure facts", () => {
  const logger = load("src/lib/operational-log.ts", { "server-only": {}, "node:crypto": { randomUUID: () => "reference" } });
  const entries = [];
  const original = console.error;
  console.error = (...values) => entries.push(values);
  try {
    logger.logOperationalFailure({ reference: "reference", surface: "auth_callback", code: "auth_exchange_failed" });
  } finally {
    console.error = original;
  }
  assert.deepEqual(entries, [["[TILT operational failure]", { reference: "reference", surface: "auth_callback", code: "auth_exchange_failed" }]]);
  assert.equal(logger.createOperationalReference(), "reference");
});

test("app-wide recovery UI never renders an arbitrary error message", () => {
  const recovery = readFileSync(new URL("src/components/error-recovery.tsx", root), "utf8");
  const global = readFileSync(new URL("src/app/global-error.tsx", root), "utf8");
  assert.match(recovery, /error\.digest/);
  assert.doesNotMatch(recovery, /error\.message/);
  assert.match(recovery, /retry/);
  assert.match(global, /<html lang="en">/);
  assert.match(global, /<body>/);
});

test("workout event ingest records retryable infrastructure failures without payload logging", () => {
  const route = readFileSync(new URL("src/app/api/workout-session-events/route.ts", root), "utf8");
  assert.match(route, /workout_event_auth_unavailable/);
  assert.match(route, /workout_event_session_verification_failed/);
  assert.match(route, /workout_event_batch_retryable_failure/);
  assert.match(route, /X-TILT-Operation-Reference/);
  assert.doesNotMatch(route, /console\.(?:info|warn|error)/);
});

test("invitation delivery keeps truthful results while recording reservation and acknowledgement failures", () => {
  const boundary = readFileSync(new URL("src/lib/invitation-delivery-boundary.ts", root), "utf8");
  assert.match(boundary, /invitation_delivery_reservation_failed/);
  assert.match(boundary, /invitation_delivery_acknowledgement_failed/);
  assert.match(boundary, /return "ambiguous"/);
  assert.doesNotMatch(boundary, /console\.(?:info|warn|error)/);
});
