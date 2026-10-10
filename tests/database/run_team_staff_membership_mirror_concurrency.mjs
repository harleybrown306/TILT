import { randomUUID } from "node:crypto";
import { Client } from "pg";

export const DATABASE_URL_ENV = "TILT_STAFF_MIRROR_CONCURRENCY_DATABASE_URL";
export const MODE_ENV = "TILT_STAFF_MIRROR_CONCURRENCY_MODE";
const WAIT_MS = 10_000;

function fail(code) { throw new Error(`HARNESS_${code}`); }

export function localUrl(value) {
  if (!value) fail("MISSING_DISPOSABLE_DATABASE_URL");
  let url;
  try { url = new URL(value); } catch { fail("INVALID_DISPOSABLE_DATABASE_URL"); }
  if (!/^postgres(?:ql)?:$/.test(url.protocol) || !["127.0.0.1", "localhost"].includes(url.hostname)
    || url.pathname !== "/postgres" || url.search || !url.port) fail("DISPOSABLE_TARGET_REQUIRED");
  if (url.port === "54322") fail("PROTECTED_TARGET_REFUSED");
  return url.toString();
}

async function one(client, query, values = []) { return (await client.query(query, values)).rows[0]; }
async function rollback(client) { try { await client.query("ROLLBACK"); } catch {} }
async function ledger(client) { return JSON.stringify((await client.query("SELECT version FROM supabase_migrations.schema_migrations ORDER BY version")).rows); }

async function waitFor(observer, blockerPid, waiterPid) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const row = await one(observer, "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked", [blockerPid, waiterPid]);
    if (row.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  fail("BLOCKING_NOT_PROVEN");
}

async function waitForParentCleanupPause(observer, parentPid) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const row = await one(observer, `
      SELECT wait_event = 'PgSleep' AS paused
      FROM pg_stat_activity
      WHERE pid = $1
    `, [parentPid]);
    if (row?.paused) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  fail("PARENT_CLEANUP_NOT_PROVEN");
}

async function identities(client) {
  const row = await one(client, `
    WITH candidates AS (
      SELECT profile.id
      FROM public.profiles AS profile
      JOIN auth.users AS user_record ON user_record.id = profile.id
      WHERE user_record.email IS NOT NULL AND btrim(user_record.email) <> ''
      ORDER BY profile.id
    )
    SELECT
      (SELECT id FROM candidates LIMIT 1) AS manager_id,
      (SELECT id FROM candidates WHERE id <> (SELECT id FROM candidates LIMIT 1) LIMIT 1) AS staff_id
  `);
  if (!row?.manager_id || !row?.staff_id) fail("NO_SAFE_IDENTITIES");
  return row;
}

async function assertParity(client, membershipId, expectedRole) {
  const row = await one(client, `
    SELECT
      (SELECT count(*)::int FROM public.team_memberships WHERE id = $1 AND role::text = $2) AS legacy_count,
      (SELECT count(*)::int FROM public.team_staff_memberships WHERE id = $1 AND role::text = $2) AS canonical_count
  `, [membershipId, expectedRole]);
  if (Number(row.legacy_count) !== 1 || Number(row.canonical_count) !== 1) fail("MIRROR_PARITY_FAILURE");
}

async function fixture(control, identities) {
  const teamId = randomUUID();
  const unrelatedTeamId = randomUUID();
  const marker = `staff-mirror-concurrency-${randomUUID()}`;
  const unrelatedMarker = `staff-mirror-unrelated-${randomUUID()}`;
  await control.query("BEGIN");
  try {
    await control.query("INSERT INTO public.teams(id,name,created_by_user_id) VALUES($1,$2,$3)", [teamId, marker, identities.manager_id]);
    await control.query("INSERT INTO public.teams(id,name,created_by_user_id) VALUES($1,$2,$3)", [unrelatedTeamId, unrelatedMarker, identities.manager_id]);
    const staff = await one(control, `
      INSERT INTO public.team_memberships(team_id,user_id,role,created_by_user_id)
      VALUES($1,$2,'assistant_coach',$3)
      RETURNING id
    `, [teamId, identities.staff_id, identities.manager_id]);
    const unrelatedStaff = await one(control, `
      INSERT INTO public.team_memberships(team_id,user_id,role,created_by_user_id)
      VALUES($1,$2,'assistant_coach',$3)
      RETURNING id
    `, [unrelatedTeamId, identities.staff_id, identities.manager_id]);
    await control.query("COMMIT");
    return {
      teamId,
      membershipId: staff.id,
      unrelatedTeamId,
      unrelatedMembershipId: unrelatedStaff.id,
    };
  } catch (error) {
    await rollback(control);
    throw error;
  }
}

async function cleanup(control, fixtureData) {
  if (!fixtureData) return;
  await rollback(control);
  await control.query("DELETE FROM public.teams WHERE id = ANY($1::uuid[])", [[fixtureData.teamId, fixtureData.unrelatedTeamId]]);
  const residue = await one(control, `
    SELECT
      (SELECT count(*)::int FROM public.teams WHERE id = ANY($1::uuid[])) AS teams,
      (SELECT count(*)::int FROM public.team_memberships WHERE team_id = ANY($1::uuid[])) AS legacy_rows,
      (SELECT count(*)::int FROM public.team_staff_memberships WHERE team_id = ANY($1::uuid[])) AS canonical_rows
  `, [[fixtureData.teamId, fixtureData.unrelatedTeamId]]);
  if (Object.values(residue).some((value) => Number(value) !== 0)) fail("CLEANUP_RESIDUE");
}

async function installParentDeletePause(control) {
  await control.query(`
    CREATE OR REPLACE FUNCTION private.pause_team_delete_for_staff_mirror_harness()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      PERFORM pg_sleep(2);
      RETURN OLD;
    END
    $$
  `);
  await control.query("DROP TRIGGER IF EXISTS zz_pause_team_delete_for_staff_mirror_harness ON public.teams");
  await control.query(`
    CREATE TRIGGER zz_pause_team_delete_for_staff_mirror_harness
    BEFORE DELETE ON public.teams
    FOR EACH ROW EXECUTE FUNCTION private.pause_team_delete_for_staff_mirror_harness()
  `);
}

async function removeParentDeletePause(control) {
  await control.query("DROP TRIGGER IF EXISTS zz_pause_team_delete_for_staff_mirror_harness ON public.teams");
  await control.query("DROP FUNCTION IF EXISTS private.pause_team_delete_for_staff_mirror_harness()");
}

async function assertParentDeleteFinal(observer, data, code) {
  const final = await one(observer, `
    SELECT
      (SELECT count(*)::int FROM public.teams WHERE id = $1) AS teams,
      (SELECT count(*)::int FROM public.team_memberships WHERE team_id = $1) AS legacy_rows,
      (SELECT count(*)::int FROM public.team_staff_memberships WHERE team_id = $1) AS canonical_rows,
      (SELECT count(*)::int FROM public.team_memberships WHERE id = $2 AND team_id = $3) AS unrelated_legacy_rows,
      (SELECT count(*)::int FROM public.team_staff_memberships WHERE id = $2 AND team_id = $3) AS unrelated_canonical_rows
  `, [data.teamId, data.unrelatedMembershipId, data.unrelatedTeamId]);
  if (Number(final.teams) !== 0 || Number(final.legacy_rows) !== 0 || Number(final.canonical_rows) !== 0
    || Number(final.unrelated_legacy_rows) !== 1 || Number(final.unrelated_canonical_rows) !== 1) {
    fail(code);
  }
}

async function lifecycleRace(a, b, observer, control) {
  const who = await identities(observer);
  const data = await fixture(control, who);
  try {
    await assertParity(observer, data.membershipId, "assistant_coach");
    const aPid = Number((await one(a, "SELECT pg_backend_pid() AS pid")).pid);
    const bPid = Number((await one(b, "SELECT pg_backend_pid() AS pid")).pid);

    await a.query("BEGIN");
    await a.query("UPDATE public.team_memberships SET role = 'coach' WHERE id = $1", [data.membershipId]);
    const pendingDelete = (async () => {
      await b.query("BEGIN");
      await b.query("DELETE FROM public.team_memberships WHERE id = $1", [data.membershipId]);
    })();
    await waitFor(observer, aPid, bPid);
    await assertParity(observer, data.membershipId, "assistant_coach");
    await a.query("COMMIT");
    await pendingDelete;
    await b.query("COMMIT");

    const final = await one(observer, `
      SELECT
        (SELECT count(*)::int FROM public.team_memberships WHERE id = $1) AS legacy_rows,
        (SELECT count(*)::int FROM public.team_staff_memberships WHERE id = $1) AS canonical_rows
    `, [data.membershipId]);
    if (Number(final.legacy_rows) !== 0 || Number(final.canonical_rows) !== 0) fail("RACE_FINAL_STATE");
    console.log("role_update_vs_removal: PASS");
  } finally {
    await rollback(a);
    await rollback(b);
    await cleanup(control, data);
  }
}

async function parentDeleteVsReconciliation(a, b, observer, control) {
  const who = await identities(observer);
  const data = await fixture(control, who);
  let pauseInstalled = false;
  try {
    await assertParity(observer, data.membershipId, "assistant_coach");
    await assertParity(observer, data.unrelatedMembershipId, "assistant_coach");
    const aPid = Number((await one(a, "SELECT pg_backend_pid() AS pid")).pid);
    const bPid = Number((await one(b, "SELECT pg_backend_pid() AS pid")).pid);

    await installParentDeletePause(control);
    pauseInstalled = true;
    await a.query("BEGIN");
    const pendingDelete = (async () => {
      await a.query("DELETE FROM public.teams WHERE id = $1", [data.teamId]);
    })();
    await waitForParentCleanupPause(observer, aPid);
    await b.query("BEGIN");
    const pendingReconciliation = (async () => {
      await b.query("SELECT private.reconcile_team_staff_memberships()");
    })();
    await waitFor(observer, aPid, bPid);
    await pendingDelete;
    await a.query("COMMIT");
    await pendingReconciliation;
    await b.query("COMMIT");

    await assertParentDeleteFinal(observer, data, "PARENT_DELETE_RECONCILIATION_FINAL_STATE");
    console.log("parent_delete_vs_reconciliation: PASS");
  } finally {
    await rollback(a);
    await rollback(b);
    if (pauseInstalled) await removeParentDeletePause(control);
    await cleanup(control, data);
  }
}

async function parentDeleteVsLegacyMutation(a, b, observer, control, name, mutationSql) {
  const who = await identities(observer);
  const data = await fixture(control, who);
  let pauseInstalled = false;
  try {
    await assertParity(observer, data.membershipId, "assistant_coach");
    await assertParity(observer, data.unrelatedMembershipId, "assistant_coach");
    const aPid = Number((await one(a, "SELECT pg_backend_pid() AS pid")).pid);
    const bPid = Number((await one(b, "SELECT pg_backend_pid() AS pid")).pid);

    await installParentDeletePause(control);
    pauseInstalled = true;
    await a.query("BEGIN");
    const pendingDelete = (async () => {
      await a.query("DELETE FROM public.teams WHERE id = $1", [data.teamId]);
    })();
    await waitForParentCleanupPause(observer, aPid);
    await b.query("BEGIN");
    const pendingMutation = (async () => {
      await b.query(mutationSql, [data.membershipId]);
    })();
    await waitFor(observer, aPid, bPid);
    await pendingDelete;
    await a.query("COMMIT");
    await pendingMutation;
    await b.query("COMMIT");

    await assertParentDeleteFinal(observer, data, `${name.toUpperCase()}_FINAL_STATE`);
    console.log(`${name}: PASS`);
  } finally {
    await rollback(a);
    await rollback(b);
    if (pauseInstalled) await removeParentDeletePause(control);
    await cleanup(control, data);
  }
}

export async function main() {
  if (process.env[MODE_ENV] !== "LOCAL_DISPOSABLE") fail("LIVE_MODE_FORBIDDEN");
  const databaseUrl = localUrl(process.env[DATABASE_URL_ENV]);
  const config = { connectionString: databaseUrl };
  const [a, b, observer, control] = ["a", "b", "observer", "control"].map((name) => new Client({ ...config, application_name: `tilt-staff-mirror-${name}` }));
  try {
    await Promise.all([a, b, observer, control].map((client) => client.connect()));
    const before = await ledger(observer);
    await lifecycleRace(a, b, observer, control);
    await parentDeleteVsReconciliation(a, b, observer, control);
    await parentDeleteVsLegacyMutation(
      a, b, observer, control,
      "parent_delete_vs_legacy_role_update",
      "UPDATE public.team_memberships SET role = 'coach' WHERE id = $1",
    );
    await parentDeleteVsLegacyMutation(
      a, b, observer, control,
      "parent_delete_vs_legacy_removal",
      "DELETE FROM public.team_memberships WHERE id = $1",
    );
    if (before !== await ledger(observer)) fail("LEDGER_CHANGED");
    console.log("ledger_unchanged: PASS");
    console.log("overall: PASS");
  } finally {
    await Promise.all([a, b, observer, control].map(async (client) => { await rollback(client); await client.end(); }));
  }
}

if (process.argv[1]?.endsWith("run_team_staff_membership_mirror_concurrency.mjs")) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
