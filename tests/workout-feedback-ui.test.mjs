import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const component = readFileSync(new URL("../src/components/workout/workout-feedback.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/app/training/[sessionId]/page.tsx", import.meta.url), "utf8");

test("feedback remains online RPC-only and optional after canonical completion", () => {
  assert.match(component, /get_my_workout_feedback/);
  assert.match(component, /list_my_workout_feedback_exercise_options/);
  assert.match(component, /submit_my_workout_feedback/);
  assert.doesNotMatch(component, /workout_result_feedback|workout_session_events|indexedDB|localStorage|sessionStorage|telemetry/i);
  assert.match(component, /Which exercise felt most challenging\?/);
  assert.match(component, /Anything you want your coach to know\?/);
  assert.match(component, /None/);
  assert.match(component, /Skip/);
  assert.match(component, /value="skipped"/);
  assert.match(component, /p_q1_response_state: state/);
  assert.match(component, /const \[dismissed, setDismissed\] = useState\(false\)/);
  assert.match(component, /if \(dismissed\) return null/);
  assert.match(component, /onClick=\{\(\) => setDismissed\(true\)\}/);
  assert.doesNotMatch(component, /Feedback was not submitted/);
  assert.match(component, /500/);
  assert.match(page, /results\?\.\[0\]\?\.id && <WorkoutFeedback resultId=\{results\[0\]\.id\}/);
});
