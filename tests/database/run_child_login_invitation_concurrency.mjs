import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";

export const DATABASE_URL_ENV = "TILT_CHILD_LOGIN_CONCURRENCY_DATABASE_URL";
export const MODE_ENV = "TILT_CHILD_LOGIN_CONCURRENCY_MODE";
const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const VERSION = "20260923201138";
const WAIT_MS = 10_000;

function fail(code) { throw new Error(`HARNESS_${code}`); }
function token() { return randomBytes(48).toString("base64url"); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
export function localUrl(value) {
  const url = new URL(value || LOCAL_URL);
  if (!/^postgres(?:ql)?:$/.test(url.protocol) || !["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "54322" || url.pathname !== "/postgres") fail("LOCAL_TARGET_REQUIRED");
  return url.toString();
}
async function one(c, q, v = []) { return (await c.query(q, v)).rows[0]; }
async function begin(c, id) { await c.query("BEGIN"); await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [id]); }
async function rollback(c) { try { await c.query("ROLLBACK"); } catch {} }
async function waitFor(observer, blocker, waiter) {
  const end = Date.now() + WAIT_MS;
  while (Date.now() < end) {
    const row = await one(observer, "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked FROM pg_stat_activity WHERE pid=$2", [blocker, waiter]);
    if (row?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  fail("BLOCKING_NOT_PROVEN");
}
async function user(c, f, label) {
  const id = randomUUID(); const email = `${f.marker}-${label}@example.test`; f.users.push(id);
  await c.query("INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES($1,'authenticated','authenticated',$2,clock_timestamp(),'{\"provider\":\"email\",\"providers\":[\"email\"]}','{}',clock_timestamp(),clock_timestamp())", [id, email]);
  return { id, email };
}
async function fixture(control, f) {
  const manager = await user(control, f, "manager"); const recipient = await user(control, f, "recipient");
  const athlete = randomUUID(); f.athletes.push(athlete);
  await control.query("INSERT INTO public.athletes(id,display_name,created_by_profile_id) VALUES($1,$2,$3)", [athlete, `${f.marker} athlete`, manager.id]);
  await control.query("INSERT INTO public.athlete_profile_relationships(athlete_id,profile_id,role,training_permission,manage_permission,created_by_profile_id) VALUES($1,$2,'guardian',true,true,$2)", [athlete, manager.id]);
  const raw = token(); await begin(control, manager.id); const row = await one(control, "SELECT invitation_id FROM public.create_child_login_invitation($1,$2,$3)", [athlete, recipient.email, hash(raw)]); await control.query("COMMIT");
  f.invitations.push(row.invitation_id);
  return { manager, recipient, athlete, raw, invitation: row.invitation_id };
}
async function cleanup(control, f) {
  await rollback(control);
  const selfHistory = await one(control, "SELECT count(*)::int AS n FROM public.athlete_profile_relationships WHERE athlete_id=ANY($1::uuid[]) AND role='self'", [f.athletes]);
  // A committed SELF row is durable history; the disposable database is reset after the harness.
  if (Number(selfHistory.n) !== 0) return;
  await control.query("DELETE FROM public.child_login_invitations WHERE id=ANY($1::uuid[])", [f.invitations]);
  await control.query("DELETE FROM public.athlete_profile_relationships WHERE athlete_id=ANY($1::uuid[])", [f.athletes]);
  await control.query("DELETE FROM public.athletes WHERE id=ANY($1::uuid[])", [f.athletes]);
  await control.query("DELETE FROM auth.users WHERE id=ANY($1::uuid[])", [f.users]);
  const left = await one(control, "SELECT (SELECT count(*) FROM auth.users WHERE id=ANY($1::uuid[]))+(SELECT count(*) FROM public.athletes WHERE id=ANY($2::uuid[]))+(SELECT count(*) FROM public.child_login_invitations WHERE id=ANY($3::uuid[])) AS n", [f.users, f.athletes, f.invitations]);
  if (Number(left.n) !== 0) fail("CLEANUP_RESIDUE");
}
async function ledger(c) { return JSON.stringify((await c.query("SELECT version FROM supabase_migrations.schema_migrations ORDER BY version")).rows); }
async function acceptanceOwnsLock(a, x) { await begin(a, x.recipient.id); return a.query("SELECT * FROM public.accept_child_login_invitation($1)", [x.raw]); }

async function sameInvitationSameRecipient(a, b, observer, control) {
  const f = { marker: `13ea-harness-${randomUUID()}`, users: [], athletes: [], invitations: [] };
  try {
    const x = await fixture(control, f); const aPid = Number((await one(a, "SELECT pg_backend_pid() AS pid")).pid); const bPid = Number((await one(b, "SELECT pg_backend_pid() AS pid")).pid);
    const first = await acceptanceOwnsLock(a, x); await begin(b, x.recipient.id);
    const second = b.query("SELECT * FROM public.accept_child_login_invitation($1)", [x.raw]); await waitFor(observer, aPid, bPid);
    const firstRow = (await first).rows[0]; await a.query("COMMIT"); const secondRow = (await second).rows[0]; await b.query("COMMIT");
    const state = await one(observer, "SELECT (SELECT count(*)::int FROM public.athlete_profile_relationships WHERE athlete_id=$1 AND profile_id=$2 AND role='self' AND revoked_at IS NULL) AS self_count,(SELECT status FROM public.child_login_invitations WHERE id=$3) AS status", [x.athlete,x.recipient.id,x.invitation]);
    if (firstRow.athlete_id !== x.athlete || secondRow.athlete_id !== x.athlete || Number(state.self_count) !== 1 || state.status !== 'accepted') fail("SAME_INVITATION_FINAL_STATE");
    console.log("scenario_1_same_invitation_same_recipient: PASS");
  } finally { await rollback(a); await rollback(b); await cleanup(control, f); }
}

async function scenario8(a,b,observer,control) { const f={marker:`13ea-harness-${randomUUID()}`,users:[],athletes:[],invitations:[]}; try { const x=await fixture(control,f); await control.query("DELETE FROM public.child_login_invitations WHERE id=$1",[x.invitation]); f.invitations=[]; const r2=await user(control,f,"recipient-2"); const ap=Number((await one(a,"SELECT pg_backend_pid() AS pid")).pid),bp=Number((await one(b,"SELECT pg_backend_pid() AS pid")).pid); await begin(a,x.manager.id); const first=a.query("SELECT * FROM public.create_child_login_invitation($1,$2,$3)",[x.athlete,x.recipient.email,hash(token())]); await begin(b,x.manager.id); const second=b.query("SELECT * FROM public.create_child_login_invitation($1,$2,$3)",[x.athlete,r2.email,hash(token())]); await waitFor(observer,ap,bp); const winner=(await first).rows[0]; f.invitations.push(winner.invitation_id); await a.query("COMMIT"); try{await second;fail("CREATION_LOSER_SUCCEEDED");}catch(e){if(e.code!=="P0001")throw e;} await rollback(b); console.log("scenario_8_creation_vs_creation: PASS"); } finally{await rollback(a);await rollback(b);await cleanup(control,f);} }

async function authorityRace(a,b,observer,control,field,label) {
 const f={marker:`13ea-harness-${randomUUID()}`,users:[],athletes:[],invitations:[]}; try {const x=await fixture(control,f); const rel=await one(control,"SELECT id FROM public.athlete_profile_relationships WHERE athlete_id=$1 AND profile_id=$2 AND role='guardian'",[x.athlete,x.manager.id]); const ap=Number((await one(a,"SELECT pg_backend_pid() AS pid")).pid),bp=Number((await one(b,"SELECT pg_backend_pid() AS pid")).pid); await b.query("BEGIN"); await b.query(field==='revoked'?"UPDATE public.athlete_profile_relationships SET revoked_at=clock_timestamp() WHERE id=$1":"UPDATE public.athlete_profile_relationships SET manage_permission=false WHERE id=$1",[rel.id]); const pending=acceptanceOwnsLock(a,x); await waitFor(observer,bp,ap); await b.query("COMMIT"); try {await pending;fail(`${label}_ACCEPTED`);}catch(e){if(e.code!=="P0001")throw e;} await rollback(a); const s=await one(observer,"SELECT (SELECT status FROM public.child_login_invitations WHERE id=$1) AS status,(SELECT count(*)::int FROM public.athlete_profile_relationships WHERE athlete_id=$2 AND profile_id=$3 AND role='self') AS self_count",[x.invitation,x.athlete,x.recipient.id]); if(s.status!=="pending"||Number(s.self_count)!==0)fail(`${label}_STATE`); console.log(`${label}: PASS`);} finally {await rollback(a);await rollback(b);await cleanup(control,f);} }

async function acceptanceVsExternalInsert(a, b, observer, control) {
  const f = { marker: `13ea-harness-${randomUUID()}`, users: [], athletes: [], invitations: [] };
  try {
    const x = await fixture(control, f); const aPid = Number((await one(a, "SELECT pg_backend_pid() AS pid")).pid); const bPid = Number((await one(b, "SELECT pg_backend_pid() AS pid")).pid);
    const accepted = await acceptanceOwnsLock(a, x);
    await begin(b, x.manager.id);
    const direct = b.query("INSERT INTO public.athlete_profile_relationships(athlete_id,profile_id,role,training_permission,manage_permission,created_by_profile_id) VALUES($1,$2,'self',true,true,$2)", [x.athlete, x.manager.id]);
    await waitFor(observer, aPid, bPid); // caller did not take an advisory lock: the table trigger is the blocker.
    await a.query("COMMIT"); await accepted;
    try { await direct; fail("EXTERNAL_SELF_INSERT_UNEXPECTEDLY_SUCCEEDED"); } catch (error) { if (error.code !== "23505") throw error; }
    await rollback(b);
    const row = await one(observer, "SELECT count(*)::int AS n FROM public.athlete_profile_relationships WHERE athlete_id=$1 AND role='self' AND revoked_at IS NULL", [x.athlete]);
    if (Number(row.n) !== 1) fail("EXTERNAL_INSERT_FINAL_STATE");
    console.log("acceptance_vs_external_self_insert: PASS");
  } finally { await rollback(a); await rollback(b); await cleanup(control, f); }
}

async function scenario5(a,b,observer,control) { const f={marker:`13ea-harness-${randomUUID()}`,users:[],athletes:[],invitations:[]}; try {const x=await fixture(control,f),ap=Number((await one(a,"SELECT pg_backend_pid() AS pid")).pid),bp=Number((await one(b,"SELECT pg_backend_pid() AS pid")).pid); await b.query("BEGIN");await b.query("UPDATE public.athletes SET status='archived',archived_at=clock_timestamp() WHERE id=$1",[x.athlete]);const p=acceptanceOwnsLock(a,x);await waitFor(observer,bp,ap);await b.query("COMMIT");try{await p;fail("ARCHIVE_ACCEPTED");}catch(e){if(e.code!=="P0001")throw e;}await rollback(a);const s=await one(observer,"SELECT (SELECT status FROM public.athletes WHERE id=$1) AS athlete,(SELECT status FROM public.child_login_invitations WHERE id=$2) AS invitation",[x.athlete,x.invitation]);if(s.athlete!=="archived"||s.invitation!=="pending")fail("SCENARIO_5_STATE");console.log("scenario_5_acceptance_vs_archive: PASS");}finally{await rollback(a);await rollback(b);await cleanup(control,f);}}
async function scenario6(a,b,observer,control) { const f={marker:`13ea-harness-${randomUUID()}`,users:[],athletes:[],invitations:[]}; try {const x=await fixture(control,f),ap=Number((await one(a,"SELECT pg_backend_pid() AS pid")).pid),bp=Number((await one(b,"SELECT pg_backend_pid() AS pid")).pid);await begin(b,x.manager.id);const r=b.query("SELECT public.revoke_child_login_invitation($1)",[x.invitation]);const p=acceptanceOwnsLock(a,x);await waitFor(observer,bp,ap);await r;await b.query("COMMIT");try{await p;fail("REVOKED_ACCEPTED");}catch(e){if(e.code!=="P0001")throw e;}await rollback(a);const s=await one(observer,"SELECT status,revoked_at FROM public.child_login_invitations WHERE id=$1",[x.invitation]);if(s.status!=="revoked"||!s.revoked_at)fail("SCENARIO_6_STATE");console.log("scenario_6_acceptance_vs_revocation: PASS");}finally{await rollback(a);await rollback(b);await cleanup(control,f);}}
async function scenario7(a,b,observer,control) { const f={marker:`13ea-harness-${randomUUID()}`,users:[],athletes:[],invitations:[]}; try {const x=await fixture(control,f),other=await user(control,f,"other"),ap=Number((await one(a,"SELECT pg_backend_pid() AS pid")).pid),bp=Number((await one(b,"SELECT pg_backend_pid() AS pid")).pid);const p=await acceptanceOwnsLock(a,x);await begin(b,x.manager.id);const c=b.query("SELECT * FROM public.create_child_login_invitation($1,$2,$3)",[x.athlete,other.email,hash(token())]);await waitFor(observer,ap,bp);await p;await a.query("COMMIT");try{await c;fail("POST_ACCEPT_CREATE_SUCCEEDED");}catch(e){if(e.code!=="P0001")throw e;}await rollback(b);console.log("scenario_7_creation_vs_acceptance: PASS");}finally{await rollback(a);await rollback(b);await cleanup(control,f);}}

async function scenario2(a,b,observer,control) {
 const f={marker:`13ea-harness-${randomUUID()}`,users:[],athletes:[],invitations:[]}; try {
  const x=await fixture(control,f); const manager2=await user(control,f,"manager-2"); const athlete2=randomUUID(); f.athletes.push(athlete2);
  await control.query("INSERT INTO public.athletes(id,display_name,created_by_profile_id) VALUES($1,$2,$3)",[athlete2,`${f.marker} athlete-2`,manager2.id]);
  await control.query("INSERT INTO public.athlete_profile_relationships(athlete_id,profile_id,role,training_permission,manage_permission,created_by_profile_id) VALUES($1,$2,'guardian',true,true,$2)",[athlete2,manager2.id]);
  await begin(control,manager2.id); const raw2=token(); const i2=await one(control,"SELECT invitation_id FROM public.create_child_login_invitation($1,$2,$3)",[athlete2,x.recipient.email,hash(raw2)]); await control.query("COMMIT"); f.invitations.push(i2.invitation_id);
  const ap=Number((await one(a,"SELECT pg_backend_pid() AS pid")).pid),bp=Number((await one(b,"SELECT pg_backend_pid() AS pid")).pid);
  const p1=await acceptanceOwnsLock(a,x); await begin(b,x.recipient.id); const p2=b.query("SELECT * FROM public.accept_child_login_invitation($1)",[raw2]); await waitFor(observer,ap,bp);
  const r1=(await p1).rows[0]; await a.query("COMMIT"); let loser; try {await p2; fail("SCENARIO_3_LOSER_SUCCEEDED");} catch(e){loser=e;} await rollback(b); if(loser?.code!=="P0001") throw loser;
  const state=await one(observer,"SELECT (SELECT count(*)::int FROM public.athlete_profile_relationships WHERE profile_id=$1 AND role='self' AND revoked_at IS NULL) AS n,(SELECT status FROM public.child_login_invitations WHERE id=$2) AS s1,(SELECT status FROM public.child_login_invitations WHERE id=$3) AS s2",[x.recipient.id,x.invitation,i2.invitation_id]);
  if(r1.athlete_id!==x.athlete||Number(state.n)!==1||state.s1!=="accepted"||state.s2!=="pending")fail("SCENARIO_2_FINAL_STATE"); console.log("scenario_2_same_recipient_two_athletes: PASS winner=athlete-a");
 } finally {await rollback(a);await rollback(b);await cleanup(control,f);} }
async function externalInsertThenRevoke(a, b, observer, control) {
  const f = { marker: `13ea-harness-${randomUUID()}`, users: [], athletes: [], invitations: [] };
  try {
    const x = await fixture(control, f); const aPid = Number((await one(a, "SELECT pg_backend_pid() AS pid")).pid); const bPid = Number((await one(b, "SELECT pg_backend_pid() AS pid")).pid);
    await begin(b, x.manager.id);
    const self = await one(b, "INSERT INTO public.athlete_profile_relationships(athlete_id,profile_id,role,training_permission,manage_permission,created_by_profile_id) VALUES($1,$2,'self',true,true,$2) RETURNING id", [x.athlete, x.manager.id]);
    const pending = acceptanceOwnsLock(a, x); await waitFor(observer, bPid, aPid);
    await b.query("UPDATE public.athlete_profile_relationships SET revoked_at=clock_timestamp() WHERE id=$1", [self.id]); // UPDATE fires the same guard reentrantly.
    await b.query("COMMIT");
    try { await pending; fail("REVOKED_SELF_HISTORY_WAS_RECLAIMED"); } catch (error) { if (error.code !== "P0001") throw error; }
    await rollback(a);
    const state = await one(observer, "SELECT (SELECT status FROM public.child_login_invitations WHERE id=$1) AS status,(SELECT count(*)::int FROM public.athlete_profile_relationships WHERE athlete_id=$2 AND role='self') AS self_history", [x.invitation, x.athlete]);
    if (state.status !== "pending" || Number(state.self_history) !== 1) fail("REVOKED_HISTORY_FINAL_STATE");
    console.log("external_self_insert_then_revoke: PASS");
  } finally { await rollback(a); await rollback(b); await cleanup(control, f); }
}
export async function main() {
  if ((process.env[MODE_ENV] || "LOCAL") !== "LOCAL") fail("LIVE_MODE_FORBIDDEN");
  const config = { connectionString: localUrl(process.env[DATABASE_URL_ENV]) };
  const [a,b,observer,control] = ["a","b","observer","cleanup"].map((name) => new Client({ ...config, application_name: `tilt-13ea-${name}` }));
  try {
    await Promise.all([a,b,observer,control].map((c) => c.connect()));
    const before = await ledger(observer);
    await sameInvitationSameRecipient(a,b,observer,control);
    await scenario2(a,b,observer,control);
    await authorityRace(a,b,observer,control,"revoked","scenario_3_acceptance_vs_guardian_revocation");
    await authorityRace(a,b,observer,control,"manage","scenario_4_acceptance_vs_guardian_manage_loss");
    await scenario5(a,b,observer,control); await scenario6(a,b,observer,control); await scenario7(a,b,observer,control); await scenario8(a,b,observer,control);
    await acceptanceVsExternalInsert(a,b,observer,control);
    await externalInsertThenRevoke(a,b,observer,control);
    if (before !== await ledger(observer)) fail("LEDGER_CHANGED");
    console.log("ledger_unchanged: PASS"); console.log("overall: PASS");
  } finally { await Promise.all([a,b,observer,control].map(async (c) => { await rollback(c); await c.end(); })); }
}
if (process.argv[1]?.endsWith("run_child_login_invitation_concurrency.mjs")) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
