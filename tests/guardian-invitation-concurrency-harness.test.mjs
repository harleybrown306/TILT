import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { validateLocalDatabaseUrl, validateLiveDatabaseUrl, validateMode, certificateFingerprint, connectionConfig, guardianTableAclIsRestricted, recoveryManifest, cleanupFailureRecovery } from "./database/run_guardian_invitation_concurrency.mjs";

const path = fileURLToPath(new URL("database/run_guardian_invitation_concurrency.mjs", import.meta.url));
const harness = readFileSync(path, "utf8");
const local = "postgresql://postgres:local@127.0.0.1:55552/postgres";
const live = "postgresql://postgres:synthetic@db.bikkjyvoldegbltragzn.supabase.co:5432/postgres?sslmode=verify-full";
class SyntheticCertificate {
  constructor(value) {
    if (value !== "parseable synthetic certificate") throw new Error("invalid certificate");
    this.raw = Buffer.from("canonical synthetic DER", "utf8");
  }
}
const syntheticCa = "parseable synthetic certificate";
const syntheticFingerprint = createHash("sha256").update(Buffer.from("canonical synthetic DER", "utf8")).digest("hex");
const fixture = {
  marker: "local-cleanup-fixture",
  users: ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"],
  athletes: ["00000000-0000-4000-8000-000000000003"],
  relationships: ["00000000-0000-4000-8000-000000000004"],
  invitations: [{ id: "00000000-0000-4000-8000-000000000005", tokenHash: "approved-token-hash", athleteId: "00000000-0000-4000-8000-000000000003", recipientId: "00000000-0000-4000-8000-000000000002", inviterId: "00000000-0000-4000-8000-000000000001" }],
  tokenByInvitation: new Map([["00000000-0000-4000-8000-000000000005", "raw-bearer-token-must-never-appear"]]),
};

test("guardian concurrency harness accepts only an explicit disposable local database endpoint", () => {
  assert.equal(validateLocalDatabaseUrl(local), local);
  assert.throws(() => validateLocalDatabaseUrl("postgresql://postgres:local@127.0.0.1:54322/postgres"), /HARNESS_PROTECTED_TARGET_REFUSED/);
  for (const value of ["postgresql://postgres:local@db.bikkjyvoldegbltragzn.supabase.co:5432/postgres", "postgresql://postgres:local@127.0.0.1/postgres", "postgresql://postgres:local@10.0.0.1:55552/postgres", ""]) assert.throws(() => validateLocalDatabaseUrl(value), /HARNESS_(?:NON_LOOPBACK_TARGET|MISSING_LOCAL_DATABASE_URL|DISPOSABLE_TARGET_REQUIRED)/);
  assert.match(harness, /PROTECTED_TARGET_REFUSED/);
  assert.match(harness, /report\("target"/);
});
test("guardian concurrency mode is explicit and rejects live failure injection before connection", () => {
  assert.equal(validateMode("LOCAL", "after-athlete"), "LOCAL");
  assert.equal(validateMode("LIVE"), "LIVE");
  for (const mode of [undefined, "", "local", "TEST"]) assert.throws(() => validateMode(mode), /HARNESS_INVALID_MODE/);
  assert.throws(() => validateMode("LIVE", "after-athlete"), /HARNESS_LIVE_FAILURE_INJECTION_FORBIDDEN/);
});
test("live mode accepts only the reviewed direct or session target with pinned X.509 CA TLS", () => {
  assert.equal(validateLiveDatabaseUrl(live).mode, "direct");
  assert.equal(validateLiveDatabaseUrl("postgresql://postgres.bikkjyvoldegbltragzn:synthetic@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require").mode, "session-pooler");
  for (const value of [local, live.replace(":5432", ":6543"), live.replace("bikkjyvoldegbltragzn", "wrongproject"), live.replace("?sslmode=verify-full", "")]) assert.throws(() => validateLiveDatabaseUrl(value), /HARNESS_/);
  const caOptions = { readFile: () => syntheticCa, expectedFingerprint: syntheticFingerprint, Certificate: SyntheticCertificate };
  const config = connectionConfig("LIVE", live, "synthetic", caOptions); assert.equal(config.ssl.rejectUnauthorized, true); assert.equal(config.ssl.ca, syntheticCa); assert.doesNotMatch(config.connectionString, /sslmode/);
  assert.throws(() => connectionConfig("LIVE", live, "", caOptions), /HARNESS_MISSING_CA_CERT_PATH/);
  assert.throws(() => connectionConfig("LIVE", live, "synthetic", { ...caOptions, readFile: () => "-----BEGIN CERTIFICATE-----\nnot a certificate\n-----END CERTIFICATE-----" }), /HARNESS_INVALID_CA_CERT/);
  assert.throws(() => connectionConfig("LIVE", live, "synthetic", { ...caOptions, expectedFingerprint: "0".repeat(64) }), /HARNESS_UNAPPROVED_CA_CERT/);
  assert.equal(certificateFingerprint(syntheticCa, SyntheticCertificate), syntheticFingerprint);
});
test("guardian harness proves native blocking with four distinct clients and no backend termination", () => {
  assert.match(harness, /\["A", "B", "observer", "cleanup"\]\.map/);
  assert.match(harness, /application_name: `tilt-guardian-concurrency-\$\{name\}`/);
  assert.match(harness, /pg_backend_pid\(\)/); assert.match(harness, /pg_blocking_pids/); assert.match(harness, /wait_event_type/);
  assert.doesNotMatch(harness, /pg_terminate_backend|rejectUnauthorized:\s*false/);
});
test("guardian harness pins local migration preflight, hardened RPC contract, and exact cleanup", () => {
  for (const text of ["20260922194927", "979182041e92d1cd0b19c83adb379248aca14347c3593278b0984d1d7d449686", "79b35b5baa899577454b6f2160d4f0743e3e254d52bbeb8294f9f09b848eeb3b", "807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa", "pg_get_functiondef", "accept_guardian_invitation' AND p.proargtypes='25'::oidvector", "guardian_invitations", "SET LOCAL ROLE authenticated", "request.jwt.claim.sub", "DELETE FROM public.guardian_invitations WHERE token_hash = ANY($1::text[])", "DELETE FROM public.athlete_profile_relationships WHERE athlete_id = ANY($1::uuid[]) AND profile_id = ANY($2::uuid[])", "FROM public.profiles WHERE id = ANY($3::uuid[])", "DELETE FROM auth.users WHERE id=$1"]) assert.ok(harness.includes(text));
  assert.doesNotMatch(harness, /DELETE FROM public\.[a-z_]+\s*;/);
});
test("guardian table preflight rejects each authenticated direct-access drift", () => {
  const safe = { rls: true, direct_select_denied: true, direct_insert_denied: true, direct_update_denied: true, direct_delete_denied: true };
  assert.equal(guardianTableAclIsRestricted(safe), true);
  for (const key of ["direct_select_denied", "direct_insert_denied", "direct_update_denied", "direct_delete_denied"]) assert.equal(guardianTableAclIsRestricted({ ...safe, [key]: false }), false);
  assert.equal(guardianTableAclIsRestricted({ ...safe, rls: false }), false);
});
test("cleanup-failure reporting is allow-listed and never claims zero residue", () => {
  const recovery = recoveryManifest(fixture);
  const serialized = JSON.stringify(cleanupFailureRecovery(fixture));
  assert.equal(recovery.status, "OWNED_OR_POSSIBLY_PRESENT");
  assert.deepEqual(recovery.auth_user_ids, fixture.users);
  assert.deepEqual(recovery.profile_ids, fixture.users);
  assert.deepEqual(recovery.athlete_ids, fixture.athletes);
  assert.deepEqual(recovery.directly_created_relationship_ids, fixture.relationships);
  assert.deepEqual(recovery.invitation_token_hashes, ["approved-token-hash"]);
  assert.equal(recovery.invitation_ownership[0].recipient_profile_id, fixture.users[1]);
  assert.match(serialized, /NOT_CLAIMED/);
  assert.doesNotMatch(serialized, /raw-bearer-token|postgresql:|password|BEGIN CERTIFICATE|jwt/i);
  assert.match(harness, /status: "CONFIRMED_RESIDUE"/);
  assert.match(harness, /invitation_token_hashes/);
});
test("guardian harness covers real serialized replay, competing recipients, authority loss, and archive orders", () => {
  for (const text of ["scenario_1_same_invitation", "scenario_2_competing", "scenario_3a_accept_first", "scenario_3b_authority_first", "authority_variant_manage_false", "scenario_4a_accept_first", "scenario_4b_archive_first", "Guardian invitation is no longer pending", "Inviter no longer has guardian permission to share access", "Athlete is unavailable"]) assert.ok(harness.includes(text));
  assert.match(harness, /guardian_invitations_one_pending_per_email/);
});
test("guardian harness registers cleanup ownership before each mutation and requires a real lock wait", () => {
  assert.match(harness, /f\.users\.push\(id\);[\s\S]*INSERT INTO auth\.users/);
  assert.match(harness, /f\.athletes\.push\(id\); f\.relationships\.push\(relationshipId\);[\s\S]*INSERT INTO public\.athletes/);
  assert.match(harness, /f\.invitations\.push\(ownership\);[\s\S]*create_guardian_invitation/);
  assert.match(harness, /row\?\.blocked && row\.wait_event_type === "Lock"/);
  assert.doesNotMatch(harness, /TRUNCATE|CASCADE|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']0/);
});
test("fingerprint and committed-state cleanup gates are pinned before fixture setup", () => {
  assert.match(harness, /ACCEPTANCE_FINGERPRINT/); assert.match(harness, /pg_get_functiondef\(p\.oid\)/);
  assert.match(harness, /preflight\(observer, \[a, b, observer, control\]\)[\s\S]*scenarioSame/);
  assert.match(harness, /inject\("after-committed-invitation"\)/); assert.match(harness, /await a\.query\("COMMIT"\); inject\("after-committed-acceptance"\)/);
  assert.doesNotMatch(harness, /rejectUnauthorized:\s*false|ssl:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']0/);
  assert.match(harness, /new Certificate\(value\)/); assert.match(harness, /UNAPPROVED_CA_CERT/);
  assert.match(harness, /direct_select_denied/); assert.match(harness, /direct_insert_denied/); assert.match(harness, /direct_update_denied/); assert.match(harness, /direct_delete_denied/);
  assert.match(harness, /LIVE_FAILURE_INJECTION_FORBIDDEN/); assert.match(harness, /zero_residue: "NOT_CLAIMED"/);
});
test("guardian harness stays athlete-family scoped and does not create team or training fixtures", () => {
  assert.doesNotMatch(harness, /INSERT INTO public\.(?:teams|team_memberships|team_athlete_memberships|workouts|training_sessions|workout_results)/);
  assert.match(harness, /INSERT INTO auth\.users/); assert.match(harness, /INSERT INTO public\.athletes/); assert.match(harness, /INSERT INTO public\.athlete_profile_relationships/);
});
