import { createHash, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

export const DATABASE_URL_ENV = "TILT_GUARDIAN_CONCURRENCY_DATABASE_URL";
export const MODE_ENV = "TILT_GUARDIAN_CONCURRENCY_MODE";
export const CA_CERT_PATH_ENV = "TILT_CONCURRENCY_CA_CERT_PATH";
export const APPROVED_CA_DER_SHA256 = "807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa";
const PROJECT_REF = "bikkjyvoldegbltragzn";
const LEDGER_VERSION = "20260922194927";
const MIGRATION = "20260922194927_create_guardian_invitation_foundation.sql";
const MIGRATION_SHA = "979182041e92d1cd0b19c83adb379248aca14347c3593278b0984d1d7d449686";
const ACCEPTANCE_FINGERPRINT = "79b35b5baa899577454b6f2160d4f0743e3e254d52bbeb8294f9f09b848eeb3b";
const DEADLINE_MS = 15_000;
const POLL_MS = 75;
const INJECT_STAGE = process.env.TILT_GUARDIAN_CONCURRENCY_INJECT_STAGE;

function fail(code) { throw new Error(`HARNESS_${code}`); }
function report(field, value) { console.log(`${field}: ${value}`); }
function bounded(code, promise, ms = DEADLINE_MS) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`HARNESS_${code}`)), ms); })]).finally(() => clearTimeout(timer));
}
export function validateLocalDatabaseUrl(value) {
  if (!value) fail("MISSING_LOCAL_DATABASE_URL");
  let url; try { url = new URL(value); } catch { fail("INVALID_LOCAL_DATABASE_URL"); }
  if (!/^(postgres|postgresql):$/.test(url.protocol) || !url.password || url.pathname !== "/postgres" || url.search) fail("INVALID_LOCAL_DATABASE_URL");
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname.toLowerCase())) fail("NON_LOOPBACK_TARGET");
  if (url.port === "54322") fail("PROTECTED_TARGET_REFUSED");
  if (!url.port) fail("DISPOSABLE_TARGET_REQUIRED");
  return url.toString();
}
export function validateLiveDatabaseUrl(value) {
  if (!value) fail("MISSING_LIVE_DATABASE_URL"); let url; try { url = new URL(value); } catch { fail("INVALID_LIVE_DATABASE_URL"); }
  if (!/^(postgres|postgresql):$/.test(url.protocol) || !url.password || url.pathname !== "/postgres" || url.port !== "5432") fail("INVALID_LIVE_DATABASE_URL");
  if ([...url.searchParams.keys()].some((key) => key !== "sslmode") || url.searchParams.getAll("sslmode").length !== 1 || !["require", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode"))) fail("LIVE_TLS_REQUIRED");
  const host = url.hostname.toLowerCase(); const username = decodeURIComponent(url.username);
  if (host === `db.${PROJECT_REF}.supabase.co` && username === "postgres") return { mode: "direct", url };
  if (/^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(host) && username === `postgres.${PROJECT_REF}`) return { mode: "session-pooler", url };
  fail("PROJECT_OR_POOLER_MISMATCH");
}
export function validateMode(mode, injectionStage = INJECT_STAGE) {
  if (mode !== "LOCAL" && mode !== "LIVE") fail("INVALID_MODE");
  if (mode === "LIVE" && injectionStage) fail("LIVE_FAILURE_INJECTION_FORBIDDEN");
  return mode;
}
export function certificateFingerprint(value, Certificate = X509Certificate) {
  let certificate;
  try { certificate = new Certificate(value); } catch { fail("INVALID_CA_CERT"); }
  if (!certificate?.raw || !Buffer.isBuffer(certificate.raw)) fail("INVALID_CA_CERT");
  return createHash("sha256").update(certificate.raw).digest("hex");
}
export function loadTrustedCa(path, { readFile = readFileSync, expectedFingerprint = APPROVED_CA_DER_SHA256, Certificate = X509Certificate } = {}) {
  if (!path) fail("MISSING_CA_CERT_PATH"); let value; try { value = readFile(path, "utf8"); } catch { fail("UNREADABLE_CA_CERT"); }
  if (certificateFingerprint(value, Certificate) !== expectedFingerprint) fail("UNAPPROVED_CA_CERT");
  return value;
}
export function connectionConfig(mode, databaseUrl, caPath, caOptions = {}) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") fail("UNSAFE_NODE_TLS_CONFIGURATION");
  if (mode === "LOCAL") return { connectionString: validateLocalDatabaseUrl(databaseUrl) };
  if (mode !== "LIVE") fail("INVALID_MODE"); const { url } = validateLiveDatabaseUrl(databaseUrl); url.search = "";
  return { connectionString: url.toString(), ssl: { ca: loadTrustedCa(caPath, caOptions), rejectUnauthorized: true } };
}
function token() { return randomBytes(48).toString("base64url"); }
function tokenHash(value) { return createHash("sha256").update(value).digest("hex"); }
async function queryOne(client, sql, values = []) { return (await bounded("QUERY_TIMEOUT", client.query(sql, values))).rows[0]; }
async function pid(client) { return Number((await queryOne(client, "SELECT pg_backend_pid() AS pid")).pid); }
async function rollback(client) { try { await bounded("ROLLBACK_TIMEOUT", client.query("ROLLBACK")); } catch {} }
async function beginActor(client, profileId) {
  await bounded("BEGIN_TIMEOUT", client.query("BEGIN"));
  await bounded("JWT_SETUP_TIMEOUT", client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [profileId]));
  await bounded("ROLE_SETUP_TIMEOUT", client.query("SET LOCAL ROLE authenticated"));
  if ((await queryOne(client, "SELECT auth.uid()::text AS actor")).actor !== profileId) fail("AUTH_UID_MISMATCH");
}
function expected(error, message) { return error?.code === "P0001" && error?.message === message; }
function inject(stage) { if (INJECT_STAGE === stage) fail(`INJECTED_${stage.toUpperCase()}`); }
async function expectFailure(client, promise, message) {
  try { await promise; fail("EXPECTED_REJECTION_SUCCEEDED"); }
  catch (error) { if (!expected(error, message)) throw error; }
  await rollback(client);
}
async function waitForBlocking(observer, blockerPid, blockedPid) {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    const row = await queryOne(observer, "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked, state, wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $2", [blockerPid, blockedPid]);
    if (row?.blocked && row.wait_event_type === "Lock") return row;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  fail("BLOCKING_NOT_PROVEN");
}
async function ledger(observer) {
  const row = await queryOne(observer, "SELECT count(*)::int AS count, array_agg(version ORDER BY version) AS versions FROM supabase_migrations.schema_migrations");
  if (row.versions.filter((version) => version === LEDGER_VERSION).length !== 1) fail("LEDGER_CONTRACT_MISMATCH");
  return JSON.stringify(row);
}
export function guardianTableAclIsRestricted(contract) {
  return Boolean(contract.rls && contract.direct_select_denied && contract.direct_insert_denied && contract.direct_update_denied && contract.direct_delete_denied);
}
async function preflight(observer, clients) {
  const migrationPath = fileURLToPath(new URL(`../../supabase/migrations/${MIGRATION}`, import.meta.url));
  if (createHash("sha256").update(readFileSync(migrationPath)).digest("hex") !== MIGRATION_SHA) fail("MIGRATION_SHA_MISMATCH");
  const contract = await queryOne(observer, "SELECT (SELECT relrowsecurity FROM pg_class WHERE oid='public.guardian_invitations'::regclass) AS rls, NOT has_table_privilege('authenticated', 'public.guardian_invitations', 'SELECT') AS direct_select_denied, NOT has_table_privilege('authenticated', 'public.guardian_invitations', 'INSERT') AS direct_insert_denied, NOT has_table_privilege('authenticated', 'public.guardian_invitations', 'UPDATE') AS direct_update_denied, NOT has_table_privilege('authenticated', 'public.guardian_invitations', 'DELETE') AS direct_delete_denied, (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('create_guardian_invitation','accept_guardian_invitation') AND p.prosecdef AND coalesce(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=\"\"']::text[]) AS hardened, to_regprocedure('public.accept_guardian_invitation(text)') IS NOT NULL AS acceptance, to_regprocedure('public.server_accept_guardian_invitation(uuid,text,text)') IS NOT NULL AS server_acceptance, to_regprocedure('public.create_guardian_invitation(uuid,text,text,timestamptz)') IS NOT NULL AS creator, to_regclass('public.guardian_invitations_one_pending_per_email') IS NOT NULL AS pending_unique, to_regclass('public.athlete_profile_relationships_active_role_unique') IS NOT NULL AS relationship_unique, (SELECT NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('public', p.oid, 'EXECUTE') AND encode(extensions.digest(pg_get_functiondef(p.oid), 'sha256'), 'hex')=$1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='accept_guardian_invitation' AND p.proargtypes='25'::oidvector) AS acceptance_fingerprint, has_function_privilege('service_role','public.server_accept_guardian_invitation(uuid,text,text)'::regprocedure,'EXECUTE') AND NOT has_function_privilege('authenticated','public.server_accept_guardian_invitation(uuid,text,text)'::regprocedure,'EXECUTE') AND NOT has_function_privilege('anon','public.server_accept_guardian_invitation(uuid,text,text)'::regprocedure,'EXECUTE') AS server_acceptance_acl", [ACCEPTANCE_FINGERPRINT]);
  if (!guardianTableAclIsRestricted(contract) || Number(contract.hardened) !== 2 || !contract.acceptance || !contract.server_acceptance || !contract.creator || !contract.pending_unique || !contract.relationship_unique || !contract.acceptance_fingerprint || !contract.server_acceptance_acl) fail("GUARDIAN_CONTRACT_MISMATCH");
  const pids = await Promise.all(clients.map(pid));
  if (new Set(pids).size !== clients.length) fail("NON_DISTINCT_BACKEND_PIDS");
  return { ledger: await ledger(observer), pids };
}
function fixture(marker) { return { marker, ids: [], athletes: [], relationships: [], invitations: [], users: [], tokenByInvitation: new Map() }; }
export function recoveryManifest(f) {
  return {
    status: "OWNED_OR_POSSIBLY_PRESENT",
    run_marker: f.marker,
    auth_user_ids: [...f.users],
    profile_ids: [...f.users],
    athlete_ids: [...f.athletes],
    directly_created_relationship_ids: [...f.relationships],
    invitation_token_hashes: f.invitations.map((invitation) => invitation.tokenHash),
    invitation_ownership: f.invitations.map(({ id, tokenHash, athleteId, recipientId, inviterId }) => ({ invitation_id: id, token_hash: tokenHash, athlete_id: athleteId, recipient_profile_id: recipientId, inviter_profile_id: inviterId })),
  };
}
export function cleanupFailureRecovery(f, code = "HARNESS_CLEANUP_FAILURE") {
  return { failure: code, zero_residue: "NOT_CLAIMED", recovery: recoveryManifest(f) };
}
async function createUser(control, f, label) {
  const id = randomUUID(); const email = `${f.marker}-${label}@example.test`;
  f.users.push(id); // Register ownership before the mutation: auth trigger/profile results may be ambiguous to the client.
  await control.query("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,CURRENT_TIMESTAMP)", [id, email]);
  return { id, email };
}
async function createAthlete(control, f, manager, suffix) {
  const id = randomUUID(); const relationshipId = randomUUID();
  f.athletes.push(id); f.relationships.push(relationshipId); // Both IDs exist in the manifest before either setup write.
  await control.query("INSERT INTO public.athletes(id,display_name,created_by_profile_id) VALUES($1,$2,$3)", [id, `${f.marker} athlete ${suffix}`, manager.id]);
  await control.query("INSERT INTO public.athlete_profile_relationships(id,athlete_id,profile_id,role,training_permission,manage_permission,created_by_profile_id) VALUES($1,$2,$3,'guardian',true,true,$3)", [relationshipId, id, manager.id]);
  return { id, relationshipId };
}
async function createInvitation(control, manager, athlete, recipient, f) {
  const raw = token(); const hash = tokenHash(raw); const ownership = { id: null, tokenHash: hash, athleteId: athlete.id, recipientId: recipient.id, inviterId: manager.id };
  f.invitations.push(ownership); // Recovery is exact-token-hash based even if the RPC commit/response is ambiguous.
  await beginActor(control, manager.id);
  const row = await queryOne(control, "SELECT invitation_id FROM public.create_guardian_invitation($1,$2,$3)", [athlete.id, recipient.email, hash]);
  await control.query("COMMIT"); ownership.id = row.invitation_id; f.tokenByInvitation.set(row.invitation_id, raw); inject("after-committed-invitation"); return { id: row.invitation_id, token: raw };
}
async function setup(control, f, recipientCount = 1) {
  const manager = await createUser(control, f, "manager"); inject("after-auth"); const recipients = [];
  for (let index = 0; index < recipientCount; index += 1) recipients.push(await createUser(control, f, `recipient-${index + 1}`));
  const athlete = await createAthlete(control, f, manager, "primary"); inject("after-athlete"); const invitations = [];
  for (const recipient of recipients) invitations.push(await createInvitation(control, manager, athlete, recipient, f)); inject("after-invitation");
  return { manager, recipients, athlete, invitations };
}
async function cleanup(control, f) {
  try {
    await rollback(control);
    await control.query("DELETE FROM public.guardian_invitations WHERE token_hash = ANY($1::text[])", [f.invitations.map((invitation) => invitation.tokenHash)]);
    await control.query("DELETE FROM public.athlete_profile_relationships WHERE athlete_id = ANY($1::uuid[]) AND profile_id = ANY($2::uuid[])", [f.athletes, f.users]);
    for (const id of f.athletes) await control.query("DELETE FROM public.athletes WHERE id=$1", [id]);
    for (const id of f.users) { await control.query("DELETE FROM public.profiles WHERE id=$1", [id]); await control.query("DELETE FROM auth.users WHERE id=$1", [id]); }
    const row = await queryOne(control, "SELECT (SELECT count(*) FROM public.athletes WHERE id = ANY($1::uuid[])) AS athletes, (SELECT count(*) FROM public.guardian_invitations WHERE token_hash = ANY($2::text[])) AS invitations, (SELECT count(*) FROM public.athlete_profile_relationships WHERE athlete_id = ANY($1::uuid[])) AS relationships, (SELECT count(*) FROM public.profiles WHERE id = ANY($3::uuid[])) AS profiles, (SELECT count(*) FROM auth.users WHERE id = ANY($3::uuid[])) AS users", [f.athletes, f.invitations.map((invitation) => invitation.tokenHash), f.users]);
    if (Object.values(row).some((value) => Number(value) !== 0)) {
      const confirmed = await queryOne(control, "SELECT ARRAY(SELECT id::text FROM public.athletes WHERE id = ANY($1::uuid[])) AS athlete_ids, ARRAY(SELECT token_hash FROM public.guardian_invitations WHERE token_hash = ANY($2::text[])) AS invitation_token_hashes, ARRAY(SELECT id::text FROM public.athlete_profile_relationships WHERE athlete_id = ANY($1::uuid[]) AND profile_id = ANY($3::uuid[])) AS relationship_ids, ARRAY(SELECT id::text FROM public.profiles WHERE id = ANY($3::uuid[])) AS profile_ids, ARRAY(SELECT id::text FROM auth.users WHERE id = ANY($3::uuid[])) AS auth_user_ids", [f.athletes, f.invitations.map((invitation) => invitation.tokenHash), f.users]);
      report("confirmed_residue", JSON.stringify({ status: "CONFIRMED_RESIDUE", ...confirmed }));
      fail("CLEANUP_RESIDUE");
    }
  } catch (error) {
    const recovery = cleanupFailureRecovery(f, error?.message?.startsWith("HARNESS_") ? error.message : "HARNESS_CLEANUP_FAILURE");
    report("cleanup_failure", recovery.failure);
    report("unresolved_harness_owned_fixture_recovery", JSON.stringify(recovery));
    throw error;
  }
}
async function accept(client, recipient, invitation) { await beginActor(client, recipient.id); await client.query("SET LOCAL ROLE service_role"); let queryError; try { return await client.query("SELECT * FROM public.server_accept_guardian_invitation($1,$2,$3)", [recipient.id, recipient.email.trim().toLowerCase(), invitation.token]); } catch (error) { queryError = error; throw error; } finally { try { await client.query("RESET ROLE"); } catch (resetError) { if (!queryError) throw resetError; } } }
async function relationshipCount(observer, athlete, recipient) { return Number((await queryOne(observer, "SELECT count(*) AS count FROM public.athlete_profile_relationships WHERE athlete_id=$1 AND profile_id=$2 AND role='guardian' AND revoked_at IS NULL AND NOT manage_permission AND NOT training_permission", [athlete.id, recipient.id])).count); }
async function invitationStatus(observer, invitation) { return (await queryOne(observer, "SELECT status FROM public.guardian_invitations WHERE id=$1", [invitation.id])).status; }
async function scenarioSame(a, b, observer, control, pids) {
  const f = fixture(`guardian-concurrency-${randomUUID()}`); try {
    const x = await setup(control, f); await accept(a, x.recipients[0], x.invitations[0]);
    if (INJECT_STAGE === "after-committed-acceptance") { await a.query("COMMIT"); inject("after-committed-acceptance"); }
    const pending = accept(b, x.recipients[0], x.invitations[0]); const evidence = await waitForBlocking(observer, pids[0], pids[1]);
    await a.query("COMMIT"); await expectFailure(b, pending, "Guardian invitation is no longer pending");
    const state = await queryOne(observer, "SELECT status FROM public.guardian_invitations WHERE id=$1", [x.invitations[0].id]);
    if (state.status !== "accepted" || await relationshipCount(observer, x.athlete, x.recipients[0]) !== 1) fail("SAME_FINAL_STATE");
    report("scenario_1_same_invitation", `PASS blocked=${evidence.wait_event_type ?? "unknown"}`);
  } finally { await rollback(a); await rollback(b); await cleanup(control, f); }
}
async function scenarioCompeting(a, b, observer, control, pids) {
  const f = fixture(`guardian-concurrency-${randomUUID()}`); try {
    const x = await setup(control, f, 2); await accept(a, x.recipients[0], x.invitations[0]);
    const pending = accept(b, x.recipients[1], x.invitations[1]); const evidence = await waitForBlocking(observer, pids[0], pids[1]);
    await a.query("COMMIT"); await bounded("COMPETING_RESULT_TIMEOUT", pending); await b.query("COMMIT");
    for (const index of [0, 1]) if (await relationshipCount(observer, x.athlete, x.recipients[index]) !== 1 || await invitationStatus(observer, x.invitations[index]) !== "accepted") fail("COMPETING_FINAL_STATE");
    report("scenario_2_competing", `PASS blocked=${evidence.wait_event_type ?? "unknown"}`);
  } finally { await rollback(a); await rollback(b); await cleanup(control, f); }
}
async function scenarioAuthority(a, b, observer, control, pids) {
  let f = fixture(`guardian-concurrency-${randomUUID()}`); try {
    let x = await setup(control, f); await accept(a, x.recipients[0], x.invitations[0]); await b.query("BEGIN"); const update = b.query("UPDATE public.athlete_profile_relationships SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1", [x.athlete.relationshipId]); const first = await waitForBlocking(observer, pids[0], pids[1]); await a.query("COMMIT"); await update; await b.query("COMMIT"); if (await relationshipCount(observer, x.athlete, x.recipients[0]) !== 1 || await invitationStatus(observer, x.invitations[0]) !== "accepted") fail("AUTHORITY_ACCEPT_FIRST_STATE"); report("scenario_3a_accept_first", `PASS blocked=${first.wait_event_type ?? "unknown"}`);
  } finally { await rollback(a); await rollback(b); await cleanup(control, f); }
  f = fixture(`guardian-concurrency-${randomUUID()}`); try {
    const x = await setup(control, f); await b.query("BEGIN"); await b.query("UPDATE public.athlete_profile_relationships SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1", [x.athlete.relationshipId]); const pending = accept(a, x.recipients[0], x.invitations[0]); const second = await waitForBlocking(observer, pids[1], pids[0]); await b.query("COMMIT"); await expectFailure(a, pending, "Inviter no longer has guardian permission to share access"); if (await relationshipCount(observer, x.athlete, x.recipients[0]) !== 0 || await invitationStatus(observer, x.invitations[0]) !== "pending") fail("AUTHORITY_LOSS_FINAL_STATE"); report("scenario_3b_authority_first", `PASS blocked=${second.wait_event_type ?? "unknown"}`);
  } finally { await rollback(a); await rollback(b); await cleanup(control, f); }
  f = fixture(`guardian-concurrency-${randomUUID()}`); try {
    const x = await setup(control, f); await control.query("UPDATE public.athlete_profile_relationships SET manage_permission=false WHERE id=$1", [x.athlete.relationshipId]); await expectFailure(a, accept(a, x.recipients[0], x.invitations[0]), "Inviter no longer has guardian permission to share access"); if (await relationshipCount(observer, x.athlete, x.recipients[0]) !== 0 || await invitationStatus(observer, x.invitations[0]) !== "pending") fail("MANAGE_LOSS_FINAL_STATE"); report("authority_variant_manage_false", "PASS");
  } finally { await rollback(a); await rollback(b); await cleanup(control, f); }
}
async function scenarioArchive(a, b, observer, control, pids) {
  let f = fixture(`guardian-concurrency-${randomUUID()}`); try {
    let x = await setup(control, f); await accept(a, x.recipients[0], x.invitations[0]); await b.query("BEGIN"); const update = b.query("UPDATE public.athletes SET status='archived', archived_at=CURRENT_TIMESTAMP WHERE id=$1", [x.athlete.id]); const first = await waitForBlocking(observer, pids[0], pids[1]); await a.query("COMMIT"); await update; await b.query("COMMIT"); if (await relationshipCount(observer, x.athlete, x.recipients[0]) !== 1 || await invitationStatus(observer, x.invitations[0]) !== "accepted") fail("ARCHIVE_ACCEPT_FIRST_STATE"); report("scenario_4a_accept_first", `PASS blocked=${first.wait_event_type ?? "unknown"}`);
  } finally { await rollback(a); await rollback(b); await cleanup(control, f); }
  f = fixture(`guardian-concurrency-${randomUUID()}`); try {
    const x = await setup(control, f); await b.query("BEGIN"); await b.query("UPDATE public.athletes SET status='archived', archived_at=CURRENT_TIMESTAMP WHERE id=$1", [x.athlete.id]); const pending = accept(a, x.recipients[0], x.invitations[0]); const second = await waitForBlocking(observer, pids[1], pids[0]); await b.query("COMMIT"); await expectFailure(a, pending, "Athlete is unavailable"); if (await relationshipCount(observer, x.athlete, x.recipients[0]) !== 0 || await invitationStatus(observer, x.invitations[0]) !== "pending") fail("ARCHIVE_FIRST_FINAL_STATE"); report("scenario_4b_archive_first", `PASS blocked=${second.wait_event_type ?? "unknown"}`);
  } finally { await rollback(a); await rollback(b); await cleanup(control, f); }
}
async function close(client) { try { await client.end(); } catch { try { client.connection?.stream?.destroy(); } catch {} } }
async function main() {
  const mode = validateMode(process.env[MODE_ENV]); const connection = connectionConfig(mode, process.env[DATABASE_URL_ENV], process.env[CA_CERT_PATH_ENV]);
  if (mode === "LOCAL") { const target = new URL(connection.connectionString); report("target", `${target.hostname}:${target.port}${target.pathname}`); }
  const clients = ["A", "B", "observer", "cleanup"].map((name) => new Client({ ...connection, application_name: `tilt-guardian-concurrency-${name}`, connectionTimeoutMillis: DEADLINE_MS }));
  const [a, b, observer, control] = clients; let before;
  try {
    await bounded("CONNECTION_TIMEOUT", Promise.all(clients.map((client) => client.connect())));
    await Promise.all(clients.map((client) => client.query("SET statement_timeout='12s'; SET lock_timeout='10s'")));
    before = await preflight(observer, [a, b, observer, control]); report("preflight", "PASS"); report("distinct_sessions", "PASS");
    await scenarioSame(a, b, observer, control, before.pids); await scenarioCompeting(a, b, observer, control, before.pids); await scenarioAuthority(a, b, observer, control, before.pids); await scenarioArchive(a, b, observer, control, before.pids);
    if (before.ledger !== await ledger(observer)) fail("LEDGER_CHANGED"); report("ledger_unchanged", "PASS"); report("overall", "PASS");
  } finally { await Promise.all(clients.map(rollback)); await Promise.all(clients.map(close)); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { console.error(error?.message?.startsWith("HARNESS_") ? error.message : "HARNESS_UNEXPECTED"); process.exitCode = 1; });
