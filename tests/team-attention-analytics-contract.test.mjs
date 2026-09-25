import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../supabase/migrations/20260925212434_create_bounded_team_attention_analytics.sql", import.meta.url), "utf8");
const loader = readFileSync(new URL("../src/lib/team-attendance-server.ts", import.meta.url), "utf8");

test("bounded attention RPC has the exact derived projection and privileged boundary", () => {
  assert.match(migration, /CREATE FUNCTION public\.list_my_team_attention_sessions\([\s\S]*p_team_id uuid/);
  for (const column of ["as_of_date date", "session_id uuid", "athlete_id uuid", "scheduled_date date", "is_cancelled boolean", "has_canonical_completion boolean", "prescribed_work_ms bigint", "adherence_completed_work_blocks integer", "adherence_prescribed_work_blocks integer"]) assert.match(migration, new RegExp(column));
  assert.match(migration, /LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER\s+SET search_path TO ''/);
  assert.match(migration, /private\.can_view_team_analytics\(p_team_id\)/);
  assert.match(migration, /scheduled_date >= v_as_of_date - 29[\s\S]*scheduled_date < v_as_of_date \+ 1/);
  assert.match(migration, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC[\s\S]*REVOKE ALL ON FUNCTION[\s\S]*FROM anon[\s\S]*REVOKE ALL ON FUNCTION[\s\S]*FROM authenticated[\s\S]*GRANT EXECUTE[\s\S]*TO authenticated/);
  assert.doesNotMatch(migration, /athlete_user_id|workout_session_events|LIMIT 1/);
});

test("bounded loader uses the RPC as-of date and never reads raw ACT-only attempts", () => {
  assert.match(loader, /loadTeamAttentionAttendance/);
  assert.match(loader, /list_my_team_attention_sessions/);
  assert.match(loader, /let asOfDate: string/);
  const bounded = loader.slice(loader.indexOf("export async function loadTeamAttentionAttendance"));
  assert.doesNotMatch(bounded, /workout_session_attempts\(/);
  assert.doesNotMatch(bounded, /athlete_user_id/);
  assert.match(bounded, /athlete_id \?\? ""/);
});

test("empty bounded snapshots use an authorized database anchor rather than a fake row or server clock", () => {
  const anchor = readFileSync(new URL("../supabase/migrations/20260925214831_add_team_attention_as_of_date.sql", import.meta.url), "utf8");
  assert.match(anchor, /CREATE FUNCTION public\.get_team_attention_as_of_date\(\s*p_team_id uuid/);
  assert.match(anchor, /private\.can_view_team_analytics\(p_team_id\)/);
  assert.match(anchor, /transaction_timestamp\(\) AT TIME ZONE 'America\/Chicago'/);
  assert.match(anchor, /REVOKE ALL[\s\S]*FROM PUBLIC[\s\S]*REVOKE ALL[\s\S]*FROM anon[\s\S]*GRANT EXECUTE[\s\S]*TO authenticated/);
  assert.match(loader, /if \(rows\.length === 0\)[\s\S]*get_team_attention_as_of_date/);
  assert.match(loader, /else \{[\s\S]*typeof candidate !== "string"[\s\S]*rows\.some\(\(row\) => row\.as_of_date !== candidate\)/);
  assert.doesNotMatch(loader.slice(loader.indexOf("export async function loadTeamAttentionAttendance")), /localDate\(new Date|new Date\(/);
});

test("operational analytics exclude cancelled facts without falsifying canonical completion", () => {
  const home = readFileSync(new URL("../src/app/teams/[teamId]/page.tsx", import.meta.url), "utf8");
  const attention = readFileSync(new URL("../src/lib/coach-attention-signals.ts", import.meta.url), "utf8");
  const analytics = readFileSync(new URL("../src/app/teams/[teamId]/analytics/page.tsx", import.meta.url), "utf8");
  assert.match(home, /const isOperationalCompletion[\s\S]*storedStatus !== "cancelled" && Boolean\(session\.hasCanonicalCompletion\)/);
  assert.match(home, /completedSessions = sessions\.filter\(isOperationalCompletion\)/);
  assert.match(home, /athleteSessions\.filter\(isOperationalCompletion\)/);
  assert.match(attention, /session\.storedStatus !== "cancelled"/);
  assert.match(analytics, /session\.storedStatus !== "cancelled" && completedInWindow/);
});
