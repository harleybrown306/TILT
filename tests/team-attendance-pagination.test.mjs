import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const source = readFileSync(new URL("../src/lib/training-assignment.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const runtime = { exports: {} };
new vm.Script(`(function(module,exports){${compiled}})`).runInThisContext()(runtime, runtime.exports);
const { readAllRows } = runtime.exports;

test("team attendance pagination retains ordered newest rows beyond one response page", async () => {
  const rows = Array.from({ length: 205 }, (_, index) => ({ id: String(index).padStart(3, "0") }));
  const ranges = [];
  const result = await readAllRows(async (from, to) => {
    ranges.push([from, to]);
    return { data: rows.slice(from, to + 1), error: null };
  });
  assert.deepEqual(result, rows);
  assert.deepEqual(ranges, [[0, 99], [100, 199], [200, 299], [205, 304]]);
  assert.equal(new Set(result.map((row) => row.id)).size, rows.length);
  assert.equal(result.at(-1)?.id, "204");
});

test("team attendance pagination advances by returned rows when an API cap is smaller than a page", async () => {
  const rows = Array.from({ length: 105 }, (_, index) => ({ id: String(index).padStart(3, "0") }));
  const result = await readAllRows(async (from, to) => ({
    data: rows.slice(from, Math.min(to + 1, from + 37)),
    error: null,
  }));
  assert.deepEqual(result, rows);
  assert.equal(new Set(result.map((row) => row.id)).size, rows.length);
  assert.equal(result.at(-1)?.id, "104");
});

test("team attendance loader keeps its authorized ordered query on every paged request", () => {
  const loader = readFileSync(new URL("../src/lib/team-attendance-server.ts", import.meta.url), "utf8");
  assert.match(loader, /readAllRows<Session>\(\(from, to\)/);
  assert.match(loader, /\.eq\("team_id", teamId\)/);
  assert.match(loader, /\.order\("scheduled_date", \{ ascending: true \}\)/);
  assert.match(loader, /\.order\("id", \{ ascending: true \}\)/);
  assert.match(loader, /\.range\(from, to\)/);
  assert.match(loader, /athlete_id,athlete_user_id,scheduled_date,status/);
  assert.match(loader, /workout_results\(id,training_session_id,athlete_id/);
});
