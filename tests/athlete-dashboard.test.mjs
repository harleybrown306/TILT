import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const source = readFileSync(new URL("../src/lib/athlete-dashboard.ts", import.meta.url), "utf8")
  .replace('import { localDate, shiftDate } from "./team-attendance";', `const localDate=(value)=>new Intl.DateTimeFormat("en-US",{timeZone:"America/Chicago",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(value).reduce((out,part)=>({...out,[part.type]:part.value}),{}); const shiftDate=(date,days)=>{const [year,month,day]=date.split("-").map(Number);return new Date(Date.UTC(year,month-1,day+days)).toISOString().slice(0,10)};`);
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const runtimeModule = { exports: {} };
new vm.Script(`(function(module,exports){${output}})`).runInThisContext()(runtimeModule, runtimeModule.exports);
const dashboard = runtimeModule.exports;
const today = "2026-09-14";
const row = (id, date, work = 60_000, status = "completed", team = "A") => ({ id, teamId: team, teamName: `Team ${team}`, scheduledDate: date, status, workoutName: "Frozen workout", completedAt: status === "completed" ? `${date}T18:00:00Z` : null, prescribedWorkMs: work, prescribedTotalMs: work + 30_000 });

test("weekly and monthly volume use completed snapshot work milliseconds", () => {
  const metrics = dashboard.athleteDashboardMetrics([row("a", "2026-09-08", 90_000), row("b", "2026-09-01", 120_000), row("c", "2026-09-14", 30_000)], today);
  assert.equal(metrics.weeklyWorkMs, 120_000);
  assert.equal(metrics.monthlyWorkMs, 240_000);
  assert.equal(dashboard.displayMinutes(metrics.weeklyWorkMs), 2);
});

test("incomplete cancelled future and missing-prescription sessions do not contribute volume", () => {
  const rows = [row("a", "2026-09-13", 60_000, "scheduled"), row("b", "2026-09-13", 60_000, "cancelled"), row("c", "2026-09-15", 60_000), { ...row("d", "2026-09-13"), prescribedWorkMs: null }];
  assert.equal(dashboard.athleteDashboardMetrics(rows, today).weeklyWorkMs, 0);
});

test("multi-team sessions remain distinct while same-day training counts once", () => {
  const metrics = dashboard.athleteDashboardMetrics([row("a", "2026-09-13", 60_000, "completed", "A"), row("b", "2026-09-13", 60_000, "completed", "B")], today);
  assert.equal(metrics.totalCompletedWorkouts, 2);
  assert.equal(metrics.trainingDays, 1);
});

test("streak ends today or yesterday and resets after a gap", () => {
  assert.equal(dashboard.athleteDashboardMetrics([row("a", "2026-09-14"), row("b", "2026-09-13")], today).currentStreak, 2);
  assert.equal(dashboard.athleteDashboardMetrics([row("a", "2026-09-13")], today).currentStreak, 1);
  assert.equal(dashboard.athleteDashboardMetrics([row("a", "2026-09-12")], today).currentStreak, 0);
});

test("activity chart aggregates local scheduled dates and safely includes zero days", () => {
  const chart = dashboard.activityBuckets([row("a", "2026-09-13", 60_000), row("b", "2026-09-13", 120_000)], today);
  assert.equal(chart.length, 7);
  assert.equal(chart.find((bucket) => bucket.date === "2026-09-13").workMs, 180_000);
  assert.equal(chart.find((bucket) => bucket.date === "2026-09-14").workMs, 0);
});

test("dashboard uses immutable prescription data and excludes telemetry/result legacy fields", () => {
  const page = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /training_session_prescriptions\(workout_name,prescribed_work_ms,prescribed_total_ms\)/);
  assert.doesNotMatch(page, /active_minutes|exercises_completed|workout_session_events/);
  assert.match(page, /\.eq\("athlete_user_id", user\.id\)/);
});

test("Chicago date helper remains the dashboard timezone source", () => {
  const page = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /localDate\(new Date\(\)\)/);
  assert.match(page, /America\/Chicago/);
});
