import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { DATABASE_URL_ENV, validateDatabaseUrl, loadTrustedCa, connectionConfig, expectedBError, ledgerEqual, functionFingerprint, fingerprintMatches, exactAcceptanceOverload, hasFixedEmptySearchPath, attachClientErrorHandler, closeClient, abandonBusyClient, unexpectedPhase, SAFE_IDENTITY_SQL } from "./database/run_family_team_invitation_concurrency.mjs";

const path = fileURLToPath(new URL("database/run_family_team_invitation_concurrency.mjs", import.meta.url));
const harness = readFileSync(path, "utf8");
const ref = "bikkjyvoldegbltragzn";
const direct = "postgresql://postgres:synthetic@db." + ref + ".supabase.co:5432/postgres?sslmode=require";
const pooler = "postgresql://postgres." + ref + ":synthetic@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full";
const canonicalAcceptance = "CREATE FUNCTION public.accept_family_team_invitation(text, uuid, text, text, integer) RETURNS TABLE(team_id uuid, athlete_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$ BEGIN PERFORM auth.uid(); accepted_by_profile_id = v_actor; END; $function$";
const syntheticCa = "-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n";
function rejects(url, code) { assert.throws(() => validateDatabaseUrl(url), new RegExp("HARNESS_" + code)); }

test("missing credential fails before any connection attempt", () => {
  const run = spawnSync(process.execPath, [path], { encoding: "utf8", env: { ...process.env, [DATABASE_URL_ENV]: "" } });
  assert.equal(run.status, 1); assert.match(run.stderr, /HARNESS_MISSING_DATABASE_URL/); assert.doesNotMatch(run.stdout + run.stderr, /postgres(?:ql)?:\/\//i);
});
test("accepts exactly the direct project URL shape", () => assert.deepEqual(validateDatabaseUrl(direct), { mode: "direct" }));
test("rejects a direct URL for another project", () => rejects(direct.replace(ref, "wrongprojectref"), "PROJECT_OR_POOLER_MISMATCH"));
test("accepts exactly the session-pooler project URL shape", () => assert.deepEqual(validateDatabaseUrl(pooler), { mode: "session-pooler" }));
test("rejects port 6543 transaction pooling", () => rejects(pooler.replace(":5432/", ":6543/"), "TRANSACTION_POOLER_REJECTED"));
test("rejects non-TLS URLs", () => rejects(direct.replace("?sslmode=require", ""), "TLS_REQUIRED"));
test("rejects an explicit non-TLS sslmode", () => rejects(direct.replace("require", "disable"), "TLS_REQUIRED"));
test("rejects conflicting duplicate sslmode parameters", () => rejects(direct + "&sslmode=disable", "DUPLICATE_SSLMODE"));
test("rejects reversed conflicting duplicate sslmode parameters", () => rejects(direct.replace("require", "disable&sslmode=require"), "DUPLICATE_SSLMODE"));
test("rejects identical duplicate sslmode parameters", () => rejects(direct + "&sslmode=require", "DUPLICATE_SSLMODE"));
test("rejects unexpected URL query parameters", () => rejects(direct + "&application_name=unexpected", "UNEXPECTED_CONNECTION_QUERY_PARAMETER"));
test("rejects a wrong session-pooler project username", () => rejects(pooler.replace("postgres." + ref, "postgres.wrongprojectref"), "PROJECT_OR_POOLER_MISMATCH"));
test("rejects malformed or unrecognized hosts", () => {
  rejects("not a url", "INVALID_DATABASE_URL");
  rejects(direct.replace("db." + ref + ".supabase.co", "database.example.test"), "PROJECT_OR_POOLER_MISMATCH");
});
test("uses three independent native pg clients", () => {
  for (const name of ["tilt-concurrency-A", "tilt-concurrency-B", "tilt-concurrency-observer"]) assert.ok(harness.includes(`application_name: "${name}"`));
});
test("requires a trusted CA certificate path", () => assert.throws(() => loadTrustedCa(""), /HARNESS_MISSING_CA_CERT_PATH/));
test("rejects unreadable or invalid-looking CA material", () => {
  assert.throws(() => loadTrustedCa("missing", () => { throw new Error("synthetic"); }), /HARNESS_UNREADABLE_CA_CERT/);
  assert.throws(() => loadTrustedCa("invalid", () => "not a certificate"), /HARNESS_INVALID_CA_CERT/);
});
test("sanitizes sslmode before supplying explicit verified CA TLS", () => {
  const config = connectionConfig(direct, "synthetic-ca", () => syntheticCa, {});
  assert.doesNotMatch(config.connectionString, /sslmode=/); assert.deepEqual(config.ssl, { ca: syntheticCa, rejectUnauthorized: true });
});
test("rejects process-wide unverified TLS mode", () => assert.throws(() => connectionConfig(direct, "synthetic-ca", () => syntheticCa, { NODE_TLS_REJECT_UNAUTHORIZED: "0" }), /HARNESS_UNSAFE_NODE_TLS_CONFIGURATION/));
test("all clients share the explicit verified CA configuration", () => {
  for (const name of ["tilt-concurrency-A", "tilt-concurrency-B", "tilt-concurrency-observer", "tilt-concurrency-cleanup"]) assert.ok(harness.includes(`...tlsConfig, application_name: "${name}"`));
  assert.match(harness, /rejectUnauthorized: true/); assert.doesNotMatch(harness, /rejectUnauthorized:\s*false/);
});
test("requires distinct backend PIDs before fixtures", () => {
  assert.match(harness, /pg_backend_pid\(\)/); assert.match(harness, /new Set\(pids\)\.size !== 3/); assert.match(harness, /NON_DISTINCT_BACKEND_PIDS/);
});
test("requires the observer to identify A as B's blocker", () => assert.match(harness, /\$1::int = ANY\(pg_blocking_pids\(\$2::int\)\)/));
test("B uses the same captured token and athlete as A", () => assert.match(harness, /const bAttempt = b\.query\("SELECT \* FROM public\.accept_family_team_invitation\(\$1, \$2\)", \[fixture\.token, fixture\.athleteId\]\)/));
test("commits A only after positive blocking proof", () => assert.match(harness, /await waitForBlocking\(observer, pre\.aPid, pre\.bPid\);[\s\S]*await bounded\("A_COMMIT_TIMEOUT"/));
test("asserts B's exact expected SQLSTATE and message", () => {
  assert.equal(expectedBError({ code: "P0001", message: "Family invitation is no longer pending" }), true);
  assert.equal(expectedBError({ code: "P0001", message: "prefix Family invitation is no longer pending" }), false);
  assert.equal(expectedBError({ code: "XX000", message: "Family invitation is no longer pending" }), false);
});
test("keeps cleanup in finally on an independent cleanup client", () => {
  assert.match(harness, /new Client\(\{ \.\.\.tlsConfig, application_name: "tilt-concurrency-cleanup"/);
  assert.match(harness, /finally \{ try \{ if \(fixtureMayExist\) \{ phase = "CLEANUP"; await cleanup\(cleanupSession, fixture\);/);
});
test("cleanup deletes only captured fixture IDs", () => {
  for (const text of ["team_id = $1 AND athlete_id = $2", "WHERE id = $1", "WHERE id = $1 AND athlete_id = $2"]) assert.ok(harness.includes(text));
  assert.doesNotMatch(harness, /DELETE FROM public\.\w+\s*;/);
});
test("zero-residue verification covers all six fixture tables", () => {
  for (const table of ["teams", "team_memberships", "athletes", "athlete_profile_relationships", "family_team_invitations", "team_athlete_memberships"]) assert.ok(harness.includes("FROM public." + table));
  assert.match(harness, /CLEANUP_RESIDUE/);
});
test("captures complete ledger state and compares pre and post snapshots", () => {
  assert.match(harness, /array_agg\(version ORDER BY version\)/); assert.match(harness, /ledgerEqual\(pre\.ledger, await ledgerSnapshot\(observer\)\)/);
  assert.equal(ledgerEqual({ count: 2, versions: ["1", "2"] }, { count: 2, versions: ["1", "2"] }), true);
  assert.equal(ledgerEqual({ count: 2, versions: ["1", "2"] }, { count: 3, versions: ["1", "2", "3"] }), false);
});
test("does not report a false ledger change without a preflight baseline", () => {
  assert.match(harness, /if \(!pre\) \{ report\("ledger_unchanged", "UNAVAILABLE_PRECHECK_NOT_ESTABLISHED"\); \}/);
  assert.match(harness, /else \{ if \(!ledgerEqual\(pre\.ledger, await ledgerSnapshot\(observer\)\)\) fail\("LEDGER_CHANGED"\);/);
});
test("does not use the unstable project setting", () => assert.doesNotMatch(harness, /current_setting\('app\.settings\.project_ref/));
test("uses whitelist diagnostics instead of raw errors or stacks", () => {
  assert.doesNotMatch(harness, /console\.error\(error\)|console\.log\(error\)|error\.stack|connectionString:.*console/);
  assert.match(harness, /HARNESS_UNEXPECTED/);
  assert.doesNotMatch(harness, /console\.(?:log|error)\([^)]*(?:databaseUrl|tlsConfig|CA_CERT_PATH_ENV)/);
});
test("has bounded connection query observer cleanup and ledger phases", () => {
  for (const code of ["CONNECTION_TIMEOUT", "QUERY_TIMEOUT", "OBSERVER_QUERY_TIMEOUT", "CLEANUP_TIMEOUT", "LEDGER_NOT_AT_24632"]) assert.ok(harness.includes(code));
});
test("uses authenticated JWT role semantics and no service-role API bypass", () => {
  assert.match(harness, /SET LOCAL ROLE authenticated/); assert.match(harness, /request\.jwt\.claim\.sub/); assert.match(harness, /auth\.uid\(\)/);
  assert.doesNotMatch(harness, /service_role|SUPABASE_SERVICE_ROLE|NEXT_PUBLIC_SUPABASE|supabase\.rpc|apply_migration|CREATE FUNCTION/);
});
test("uses the exact PostgreSQL literal-dot email regex for safe identities", () => {
  assert.ok(SAFE_IDENTITY_SQL.includes("'^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'"));
  assert.equal(SAFE_IDENTITY_SQL.includes("'^[^[:space:]@]+@[^[:space:]@]+\\\\.[^[:space:]@]+$'"), false);
});
test("safe identity selection retains the reviewed safety predicates and distinct projections", () => {
  for (const part of ["public.profiles p JOIN auth.users u ON u.id = p.id", "u.email_confirmed_at IS NOT NULL", "u.email IS NOT NULL", "btrim(u.email) <> ''", "lower(btrim(u.email))", "NOT private.is_admin(p.id)", "AS manager_id", "AS recipient_id", "AS recipient_email", "WHERE id <> (SELECT id FROM candidates ORDER BY id LIMIT 1)"]) assert.ok(SAFE_IDENTITY_SQL.includes(part));
});
test("preflight requires the exact catalog identity ACL and fingerprint contract", () => {
  for (const part of ["p.proargtypes", "25 2950 25 25 23", "pg_get_function_identity_arguments", "pg_get_function_result", "p.prosecdef", "function_config", "ARRAY['search_path=\\\"\\\"']", "empty_search_path", "aclexplode", "FUNCTION_FINGERPRINT_MISMATCH"]) assert.ok(harness.includes(part));
});
test("recognizes PostgreSQL's exact fixed-empty search-path catalog representation", () => assert.equal(hasFixedEmptySearchPath(['search_path=""']), true));
test("rejects all other search-path catalog representations", () => {
  assert.equal(hasFixedEmptySearchPath(['search_path=']), false);
  assert.equal(hasFixedEmptySearchPath(['search_path=public']), false);
  assert.equal(hasFixedEmptySearchPath([]), false);
  assert.equal(hasFixedEmptySearchPath(['statement_timeout=12s']), false);
  assert.equal(hasFixedEmptySearchPath(null), false);
});
test("exact canonical representation passes only with its matching digest", () => assert.equal(fingerprintMatches(canonicalAcceptance, functionFingerprint(canonicalAcceptance)), true));
test("one function-body character change fails exact fingerprint", () => assert.equal(fingerprintMatches(canonicalAcceptance + " ", functionFingerprint(canonicalAcceptance)), false));
test("comment insertion fails exact fingerprint", () => assert.equal(fingerprintMatches(canonicalAcceptance + " -- reviewed", functionFingerprint(canonicalAcceptance)), false));
test("dead branch insertion fails exact fingerprint", () => assert.equal(fingerprintMatches(canonicalAcceptance.replace("BEGIN", "BEGIN IF false THEN NULL; END IF;"), functionFingerprint(canonicalAcceptance)), false));
test("auth uid mention elsewhere cannot bypass fingerprint", () => assert.equal(fingerprintMatches("SELECT auth.uid(); " + canonicalAcceptance, functionFingerprint(canonicalAcceptance)), false));
test("recipient authorization removal fails exact fingerprint", () => assert.equal(fingerprintMatches(canonicalAcceptance.replace("PERFORM auth.uid();", "PERFORM 1;"), functionFingerprint(canonicalAcceptance)), false));
test("accepted by attribution change fails exact fingerprint", () => assert.equal(fingerprintMatches(canonicalAcceptance.replace("accepted_by_profile_id = v_actor", "accepted_by_profile_id = NULL"), functionFingerprint(canonicalAcceptance)), false));
test("whitespace changes fail when hashing exact pg_get_functiondef bytes", () => assert.equal(fingerprintMatches(canonicalAcceptance.replace(" ", "  "), functionFingerprint(canonicalAcceptance)), false));
test("wrong overload representation fails exact fingerprint", () => assert.equal(fingerprintMatches(canonicalAcceptance.replace("uuid", "text"), functionFingerprint(canonicalAcceptance)), false));
test("missing expected fingerprint fails closed", () => assert.equal(fingerprintMatches(canonicalAcceptance, null), false));
test("fingerprint gate appears before fixture setup", () => assert.match(harness, /MISSING_FUNCTION_FINGERPRINT[\s\S]*FUNCTION_PREFLIGHT_TIMEOUT[\s\S]*FIXTURE_MARKER_COLLISION/));
test("named identity arguments do not weaken exact overload type matching", () => {
  const named = "p_invitation_token text, p_existing_athlete_id uuid, p_first_name text, p_last_name text, p_graduation_year integer";
  assert.equal(exactAcceptanceOverload({ proname: "accept_family_team_invitation", argument_type_oids: "25 2950 25 25 23", named_identity_arguments: named }), true);
  assert.equal(exactAcceptanceOverload({ proname: "accept_family_team_invitation", argument_type_oids: "25 25 25 25 23", named_identity_arguments: named }), false);
});
test("client error events are consumed without exposing raw diagnostics", () => {
  const client = new EventEmitter(); const state = {};
  attachClientErrorHandler(client, state); client.emit("error", new Error("synthetic-secret-value"));
  assert.deepEqual(state, { code: "CLIENT_ASYNC_ERROR" });
});
test("client close is bounded and destroys only its local stream on timeout", async () => {
  let destroyed = false;
  const client = { end: () => new Promise(() => {}), connection: { stream: { destroy: () => { destroyed = true; } } } };
  const state = {}; const started = Date.now(); await closeClient(client, state, 10);
  assert.ok(Date.now() - started < 500); assert.equal(destroyed, true); assert.deepEqual(state, { code: "CLIENT_CLOSE_TIMEOUT" });
});
test("busy B recovery destroys and closes without issuing a client query", async () => {
  let destroyed = false; let queried = false;
  const client = { query: () => { queried = true; }, end: async () => {}, connection: { stream: { destroy: () => { destroyed = true; } } } };
  const state = {}; await abandonBusyClient(client, state, 10);
  assert.equal(destroyed, true); assert.equal(queried, false); assert.deepEqual(state, {});
});
test("failure phases map unexpected errors to allowlisted diagnostics", () => {
  assert.equal(unexpectedPhase("A_ACCEPTANCE", new Error("raw secret")), "HARNESS_UNEXPECTED_A_ACCEPTANCE");
  assert.equal(unexpectedPhase("BLOCKING_PROOF", new Error("raw secret")), "HARNESS_UNEXPECTED_BLOCKING_PROOF");
  assert.equal(unexpectedPhase("FINAL_STATE", new Error("HARNESS_LEDGER_CHANGED")), "HARNESS_LEDGER_CHANGED");
});
test("failure path never queues cleanup or rollback on a busy B client", () => {
  assert.match(harness, /if \(bInFlight\) await abandonBusyClient\(b, clientState\); else await rollback\(b\);/);
  assert.match(harness, /await cleanup\(cleanupSession, fixture\)/);
  assert.doesNotMatch(harness, /pg_terminate_backend/);
});
test("B remains marked busy until its promise actually settles", () => {
  assert.match(harness, /void bAttempt\.then\(\(\) => \{ bInFlight = false; \}, \(\) => \{ bInFlight = false; \}\)/);
  assert.match(harness, /if \(bInFlight \|\| !expectedBError\(error\)\) fail\("B_UNEXPECTED_ERROR"\)/);
});
