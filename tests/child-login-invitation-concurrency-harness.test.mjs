import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { localUrl } from "./database/run_child_login_invitation_concurrency.mjs";

const source = readFileSync(new URL("database/run_child_login_invitation_concurrency.mjs", import.meta.url), "utf8");

test("child-login concurrency target selection requires the explicit disposable endpoint", () => {
  const disposable = "postgresql://postgres:local@127.0.0.1:55552/postgres";
  assert.equal(localUrl(disposable), disposable);
  assert.throws(() => localUrl(), /HARNESS_MISSING_DISPOSABLE_DATABASE_URL/);
  assert.throws(() => localUrl("postgresql://postgres:local@127.0.0.1:54322/postgres"), /HARNESS_PROTECTED_TARGET_REFUSED/);
  for (const value of ["postgresql://postgres:local@127.0.0.1/postgres", "postgresql://postgres:local@10.0.0.1:55552/postgres", "not a URL"]) assert.throws(() => localUrl(value), /HARNESS_(?:DISPOSABLE_TARGET_REQUIRED|INVALID_DISPOSABLE_DATABASE_URL)/);
});

test("child-login concurrency harness is local-safe and structurally complete", () => {
  assert.match(source, /MODE_ENV.*TILT_CHILD_LOGIN_CONCURRENCY_MODE/);
  assert.match(source, /\(process\.env\[MODE_ENV\] \|\| "LOCAL"\) !== "LOCAL"/);
  assert.match(source, /MISSING_DISPOSABLE_DATABASE_URL/);
  assert.match(source, /PROTECTED_TARGET_REFUSED/);
  assert.doesNotMatch(source, /value \|\| LOCAL_URL/);
  assert.match(source, /target: \$\{parsedTarget\.hostname\}:\$\{parsedTarget\.port\}/);
  assert.match(source, /WAIT_MS = 10_000/);
  assert.match(source, /pg_blocking_pids/);
  assert.match(source, /\["a","b","observer","cleanup"\]/);
  assert.match(source, /async function cleanup/);
  assert.match(source, /async function ledger/);
  for (const name of ["sameInvitationSameRecipient", "scenario2", "authorityRace", "scenario5", "scenario6", "scenario7", "scenario8", "acceptanceVsExternalInsert", "externalInsertThenRevoke"]) assert.match(source, new RegExp(`async function ${name}`));
  assert.match(source, /await scenario2\(a,b,observer,control\)/);
  assert.match(source, /scenario_8_creation_vs_creation: PASS/);
  assert.match(source, /await acceptanceVsExternalInsert/);
  assert.match(source, /await externalInsertThenRevoke/);
  assert.doesNotMatch(source, /DISABLE TRIGGER|DROP INDEX|SET session_replication_role/);
  assert.doesNotMatch(source, /revoked_token_vs_replacement|REVOKED_TOKEN_ACCEPTED|scenario9/);
  assert.match(source, /committed SELF row is durable history/);
  assert.match(source, /server_accept_child_login_invitation/);
  assert.match(source, /SET LOCAL ROLE service_role/);
  assert.match(source, /RESET ROLE/);
  assert.match(source, /if \(Number\(selfHistory\.n\) !== 0\) return/);
  const external = source.slice(source.indexOf("async function acceptanceVsExternalInsert"), source.indexOf("async function externalInsertThenRevoke"));
  assert.doesNotMatch(external, /pg_advisory_xact_lock/);
});
