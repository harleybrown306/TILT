import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../src/app/teams/[teamId]/page.tsx", import.meta.url), "utf8");

test("team home derives attention from the guarded family-first loader before summary and roster", () => {
  assert.match(page, /loadTeamAttendance\(teamId\)/);
  assert.match(page, /deriveCoachAttentionSignals\(\{ sessions, today \}\)/);
  assert.ok(page.indexOf('id="attention-heading"') < page.indexOf('aria-label="Team summary"'));
  assert.ok(page.indexOf('id="attention-heading"') < page.indexOf("Roster"));
  assert.doesNotMatch(page, /team_memberships|athlete_user_id|createClient|service_role/);
});

test("attention presents only approved factual evidence with restrained empty state", () => {
  assert.match(page, /\{signal\.text\}/);
  assert.match(page, /No eligible attention signals in the current closed-window data\./);
  assert.doesNotMatch(page, /first_tilt_completion|return_to_completed_training|at risk|struggling|lazy|disengaged|top performer|risk score|badge|streak|recommend|warning|alarm|workout_session_events/);
});

test("attention offers schedule inspection and durable athlete detail only for current roster athletes", () => {
  assert.match(page, /schedule\?athlete=\$\{encodeURIComponent\(signal\.athleteId\)\}/);
  assert.match(page, /View schedule for \{signal\.athleteName\}/);
  assert.match(page, /currentAthleteIds\.has\(signal\.athleteId\)/);
  assert.match(page, /View \{signal\.athleteName\}/);
});

test("attention is semantic and neutral for both positive and negative factual signals", () => {
  assert.match(page, /<section className="mb-10" aria-labelledby="attention-heading">/);
  assert.match(page, /<ul className="mt-4 space-y-3">/);
  assert.match(page, /border-slate-800 bg-slate-900/);
  assert.doesNotMatch(page, /border-(?:red|amber|yellow|rose)|bg-(?:red|amber|yellow|rose)/);
});
