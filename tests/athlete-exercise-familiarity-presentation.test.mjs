import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const code = ts.transpileModule(readFileSync(new URL("../src/lib/athlete-exercise-familiarity-server.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const nodeRequire = createRequire(import.meta.url);
function load() { const loaded = { exports: {} }; new vm.Script(`(function(require,module,exports){${code}})`).runInThisContext()((name) => name === "server-only" ? {} : nodeRequire(name), loaded, loaded.exports); return loaded.exports; }
const loader = load();

test("bounded familiarity read uses durable athlete plus deduplicated semantic exercise IDs", async () => {
  const calls = []; const client = { from: () => ({ select: () => ({ eq: (column, athleteId) => ({ in: async (idColumn, ids) => { calls.push({ column, athleteId, idColumn, ids }); return { data: [{ exercise_id: "semantic-a" }], error: null }; } }) }) }) };
  assert.deepEqual(await loader.loadFamiliarExerciseIds(client, "athlete-child", ["semantic-a", "semantic-a", "semantic-b"]), ["semantic-a"]);
  assert.deepEqual(calls, [{ column: "athlete_id", athleteId: "athlete-child", idColumn: "exercise_id", ids: ["semantic-a", "semantic-b"] }]);
});
test("familiarity read failure is unknown, not a false NEW result", async () => {
  const client = { from: () => ({ select: () => ({ eq: () => ({ in: async () => ({ data: null, error: { message: "denied" } }) }) }) }) };
  assert.equal(await loader.loadFamiliarExerciseIds(client, "athlete-child", ["semantic-a"]), null);
});
test("rejected familiarity read is also unknown", async () => {
  const client = { from: () => ({ select: () => ({ eq: () => ({ in: async () => { throw new Error("network unavailable"); } }) }) }) };
  assert.equal(await loader.loadFamiliarExerciseIds(client, "athlete-child", ["semantic-a"]), null);
});
