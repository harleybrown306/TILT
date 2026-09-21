import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");

test("home validates the optional athlete URL request through the canonical family resolver", () => {
  assert.match(page, /searchParams: Promise<\{ athlete\?: string \}>/);
  assert.match(page, /loadMyFamilyAthleteContexts\(\)/);
  assert.match(page, /resolveActiveAthleteContext\(familyContexts, requestedAthleteId\)/);
});

test("home queries dashboard sessions by resolved durable athlete identity, never actor identity", () => {
  assert.match(page, /\.eq\("athlete_id", activeContext\.athleteId\)/);
  assert.doesNotMatch(page, /\.eq\("athlete_user_id", user\.id\)/);
  assert.match(page, /athleteId: row\.athlete_id/);
});

test("unauthorized and ambiguous requests fail closed without athlete dashboard data", () => {
  assert.match(page, /athleteResolution\.status === "unauthorized_request" \|\| athleteResolution\.status === "ambiguous_context"/);
  assert.match(page, /Training profile unavailable/);
  assert.match(page, /Return to dashboard/);
});

test("multiple contexts render an accessible durable-athlete selector", () => {
  assert.match(page, /familyContexts\.length > 1/);
  assert.match(page, /aria-label="Training profile"/);
  assert.match(page, /\/?athlete=\$\{encodeURIComponent\(context\.athleteId\)\}/);
  assert.match(page, /context\.displayName/);
});

test("zero contexts stay on the account dashboard and selection does not grant ACT", () => {
  assert.match(page, /activeContext && \(/);
  assert.doesNotMatch(page, /canAct\s*:\s*true|canActForTraining\s*=\s*true/);
  assert.doesNotMatch(page, /localStorage|cookies\(|document\.cookie/);
});
