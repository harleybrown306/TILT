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
  assert.match(loader, /const asOfDate = rows\[0\]\?\.as_of_date/);
  const bounded = loader.slice(loader.indexOf("export async function loadTeamAttentionAttendance"));
  assert.doesNotMatch(bounded, /workout_session_attempts\(/);
  assert.doesNotMatch(bounded, /athlete_user_id/);
  assert.match(bounded, /athlete_id \?\? ""/);
});
