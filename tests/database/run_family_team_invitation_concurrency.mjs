import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const DATABASE_URL_ENV = "TILT_CONCURRENCY_DATABASE_URL";
const CA_CERT_PATH_ENV = "TILT_CONCURRENCY_CA_CERT_PATH";
const MODE_ENV = "TILT_FAMILY_CONCURRENCY_MODE";
const LOCAL_DATABASE_URL_ENV = "TILT_FAMILY_CONCURRENCY_LOCAL_DATABASE_URL";
const PROJECT_REF = "bikkjyvoldegbltragzn";
const LEDGER_VERSION = "20260922024632";
const DEADLINE_MS = 15_000;
const POLL_MS = 75;
const EXPECTED_B_ERROR = "Family invitation is no longer pending";
const EXPECTED_B_SQLSTATE = "P0001";
// Reviewed from the separately authorized read-only TILT catalog capture.
const EXPECTED_FUNCTION_FINGERPRINT = "ab074ecbc76e8ba3f98fb17a43bc3b761eb417c2ae76bdcab642d4b70100d99e";
const ACCEPTANCE_ARGUMENT_TYPE_OIDS = "25 2950 25 25 23";
export const SAFE_IDENTITY_SQL = "WITH candidates AS (SELECT p.id, lower(btrim(u.email)) AS email FROM public.profiles p JOIN auth.users u ON u.id = p.id WHERE u.email_confirmed_at IS NOT NULL AND u.email IS NOT NULL AND btrim(u.email) <> '' AND lower(btrim(u.email)) ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$' AND NOT private.is_admin(p.id)) SELECT (SELECT id FROM candidates ORDER BY id LIMIT 1) AS manager_id, (SELECT id FROM candidates WHERE id <> (SELECT id FROM candidates ORDER BY id LIMIT 1) ORDER BY id LIMIT 1) AS recipient_id, (SELECT email FROM candidates WHERE id <> (SELECT id FROM candidates ORDER BY id LIMIT 1) ORDER BY id LIMIT 1) AS recipient_email";

function fail(code) { throw new Error(`HARNESS_${code}`); }
function report(field, value) { console.log(`${field}: ${value}`); }
function bounded(code, promise, ms = DEADLINE_MS) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HARNESS_${code}`)), ms);
  })]).finally(() => clearTimeout(timer));
}
function validateDatabaseUrl(value) {
  if (!value) fail("MISSING_DATABASE_URL");
  let url;
  try { url = new URL(value); } catch { fail("INVALID_DATABASE_URL"); }
  if (!/^(postgres|postgresql):$/.test(url.protocol) || !url.password || url.pathname !== "/postgres") fail("INVALID_DATABASE_URL");
  if ([...url.searchParams.keys()].some((key) => key !== "sslmode")) fail("UNEXPECTED_CONNECTION_QUERY_PARAMETER");
  const sslmodes = url.searchParams.getAll("sslmode");
  if (sslmodes.length === 0) fail("TLS_REQUIRED");
  if (sslmodes.length !== 1) fail("DUPLICATE_SSLMODE");
  if (!sslmodes[0] || !["require", "verify-ca", "verify-full"].includes(sslmodes[0])) fail("TLS_REQUIRED");
  if (url.port === "6543") fail("TRANSACTION_POOLER_REJECTED");
  if (url.port !== "5432") fail("UNRECOGNIZED_CONNECTION_MODE");
  const host = url.hostname.toLowerCase();
  const username = decodeURIComponent(url.username);
  if (host === `db.${PROJECT_REF}.supabase.co` && username === "postgres") return { mode: "direct" };
  if (/^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(host) && username === `postgres.${PROJECT_REF}`) return { mode: "session-pooler" };
  fail("PROJECT_OR_POOLER_MISMATCH");
}
function validateLocalDisposableDatabaseUrl(value) {
  if (!value) fail("MISSING_LOCAL_DISPOSABLE_DATABASE_URL");
  let url; try { url = new URL(value); } catch { fail("INVALID_LOCAL_DISPOSABLE_DATABASE_URL"); }
  if (!/^(postgres|postgresql):$/.test(url.protocol) || !url.password || url.pathname !== "/postgres" || url.search) fail("INVALID_LOCAL_DISPOSABLE_DATABASE_URL");
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname.toLowerCase())) fail("NON_LOOPBACK_LOCAL_TARGET");
  if (!url.port) fail("MISSING_LOCAL_DISPOSABLE_PORT");
  if (url.port === "54322") fail("PROTECTED_TARGET_REFUSED");
  return url.toString();
}
function validateMode(mode = process.env[MODE_ENV] || "REMOTE") {
  if (mode !== "REMOTE" && mode !== "LOCAL_DISPOSABLE") fail("INVALID_MODE");
  return mode;
}
function requireDatabaseUrl() {
  const value = process.env[DATABASE_URL_ENV];
  validateDatabaseUrl(value);
  return value;
}
function loadTrustedCa(path, readFile = readFileSync) {
  if (!path) fail("MISSING_CA_CERT_PATH");
  let certificate;
  try { certificate = readFile(path, "utf8"); } catch { fail("UNREADABLE_CA_CERT"); }
  if (typeof certificate !== "string" || !certificate.includes("-----BEGIN CERTIFICATE-----") || !certificate.includes("-----END CERTIFICATE-----")) fail("INVALID_CA_CERT");
  return certificate;
}
function connectionConfig(databaseUrl, caPath, readFile = readFileSync, environment = process.env) {
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === "0") fail("UNSAFE_NODE_TLS_CONFIGURATION");
  validateDatabaseUrl(databaseUrl);
  const sanitized = new URL(databaseUrl);
  sanitized.search = "";
  return { connectionString: sanitized.toString(), ssl: { ca: loadTrustedCa(caPath, readFile), rejectUnauthorized: true } };
}
function localConnectionConfig(databaseUrl, environment = process.env) {
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === "0") fail("UNSAFE_NODE_TLS_CONFIGURATION");
  return { connectionString: validateLocalDisposableDatabaseUrl(databaseUrl) };
}
function connectionTarget(environment = process.env) {
  const mode = validateMode(environment[MODE_ENV]);
  if (mode === "LOCAL_DISPOSABLE") return { mode, config: localConnectionConfig(environment[LOCAL_DATABASE_URL_ENV], environment) };
  return { mode, config: connectionConfig(environment[DATABASE_URL_ENV], environment[CA_CERT_PATH_ENV], readFileSync, environment) };
}
function token() { return randomBytes(48).toString("base64url"); }
function tokenHash(value) { return createHash("sha256").update(value).digest("hex"); }
function makeFixture(marker) {
  const value = token();
  return { marker, token: value, tokenHash: tokenHash(value), teamId: randomUUID(), athleteId: randomUUID(), relationshipId: randomUUID(), invitationId: null };
}
async function queryOne(client, sql, values = []) { return (await bounded("QUERY_TIMEOUT", client.query(sql, values))).rows[0]; }
async function sessionPid(client) { return Number((await queryOne(client, "SELECT pg_backend_pid() AS pid")).pid); }
async function rollback(client) { try { await bounded("ROLLBACK_TIMEOUT", client.query("ROLLBACK")); } catch {} }
async function configure(client) { await bounded("SESSION_SETUP_TIMEOUT", client.query("SET statement_timeout = '12s'; SET lock_timeout = '10s'")); }
async function beginAuthenticated(client, profileId) {
  await bounded("BEGIN_TIMEOUT", client.query("BEGIN"));
  await bounded("JWT_SETUP_TIMEOUT", client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [profileId]));
  await bounded("ROLE_SETUP_TIMEOUT", client.query("SET LOCAL ROLE authenticated"));
  const actor = await queryOne(client, "SELECT auth.uid()::text AS actor");
  if (actor.actor !== profileId) fail("AUTH_UID_MISMATCH");
  return sessionPid(client);
}
async function serverAccept(client, who, fixture) {
  await client.query("SET LOCAL ROLE service_role");
  let queryError;
  try { return await client.query("SELECT * FROM public.server_accept_family_team_invitation($1,$2,$3,$4,NULL,NULL,NULL)", [who.recipient_id, who.recipient_email, fixture.token, fixture.athleteId]); }
  catch (error) { queryError = error; throw error; }
  finally { try { await client.query("RESET ROLE"); } catch (resetError) { if (!queryError) throw resetError; } }
}
function ledgerEqual(left, right) { return left.count === right.count && left.versions.join(",") === right.versions.join(","); }
async function ledgerSnapshot(observer) {
  const row = await queryOne(observer, "SELECT count(*)::int AS count, coalesce(array_agg(version ORDER BY version), '{}') AS versions FROM supabase_migrations.schema_migrations");
  if (row.versions.filter((version) => version === LEDGER_VERSION).length !== 1) fail("LEDGER_NOT_AT_24632");
  return { count: Number(row.count), versions: row.versions };
}
function functionFingerprint(definition) { return createHash("sha256").update(definition, "utf8").digest("hex"); }
function fingerprintMatches(definition, expected = EXPECTED_FUNCTION_FINGERPRINT) {
  return typeof expected === "string" && /^[a-f0-9]{64}$/.test(expected) && functionFingerprint(definition) === expected;
}
function exactAcceptanceOverload(row) {
  return row.proname === "accept_family_team_invitation" && row.argument_type_oids === ACCEPTANCE_ARGUMENT_TYPE_OIDS;
}
function hasFixedEmptySearchPath(config) {
  return Array.isArray(config) && config.includes('search_path=""');
}
function acceptsContract(row) {
  return exactAcceptanceOverload(row)
    && row.return_type === "TABLE(team_id uuid, athlete_id uuid)" && row.prosecdef && row.empty_search_path && hasFixedEmptySearchPath(row.function_config)
    && !row.authenticated_execute && !row.anon_execute && !row.public_execute && fingerprintMatches(row.definition);
}
async function preflight(observer, a, b, fixture) {
  const ledger = await ledgerSnapshot(observer);
  if (!EXPECTED_FUNCTION_FINGERPRINT) fail("MISSING_FUNCTION_FINGERPRINT");
  const functions = await bounded("FUNCTION_PREFLIGHT_TIMEOUT", observer.query("SELECT p.proname, p.proargtypes::text AS argument_type_oids, pg_get_function_identity_arguments(p.oid) AS named_identity_arguments, pg_get_function_result(p.oid) AS return_type, p.prosecdef, p.proconfig AS function_config, coalesce(p.proconfig, '{}') @> ARRAY['search_path=\"\"'] AS empty_search_path, pg_get_functiondef(p.oid) AS definition, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute, EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS public_execute FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'accept_family_team_invitation' AND p.proargtypes = '25 2950 25 25 23'::oidvector"));
  if (functions.rows.length !== 1) fail("ACCEPTANCE_CONTRACT_MISMATCH");
  if (!fingerprintMatches(functions.rows[0].definition)) fail("FUNCTION_FINGERPRINT_MISMATCH");
  report("FUNCTION_FINGERPRINT_MATCH", "PASS");
  if (!acceptsContract(functions.rows[0])) fail("ACCEPTANCE_CONTRACT_MISMATCH");
  const residue = await queryOne(observer, "SELECT (SELECT count(*) FROM public.teams WHERE id = $1 OR name = $2) AS teams, (SELECT count(*) FROM public.team_memberships WHERE team_id = $1) AS memberships, (SELECT count(*) FROM public.athletes WHERE id = $3 OR display_name = $2) AS athletes, (SELECT count(*) FROM public.athlete_profile_relationships WHERE id = $4 OR athlete_id = $3) AS relationships, (SELECT count(*) FROM public.family_team_invitations WHERE team_id = $1 OR token_hash = $5) AS invitations, (SELECT count(*) FROM public.team_athlete_memberships WHERE team_id = $1 OR athlete_id = $3) AS rosters", [fixture.teamId, fixture.marker, fixture.athleteId, fixture.relationshipId, fixture.tokenHash]);
  if (Object.values(residue).some((value) => Number(value) !== 0)) fail("FIXTURE_MARKER_COLLISION");
  const pids = await Promise.all([sessionPid(a), sessionPid(b), sessionPid(observer)]);
  if (new Set(pids).size !== 3) fail("NON_DISTINCT_BACKEND_PIDS");
  return { ledger, aPid: pids[0], bPid: pids[1], observerPid: pids[2] };
}
async function identities(observer) {
  const row = await queryOne(observer, SAFE_IDENTITY_SQL);
  if (!row.manager_id || !row.recipient_id || !row.recipient_email) fail("NO_SAFE_IDENTITIES");
  return row;
}
async function setup(a, who, fixture) {
  await bounded("FIXTURE_SETUP_TIMEOUT", (async () => {
    await a.query("BEGIN");
    await a.query("INSERT INTO public.teams(id, name, created_by_user_id) VALUES ($1, $2, $3)", [fixture.teamId, fixture.marker, who.manager_id]);
    const coach = await queryOne(a, "SELECT 1 FROM public.team_memberships WHERE team_id = $1 AND user_id = $2 AND role = 'coach'", [fixture.teamId, who.manager_id]);
    if (!coach) fail("MANAGER_COACH_PRECONDITION");
    await a.query("INSERT INTO public.athletes(id, display_name, first_name, last_name, graduation_year, created_by_profile_id) VALUES ($1, $2, 'Concurrency', 'Athlete', 2034, $3)", [fixture.athleteId, fixture.marker, who.recipient_id]);
    await a.query("INSERT INTO public.athlete_profile_relationships(id, athlete_id, profile_id, role, training_permission, manage_permission, created_by_profile_id) VALUES ($1, $2, $3, 'guardian', true, true, $3)", [fixture.relationshipId, fixture.athleteId, who.recipient_id]);
    await a.query("COMMIT"); await beginAuthenticated(a, who.manager_id);
    fixture.invitationId = (await queryOne(a, "SELECT invitation_id FROM public.create_family_team_invitation($1, $2, $3)", [fixture.teamId, who.recipient_email, fixture.tokenHash])).invitation_id;
    await a.query("COMMIT");
  })());
}
async function waitForBlocking(observer, aPid, bPid) {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    const row = await bounded("OBSERVER_QUERY_TIMEOUT", queryOne(observer, "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked_by_a", [aPid, bPid]), 1_000);
    if (row.blocked_by_a) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  fail("BLOCKING_NOT_PROVEN");
}
function expectedBError(error) { return error?.code === EXPECTED_B_SQLSTATE && error?.message === EXPECTED_B_ERROR; }
async function cleanup(client, fixture) {
  await rollback(client);
  await bounded("CLEANUP_TIMEOUT", (async () => {
    await client.query("DELETE FROM public.team_athlete_memberships WHERE team_id = $1 AND athlete_id = $2", [fixture.teamId, fixture.athleteId]);
    await client.query("DELETE FROM public.family_team_invitations WHERE id = $1", [fixture.invitationId]);
    await client.query("DELETE FROM public.athlete_profile_relationships WHERE id = $1 AND athlete_id = $2", [fixture.relationshipId, fixture.athleteId]);
    await client.query("DELETE FROM public.athletes WHERE id = $1", [fixture.athleteId]);
    await client.query("DELETE FROM public.team_memberships WHERE team_id = $1", [fixture.teamId]);
    await client.query("DELETE FROM public.teams WHERE id = $1", [fixture.teamId]);
  })());
}
async function verifyZero(observer, fixture) {
  const row = await queryOne(observer, "SELECT (SELECT count(*) FROM public.teams WHERE id = $1) AS teams, (SELECT count(*) FROM public.team_memberships WHERE team_id = $1) AS memberships, (SELECT count(*) FROM public.athletes WHERE id = $2) AS athletes, (SELECT count(*) FROM public.athlete_profile_relationships WHERE id = $3 AND athlete_id = $2) AS relationships, (SELECT count(*) FROM public.family_team_invitations WHERE id = $4) AS invitations, (SELECT count(*) FROM public.team_athlete_memberships WHERE team_id = $1 AND athlete_id = $2) AS rosters", [fixture.teamId, fixture.athleteId, fixture.relationshipId, fixture.invitationId]);
  if (Object.values(row).some((value) => Number(value) !== 0)) fail("CLEANUP_RESIDUE");
}
function attachClientErrorHandler(client, state) {
  client.on("error", () => { state.code ??= "CLIENT_ASYNC_ERROR"; });
}
function assertNoClientError(state) { if (state.code) fail(state.code); }
async function closeClient(client, state, timeoutMs = 2_000) {
  try { await bounded("CLIENT_CLOSE_TIMEOUT", client.end(), timeoutMs); }
  catch {
    try { client.connection?.stream?.destroy(); } catch {}
    state.code ??= "CLIENT_CLOSE_TIMEOUT";
  }
}
async function closeClients(clients, state, timeoutMs) {
  await Promise.all(clients.map((client) => closeClient(client, state, timeoutMs)));
}
async function abandonBusyClient(client, state, timeoutMs = 2_000) {
  try { client.connection?.stream?.destroy(); } catch {}
  try { await bounded("BUSY_CLIENT_CLOSE_TIMEOUT", client.end(), timeoutMs); }
  catch { state.code ??= "BUSY_CLIENT_CLOSE_TIMEOUT"; }
}
function unexpectedPhase(phase, error) {
  return error?.message?.startsWith("HARNESS_") ? error.message : `HARNESS_UNEXPECTED_${phase}`;
}
async function main() {
  const target = connectionTarget(); report("mode", target.mode);
  const a = new Client({ ...target.config, application_name: "tilt-concurrency-A", connectionTimeoutMillis: DEADLINE_MS });
  const b = new Client({ ...target.config, application_name: "tilt-concurrency-B", connectionTimeoutMillis: DEADLINE_MS });
  const observer = new Client({ ...target.config, application_name: "tilt-concurrency-observer", connectionTimeoutMillis: DEADLINE_MS });
  const cleanupSession = new Client({ ...target.config, application_name: "tilt-concurrency-cleanup", connectionTimeoutMillis: DEADLINE_MS });
  const fixture = makeFixture(`TILT concurrency ${randomUUID()}`); let pre; let overall = "FAIL"; let phase = "CONNECTION"; let fixtureMayExist = false; let bInFlight = false; const clientState = {};
  for (const client of [a, b, observer, cleanupSession]) attachClientErrorHandler(client, clientState);
  try {
    await bounded("CONNECTION_TIMEOUT", Promise.all([a.connect(), b.connect(), observer.connect()])); await Promise.all([configure(a), configure(b), configure(observer)]);
    assertNoClientError(clientState);
    phase = "PREFLIGHT"; pre = await preflight(observer, a, b, fixture); report("preflight", "PASS"); report("A_pid", pre.aPid); report("B_pid", pre.bPid); report("observer_pid", pre.observerPid); report("distinct_sessions", "PASS");
    phase = "CLEANUP_CONNECTION"; await bounded("CLEANUP_CONNECTION_TIMEOUT", cleanupSession.connect()); await configure(cleanupSession); assertNoClientError(clientState);
    phase = "FIXTURE_SETUP"; const who = await identities(observer); fixtureMayExist = true; await setup(a, who, fixture); report("fixture_setup", "PASS");
    assertNoClientError(clientState);
    phase = "AUTHENTICATION"; if (await beginAuthenticated(a, who.recipient_id) !== pre.aPid || await beginAuthenticated(b, who.recipient_id) !== pre.bPid) fail("SESSION_PID_CHANGED");
    phase = "A_ACCEPTANCE"; await bounded("A_ACCEPTANCE_TIMEOUT", serverAccept(a, who, fixture)); report("A_acceptance", "PASS");
    phase = "BLOCKING_PROOF"; const bAttempt = serverAccept(b, who, fixture); bInFlight = true; void bAttempt.then(() => { bInFlight = false; }, () => { bInFlight = false; }); await waitForBlocking(observer, pre.aPid, pre.bPid); report("B_blocked_by_A", "PASS");
    phase = "A_COMMIT"; await bounded("A_COMMIT_TIMEOUT", a.query("COMMIT")); report("A_commit", "PASS");
    phase = "B_RESULT"; try { await bounded("B_RESULT_TIMEOUT", bAttempt); fail("B_UNEXPECTED_SUCCESS"); } catch (error) { if (bInFlight || !expectedBError(error)) fail("B_UNEXPECTED_ERROR"); report("B_post_commit_result", "expected rejection"); }
    await rollback(b);
    phase = "FINAL_STATE"; const final = await queryOne(observer, "SELECT (SELECT count(*) FROM public.team_athlete_memberships WHERE team_id = $1 AND athlete_id = $2) AS roster, (SELECT status FROM public.family_team_invitations WHERE id = $3) AS status", [fixture.teamId, fixture.athleteId, fixture.invitationId]);
    if (Number(final.roster) !== 1 || final.status !== "accepted") fail("RACE_FINAL_STATE"); report("single_roster_membership", "PASS"); report("invitation_final_state_before_cleanup", "accepted"); overall = "PASS";
  } catch (error) { report("failure", unexpectedPhase(phase, error)); await rollback(a); if (bInFlight) await abandonBusyClient(b, clientState); else await rollback(b); }
  finally { try { if (fixtureMayExist) { phase = "CLEANUP"; await cleanup(cleanupSession, fixture); await verifyZero(observer, fixture); report("cleanup", "PASS"); report("zero_residue", "PASS"); } if (!pre) { report("ledger_unchanged", "UNAVAILABLE_PRECHECK_NOT_ESTABLISHED"); } else { if (!ledgerEqual(pre.ledger, await ledgerSnapshot(observer))) fail("LEDGER_CHANGED"); report("ledger_unchanged", "PASS"); } assertNoClientError(clientState); } catch (error) { overall = "FAIL"; report("cleanup_failure", unexpectedPhase(phase, error)); } finally { await closeClients([a, b, observer, cleanupSession], clientState); if (clientState.code) { overall = "FAIL"; report("close_failure", clientState.code); } } }
  report("overall", overall); if (overall !== "PASS") process.exitCode = 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => {
  console.error(error?.message?.startsWith("HARNESS_") ? error.message : "HARNESS_UNEXPECTED");
  process.exitCode = 1;
});
export { DATABASE_URL_ENV, CA_CERT_PATH_ENV, MODE_ENV, LOCAL_DATABASE_URL_ENV, validateDatabaseUrl, validateLocalDisposableDatabaseUrl, validateMode, requireDatabaseUrl, loadTrustedCa, connectionConfig, localConnectionConfig, connectionTarget, expectedBError, ledgerEqual, functionFingerprint, fingerprintMatches, exactAcceptanceOverload, hasFixedEmptySearchPath, attachClientErrorHandler, closeClient, abandonBusyClient, unexpectedPhase };
