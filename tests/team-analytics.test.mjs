import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const source = readFileSync(new URL("../src/lib/team-analytics.ts", import.meta.url), "utf8").replace('import { attendanceStatus, shiftDate, type AttendanceSession } from "./team-attendance";', `const shiftDate=(date,days)=>{const [year,month,day]=date.split("-").map(Number);return new Date(Date.UTC(year,month-1,day+days)).toISOString().slice(0,10)}; const attendanceStatus=(session,today)=>session.storedStatus==="cancelled"?"cancelled":session.storedStatus==="completed"||session.completedAt?"completed":session.scheduledDate>today?"upcoming":session.scheduledDate===today?"pending":"missed";`);
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const runtime = { exports: {} }; new vm.Script(`(function(module,exports){${compiled}})`).runInThisContext()(runtime, runtime.exports);
const analytics = runtime.exports, today = "2026-09-14";
const session = (id, athlete, date, status = "completed", work = 60_000) => ({ id, athleteId: athlete, athleteName: athlete, scheduledDate: date, storedStatus: status, workoutName: "Frozen", completedAt: status === "completed" ? `${date}T18:00:00Z` : null, prescribedWorkMs: work });

test("team metrics aggregate completed snapshots and attendance from totals", () => {
  const rows = [session("a", "one", "2026-09-13", "completed", 120_000), session("b", "two", "2026-09-13", "scheduled"), session("c", "three", today, "completed", 60_000), session("d", "four", today, "scheduled"), session("e", "five", "2026-09-15", "completed", 60_000), session("f", "six", "2026-09-12", "cancelled")];
  assert.deepEqual(analytics.teamAnalytics(rows, today, 7), { completedWorkouts: 2, prescribedWorkMs: 180_000, trainingDays: 2, expected: 3, completedExpected: 2, missed: 1, attendance: 67, activeAthletes: 2 });
});
test("missing prescription keeps completion but omits minutes and zero expected is N/A", () => {
  assert.equal(analytics.teamAnalytics([{ ...session("a", "one", "2026-09-13"), prescribedWorkMs: null }], today, 7).completedWorkouts, 1);
  assert.equal(analytics.teamAnalytics([{ ...session("a", "one", today, "scheduled") }], today, 7).attendance, null);
});
test("windows and daily trend stay team-session scoped and include empty dates", () => {
  const trend = analytics.teamTrend([session("a", "one", "2026-08-16", "completed", 60_000)], today, 30);
  assert.equal(trend.length, 30); assert.equal(trend[0].prescribedWorkMs, 60_000); assert.equal(trend.at(-1).prescribedWorkMs, 0);
});
test("analytics route uses the shared guarded team loader with descriptive adherence and without telemetry", () => {
  const page = readFileSync(new URL("../src/app/teams/[teamId]/analytics/page.tsx", import.meta.url), "utf8");
  assert.match(page, /loadTeamAttendance/); assert.match(page, /teamAnalytics/); assert.match(page, /aggregateExerciseAdherence/); assert.doesNotMatch(page, /workout_session_events|active_minutes|exercises_completed/);
});
