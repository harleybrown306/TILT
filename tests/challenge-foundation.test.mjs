import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Client } from "pg";

const sql = readFileSync(new URL("../supabase/migrations/20260929100000_create_session_challenge_foundation.sql", import.meta.url), "utf8");
const phase18Sql = readFileSync(new URL("../supabase/migrations/20261004100000_enable_session_challenge_execution.sql", import.meta.url), "utf8");
const validator = readFileSync(new URL("database/validate_session_challenge_foundation.sql", import.meta.url), "utf8");

test("challenge snapshots are plan-item scoped and deletion safe", () => {
  assert.match(sql, /ADD COLUMN challenge_workout_id/);
  assert.match(sql, /CREATE TABLE public\.training_session_challenge_prescriptions/);
  assert.match(sql, /source_workout_id uuid NOT NULL/);
  assert.doesNotMatch(sql, /source_workout_id uuid NOT NULL REFERENCES/);
});

test("challenge configuration authorizes the authenticated editor and assignment locks its plan item", () => {
  const validation = sql.slice(sql.indexOf("CREATE FUNCTION private.validate_training_plan_item_challenge"));
  assert.match(validation, /v_actor uuid := \(SELECT auth\.uid\(\)\)/);
  assert.match(validation, /private\.can_view_content\(workout\.visibility,workout\.owner_user_id,workout\.team_id,v_actor\)/);
  const generator = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION private.generate_sessions_for_assignment"));
  assert.match(generator, /training_plan_items WHERE training_plan_id=NEW\.training_plan_id FOR SHARE/);
  const capture = sql.slice(sql.indexOf("CREATE FUNCTION private.capture_training_session_challenge_prescription"));
  assert.match(capture, /WHERE id=NEW\.plan_item_id FOR SHARE/);
});

test("selection is self-only and locks after durable execution", () => {
  const selection = sql.slice(sql.indexOf("CREATE FUNCTION public.select_my_training_session_variant"));
  for (const text of ["relationship.role='self'", "workout_session_attempts", "workout_session_events", "workout_results", "v_session.status='completed'", "v_session.completed_at IS NOT NULL", "training_session_variant_selection_audit"]) assert.match(selection, new RegExp(text));
  assert.ok(selection.indexOf("WHERE session.id=p_session_id FOR UPDATE;") < selection.indexOf("v_session.completed_at IS NOT NULL"), "the session lock precedes every durable-state check");
  assert.doesNotMatch(selection, /p_workout_id|p_prescription|p_athlete_id/);
});

test("Phase 18B permits canonical Challenge execution and gates completion", () => {
  for (const text of ["private.register_workout_session_attempt_from_event", "private.performed_training_session_prescription", "Challenge completion requires a performed attempt", "private.arm_canonical_challenge_completion", "Challenge completion requires canonical execution", "workout_results_require_canonical_challenge_completion", "training_sessions_require_canonical_challenge_completion", "BEFORE UPDATE OF status,completed_at ON public.training_sessions"]) assert.match(phase18Sql, new RegExp(text));
  assert.doesNotMatch(phase18Sql, /Challenge execution is not available|Challenge completion is not available/);
});

test("behavioral validator covers snapshot, selection, completion, and mutation denial", () => {
  for (const text of ["profile/athlete split fixture failed", "cross-staff private challenge content was accepted", "assistant unexpectedly manages private coach plan", "owner challenge configuration failed", "owner challenge removal failed", "Challenge attempt registration did not bind the selected snapshot", "unauthorized actor executed selected Challenge", "assigned-only execution event was accepted for Challenge", "Challenge attempt did not lock variant selection", "Challenge selection audit or idempotency failed", "selected challenge completed through canonical boundary", "assigned canonical completion failed", "completed session accepted challenge selection", "selected challenge completed through direct session status update", "selected challenge accepted direct completion timestamp", "assigned or unrelated direct session update failed", "directly completed assigned session accepted challenge selection", "assigned session direct completion timestamp failed", "timestamped assigned session accepted challenge selection", "non-self selected challenge", "anon selected challenge", "direct challenge integrity mutation allowed", "ROLLBACK;"]) assert.match(validator, new RegExp(text));
});

const concurrencyUrl = process.env.TILT_SESSION_CHALLENGE_CONCURRENCY_DATABASE_URL;

function localDisposableUrl(value) {
  const url = new URL(value);
  const port = process.env.TILT_SESSION_CHALLENGE_CONCURRENCY_DISPOSABLE_PORT;
  if (!port || port === "54322" || !/^(postgres|postgresql):$/.test(url.protocol) || !url.password || url.pathname !== "/postgres" || url.search || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname) || url.port !== port) throw new Error("session challenge concurrency requires an explicit non-protected disposable local database");
  return url.toString();
}

async function blockedBy(observer, holder, waiter, label) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const row = (await observer.query("SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked FROM pg_stat_activity WHERE pid=$2", [holder, waiter])).rows[0];
    if (row?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} blocking was not proven`);
}

async function beginAuthenticated(client, actorId) {
  await client.query("BEGIN");
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [actorId]);
  await client.query("SET LOCAL ROLE authenticated");
}

function observe(promise) { return promise.then((value) => ({ value }), (error) => ({ error })); }
function assertObservedError(result, message) {
  assert.ok(result.error, `expected ${message}`);
  assert.equal(result.error.code, "P0001");
  assert.equal(result.error.message, message);
}

async function createExecutionFixture(control, label) {
  const id = () => randomUUID();
  const fixture = { owner: id(), self: id(), athlete: id(), team: id(), plan: id(), item: id(), base: id(), challenge: id(), exercise: id(), assignments: [] };
  await control.query("INSERT INTO auth.users(id,email) VALUES($1,$2),($3,$4)", [fixture.owner, `${fixture.owner}-owner@example.test`, fixture.self, `${fixture.self}-self@example.test`]);
  await control.query("INSERT INTO public.athletes(id,display_name,created_by_profile_id) VALUES($1,$2,$3)", [fixture.athlete, `${label} athlete`, fixture.owner]);
  await control.query("INSERT INTO public.athlete_profile_relationships(athlete_id,profile_id,role,training_permission,manage_permission,created_by_profile_id) VALUES($1,$2,'self',true,true,$3)", [fixture.athlete, fixture.self, fixture.owner]);
  await control.query("INSERT INTO public.teams(id,name,created_by_user_id) VALUES($1,$2,$3)", [fixture.team, `${label} team`, fixture.owner]);
  await control.query("INSERT INTO public.exercises(id,name) VALUES($1,$2)", [fixture.exercise, `${label} exercise`]);
  await control.query("INSERT INTO public.workouts(id,name,visibility,owner_user_id) VALUES($1,$2,'private',$3),($4,$5,'private',$3)", [fixture.base, `${label} assigned`, fixture.owner, fixture.challenge, `${label} challenge`]);
  for (const workout of [fixture.base, fixture.challenge]) await control.query("INSERT INTO public.workout_exercises(id,workout_id,exercise_id,position,duration_seconds,rest_seconds,exercise_snapshot) VALUES($1,$2,$3,0,1,0,jsonb_build_object('exercise_name',$4::text))", [id(), workout, fixture.exercise, `${label} exercise`]);
  await control.query("INSERT INTO public.training_plans(id,name,team_id,owner_user_id,status,kind,visibility) VALUES($1,$2,$3,$4,'active','coach','private')", [fixture.plan, `${label} plan`, fixture.team, fixture.owner]);
  await beginAuthenticated(control, fixture.owner);
  await control.query("INSERT INTO public.training_plan_items(id,training_plan_id,workout_id,challenge_workout_id,day_offset,position) VALUES($1,$2,$3,$4,0,0)", [fixture.item, fixture.plan, fixture.base, fixture.challenge]);
  await control.query("COMMIT");
  fixture.newSession = async () => {
    const assignment = id();
    fixture.assignments.push(assignment);
    await control.query("INSERT INTO public.training_plan_assignments(id,training_plan_id,team_id,athlete_id,athlete_user_id,assigned_by_user_id,start_date) VALUES($1,$2,$3,$4,$5,$6,CURRENT_DATE)", [assignment, fixture.plan, fixture.team, fixture.athlete, fixture.self, fixture.owner]);
    const row = (await control.query("SELECT id FROM public.training_sessions WHERE assignment_id=$1", [assignment])).rows[0];
    assert.ok(row?.id, "authoritative assignment generation must create a session");
    for (const table of ["training_session_prescriptions", "training_session_challenge_prescriptions"]) assert.equal((await control.query(`SELECT count(*)::int AS count FROM public.${table} WHERE session_id=$1`, [row.id])).rows[0].count, 1, `${table} must capture exactly once`);
    return row.id;
  };
  return fixture;
}

async function cleanupExecutionFixture(control, fixture) {
  const sessions = "SELECT id FROM public.training_sessions WHERE assignment_id=ANY($1::uuid[])";
  await control.query(`DELETE FROM public.workout_results WHERE training_session_id IN (${sessions})`, [fixture.assignments]);
  for (const [table, column] of [["workout_session_events", "session_id"], ["workout_session_attempts", "training_session_id"], ["training_session_variant_selection_audit", "session_id"], ["training_session_performed_variants", "session_id"], ["training_session_challenge_prescriptions", "session_id"], ["training_session_prescriptions", "session_id"]]) await control.query(`DELETE FROM public.${table} WHERE ${column} IN (${sessions})`, [fixture.assignments]);
  await control.query("DELETE FROM public.training_sessions WHERE assignment_id=ANY($1::uuid[])", [fixture.assignments]);
  await control.query("DELETE FROM public.training_plan_assignments WHERE id=ANY($1::uuid[])", [fixture.assignments]);
  await control.query("DELETE FROM public.training_plan_items WHERE id=$1", [fixture.item]);
  await control.query("DELETE FROM public.training_plans WHERE id=$1", [fixture.plan]);
  await control.query("DELETE FROM public.workout_exercises WHERE workout_id=ANY($1::uuid[])", [[fixture.base, fixture.challenge]]);
  await control.query("DELETE FROM public.workouts WHERE id=ANY($1::uuid[])", [[fixture.base, fixture.challenge]]);
  await control.query("DELETE FROM public.teams WHERE id=$1", [fixture.team]);
  await control.query("UPDATE public.athlete_profile_relationships SET revoked_at=clock_timestamp() WHERE athlete_id=$1 AND profile_id=$2 AND role='self' AND revoked_at IS NULL", [fixture.athlete, fixture.self]);
  await control.query("DELETE FROM public.exercises WHERE id=$1", [fixture.exercise]);
}

test("assignment generation serializes paired assigned and Challenge source changes under real owner RLS", { skip: !concurrencyUrl }, async () => {
  const connectionString = localDisposableUrl(concurrencyUrl);
  const [generator, editor, observer, control] = ["generator", "editor", "observer", "control"].map((application_name) => new Client({ connectionString, application_name }));
  const id = () => randomUUID();
  const fixture = { owner: id(), athlete: id(), team: id(), plan: id(), item: id(), exercise: id(), assignedA: id(), assignedB: id(), challengeA: id(), challengeB: id(), assignments: [] };
  try {
    await Promise.all([generator, editor, observer, control].map((client) => client.connect()));
    const generatorPid = (await generator.query("SELECT pg_backend_pid() AS id")).rows[0].id;
    const editorPid = (await editor.query("SELECT pg_backend_pid() AS id")).rows[0].id;
    await control.query("INSERT INTO auth.users(id,email) VALUES($1,$2),($3,$4)", [fixture.owner, `${fixture.plan}-owner@example.test`, fixture.athlete, `${fixture.plan}-athlete@example.test`]);
    await control.query("INSERT INTO public.teams(id,name,created_by_user_id) VALUES($1,'Paired source race',$2)", [fixture.team, fixture.owner]);
    const ownerMembership = await control.query("SELECT id FROM public.team_memberships WHERE team_id=$1 AND user_id=$2 AND role='coach'", [fixture.team, fixture.owner]);
    assert.equal(ownerMembership.rowCount, 1, "team creation must create the authoritative owner membership");
    assert.equal((await control.query("SELECT count(*)::int AS count FROM public.team_staff_memberships WHERE id=$1", [ownerMembership.rows[0].id])).rows[0].count, 1, "owner membership must be mirrored canonically");
    await control.query("INSERT INTO public.exercises(id,name) VALUES($1,'Paired source exercise')", [fixture.exercise]);
    for (const [workout, name] of [[fixture.assignedA, "Assigned A"], [fixture.assignedB, "Assigned B"], [fixture.challengeA, "Challenge A"], [fixture.challengeB, "Challenge B"]]) {
      await control.query("INSERT INTO public.workouts(id,name,visibility,owner_user_id) VALUES($1,$2,'private',$3)", [workout, name, fixture.owner]);
      await control.query("INSERT INTO public.workout_exercises(id,workout_id,exercise_id,position,duration_seconds,rest_seconds,exercise_snapshot) VALUES($1,$2,$3,0,1,0,jsonb_build_object('exercise_name','Paired source exercise'))", [id(), workout, fixture.exercise]);
    }
    await control.query("INSERT INTO public.training_plans(id,name,team_id,owner_user_id,status,kind,visibility) VALUES($1,'Paired source race',$2,$3,'active','coach','private')", [fixture.plan, fixture.team, fixture.owner]);
    await beginAuthenticated(control, fixture.owner);
    await control.query("INSERT INTO public.training_plan_items(id,training_plan_id,workout_id,challenge_workout_id,day_offset,position) VALUES($1,$2,$3,$4,0,0)", [fixture.item, fixture.plan, fixture.assignedA, fixture.challengeA]);
    await control.query("COMMIT");
    const insertAssignment = (client) => client.query("INSERT INTO public.training_plan_assignments(id,training_plan_id,team_id,athlete_user_id,assigned_by_user_id,start_date) VALUES($1,$2,$3,$4,$5,CURRENT_DATE) RETURNING id", [id(), fixture.plan, fixture.team, fixture.athlete, fixture.owner]);
    const assertSnapshots = async (assignment, assigned, challenge) => {
      const row = (await control.query("SELECT assigned.workout_id AS assigned_workout_id, option.source_workout_id AS challenge_workout_id FROM public.training_sessions session JOIN public.training_session_prescriptions assigned ON assigned.session_id=session.id JOIN public.training_session_challenge_prescriptions option ON option.session_id=session.id WHERE session.assignment_id=$1", [assignment])).rows[0];
      assert.deepEqual(row, { assigned_workout_id: assigned, challenge_workout_id: challenge });
    };
    await generator.query("BEGIN");
    const first = await insertAssignment(generator); fixture.assignments.push(first.rows[0].id);
    await beginAuthenticated(editor, fixture.owner);
    const updateAfterGeneration = editor.query("UPDATE public.training_plan_items SET workout_id=$1, challenge_workout_id=$2 WHERE id=$3", [fixture.assignedB, fixture.challengeB, fixture.item]);
    await blockedBy(observer, generatorPid, editorPid, "generation-first paired source update");
    await generator.query("COMMIT"); await updateAfterGeneration; await editor.query("COMMIT");
    await assertSnapshots(fixture.assignments[0], fixture.assignedA, fixture.challengeA);
    await beginAuthenticated(editor, fixture.owner);
    await editor.query("UPDATE public.training_plan_items SET workout_id=$1, challenge_workout_id=$2 WHERE id=$3", [fixture.assignedA, fixture.challengeA, fixture.item]);
    await generator.query("BEGIN");
    const generationAfterUpdate = insertAssignment(generator);
    await blockedBy(observer, editorPid, generatorPid, "update-first paired source generation");
    await editor.query("COMMIT");
    const second = await generationAfterUpdate; fixture.assignments.push(second.rows[0].id); await generator.query("COMMIT");
    await assertSnapshots(fixture.assignments[1], fixture.assignedA, fixture.challengeA);
  } finally {
    await Promise.allSettled([generator, editor].map((client) => client.query("ROLLBACK")));
    for (const table of ["training_session_variant_selection_audit", "training_session_performed_variants", "training_session_challenge_prescriptions", "training_session_prescriptions"]) await control.query(`DELETE FROM public.${table} WHERE session_id IN (SELECT id FROM public.training_sessions WHERE assignment_id=ANY($1::uuid[]))`, [fixture.assignments]);
    await control.query("DELETE FROM public.training_sessions WHERE assignment_id=ANY($1::uuid[])", [fixture.assignments]);
    await control.query("DELETE FROM public.training_plan_assignments WHERE id=ANY($1::uuid[])", [fixture.assignments]);
    await control.query("DELETE FROM public.training_plan_items WHERE id=$1", [fixture.item]); await control.query("DELETE FROM public.training_plans WHERE id=$1", [fixture.plan]);
    await control.query("DELETE FROM public.workout_exercises WHERE workout_id=ANY($1::uuid[])", [[fixture.assignedA, fixture.assignedB, fixture.challengeA, fixture.challengeB]]);
    await control.query("DELETE FROM public.workouts WHERE id=ANY($1::uuid[])", [[fixture.assignedA, fixture.assignedB, fixture.challengeA, fixture.challengeB]]);
    await control.query("DELETE FROM public.teams WHERE id=$1", [fixture.team]); await control.query("DELETE FROM public.exercises WHERE id=$1", [fixture.exercise]);
    await Promise.allSettled([generator, editor, observer, control].map((client) => client.end()));
  }
});

test("Challenge selection and authenticated event insertion serialize on the session row", { skip: !concurrencyUrl }, async () => {
  const connectionString = localDisposableUrl(concurrencyUrl);
  const [selection, eventClient, observer, control] = ["selection", "event", "observer", "control"].map((application_name) => new Client({ connectionString, application_name }));
  let fixture;
  try {
    await Promise.all([selection, eventClient, observer, control].map((client) => client.connect()));
    fixture = await createExecutionFixture(control, "selection-event-race");
    const selectionPid = (await selection.query("SELECT pg_backend_pid() AS id")).rows[0].id;
    const eventPid = (await eventClient.query("SELECT pg_backend_pid() AS id")).rows[0].id;
    const insertStarted = (client, session) => client.query("INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at) VALUES($1,$2,$3,0,'workout_started','ready',0,clock_timestamp())", [randomUUID(), session, randomUUID()]);
    const selectChallenge = (client, session) => client.query("SELECT public.select_my_training_session_variant($1,'challenge')", [session]);
    const positive = await fixture.newSession(); await beginAuthenticated(eventClient, fixture.self); await insertStarted(eventClient, positive); await eventClient.query("COMMIT");
    assert.equal((await control.query("SELECT count(*)::int AS count FROM public.workout_session_events WHERE session_id=$1", [positive])).rows[0].count, 1);
    const selectionFirst = await fixture.newSession(); await beginAuthenticated(selection, fixture.self); await selectChallenge(selection, selectionFirst);
    const blockedEvent = observe((async () => { await beginAuthenticated(eventClient, fixture.self); return insertStarted(eventClient, selectionFirst); })());
    await blockedBy(observer, selectionPid, eventPid, "selection-first event"); await selection.query("COMMIT");
    await blockedEvent; await eventClient.query("COMMIT");
    assert.equal((await control.query("SELECT count(*)::int AS count FROM public.workout_session_events WHERE session_id=$1", [selectionFirst])).rows[0].count, 1);
    assert.equal((await control.query("SELECT selected_variant FROM public.training_session_performed_variants WHERE session_id=$1", [selectionFirst])).rows[0].selected_variant, "challenge");
    const eventFirst = await fixture.newSession(); await beginAuthenticated(eventClient, fixture.self); await insertStarted(eventClient, eventFirst);
    const blockedSelection = observe((async () => { await beginAuthenticated(selection, fixture.self); return selectChallenge(selection, eventFirst); })());
    await blockedBy(observer, eventPid, selectionPid, "event-first selection"); await eventClient.query("COMMIT");
    assertObservedError(await blockedSelection, "Challenge selection is locked after workout start"); await selection.query("ROLLBACK");
    assert.equal((await control.query("SELECT count(*)::int AS count FROM public.workout_session_events WHERE session_id=$1", [eventFirst])).rows[0].count, 1);
    assert.equal((await control.query("SELECT count(*)::int AS count FROM public.training_session_performed_variants WHERE session_id=$1", [eventFirst])).rows[0].count, 0);
  } finally {
    await Promise.allSettled([selection, eventClient].map((client) => client.query("ROLLBACK")));
    if (fixture) await cleanupExecutionFixture(control, fixture);
    await Promise.allSettled([selection, eventClient, observer, control].map((client) => client.end()));
  }
});

test("Challenge selection and canonical completion serialize on the session row", { skip: !concurrencyUrl }, async () => {
  const connectionString = localDisposableUrl(concurrencyUrl);
  const [selection, completion, observer, control] = ["selection", "completion", "observer", "control"].map((application_name) => new Client({ connectionString, application_name }));
  let fixture;
  try {
    await Promise.all([selection, completion, observer, control].map((client) => client.connect()));
    fixture = await createExecutionFixture(control, "selection-completion-race");
    const selectionPid = (await selection.query("SELECT pg_backend_pid() AS id")).rows[0].id;
    const completionPid = (await completion.query("SELECT pg_backend_pid() AS id")).rows[0].id;
    const selectChallenge = (client, session) => client.query("SELECT public.select_my_training_session_variant($1,'challenge')", [session]);
    const complete = (client, session) => client.query("SELECT * FROM public.complete_my_training_session($1)", [session]);
    const positiveAssigned = await fixture.newSession(); await beginAuthenticated(completion, fixture.self); await complete(completion, positiveAssigned); await completion.query("COMMIT");
    assert.equal((await control.query("SELECT count(*)::int AS count FROM public.workout_results WHERE training_session_id=$1", [positiveAssigned])).rows[0].count, 1);
    assert.equal((await control.query("SELECT status::text AS status FROM public.training_sessions WHERE id=$1", [positiveAssigned])).rows[0].status, "completed");
    const selectionFirst = await fixture.newSession(); await beginAuthenticated(selection, fixture.self); await selectChallenge(selection, selectionFirst);
    const blockedCompletion = observe((async () => { await beginAuthenticated(completion, fixture.self); return complete(completion, selectionFirst); })());
    await blockedBy(observer, selectionPid, completionPid, "selection-first completion"); await selection.query("COMMIT");
    assertObservedError(await blockedCompletion, "Challenge completion requires a performed attempt"); await completion.query("ROLLBACK");
    assert.equal((await control.query("SELECT count(*)::int AS count FROM public.workout_results WHERE training_session_id=$1", [selectionFirst])).rows[0].count, 0);
    assert.equal((await control.query("SELECT status::text AS status FROM public.training_sessions WHERE id=$1", [selectionFirst])).rows[0].status, "scheduled");
    assert.equal((await control.query("SELECT selected_variant FROM public.training_session_performed_variants WHERE session_id=$1", [selectionFirst])).rows[0].selected_variant, "challenge");
    const completionFirst = await fixture.newSession(); await beginAuthenticated(completion, fixture.self); await complete(completion, completionFirst);
    const blockedSelection = observe((async () => { await beginAuthenticated(selection, fixture.self); return selectChallenge(selection, completionFirst); })());
    await blockedBy(observer, completionPid, selectionPid, "completion-first selection"); await completion.query("COMMIT");
    assertObservedError(await blockedSelection, "Challenge selection is locked after workout start"); await selection.query("ROLLBACK");
    assert.equal((await control.query("SELECT count(*)::int AS count FROM public.workout_results WHERE training_session_id=$1", [completionFirst])).rows[0].count, 1);
    assert.equal((await control.query("SELECT status::text AS status FROM public.training_sessions WHERE id=$1", [completionFirst])).rows[0].status, "completed");
    assert.equal((await control.query("SELECT count(*)::int AS count FROM public.training_session_variant_selection_audit WHERE session_id=$1", [completionFirst])).rows[0].count, 0);
  } finally {
    await Promise.allSettled([selection, completion].map((client) => client.query("ROLLBACK")));
    if (fixture) await cleanupExecutionFixture(control, fixture);
    await Promise.allSettled([selection, completion, observer, control].map((client) => client.end()));
  }
});

test("Challenge selection and authenticated direct completion state serialize on the session row", { skip: !concurrencyUrl }, async () => {
  const connectionString = localDisposableUrl(concurrencyUrl);
  const [selection, coachStatus, observer, control] = ["selection", "coach-status", "observer", "control"].map((application_name) => new Client({ connectionString, application_name }));
  let fixture;
  try {
    await Promise.all([selection, coachStatus, observer, control].map((client) => client.connect()));
    fixture = await createExecutionFixture(control, "selection-direct-status-race");
    const selectionPid = (await selection.query("SELECT pg_backend_pid() AS id")).rows[0].id;
    const coachPid = (await coachStatus.query("SELECT pg_backend_pid() AS id")).rows[0].id;
    assert.notEqual(selectionPid, coachPid, "selection and coach use independent connections");
    const selectChallenge = (client, session) => client.query("SELECT public.select_my_training_session_variant($1,'challenge')", [session]);
    const directlyComplete = (client, session) => client.query("UPDATE public.training_sessions SET status='completed' WHERE id=$1", [session]);
    const directlyTimestamp = (client, session) => client.query("UPDATE public.training_sessions SET completed_at=clock_timestamp() WHERE id=$1", [session]);

    const unrelated = await fixture.newSession();
    await beginAuthenticated(coachStatus, fixture.owner);
    const unrelatedUpdate = await coachStatus.query("UPDATE public.training_sessions SET notes='direct non-completion update' WHERE id=$1", [unrelated]);
    await coachStatus.query("COMMIT");
    assert.equal(unrelatedUpdate.rowCount, 1);
    assert.deepEqual((await control.query("SELECT status::text AS status, notes FROM public.training_sessions WHERE id=$1", [unrelated])).rows[0], { status: "scheduled", notes: "direct non-completion update" });

    const selectionFirst = await fixture.newSession();
    await beginAuthenticated(selection, fixture.self);
    await selectChallenge(selection, selectionFirst);
    const blockedDirectCompletion = observe((async () => {
      await beginAuthenticated(coachStatus, fixture.owner);
      return directlyComplete(coachStatus, selectionFirst);
    })());
    await blockedBy(observer, selectionPid, coachPid, "selection-first direct completion");
    await selection.query("COMMIT");
    assertObservedError(await blockedDirectCompletion, "Challenge completion requires canonical execution");
    await coachStatus.query("ROLLBACK");
    assert.deepEqual((await control.query("SELECT status::text AS status FROM public.training_sessions WHERE id=$1", [selectionFirst])).rows[0], { status: "scheduled" });
    assert.deepEqual((await control.query("SELECT selected_variant::text AS selected_variant FROM public.training_session_performed_variants WHERE session_id=$1", [selectionFirst])).rows[0], { selected_variant: "challenge" });
    assert.equal((await control.query("SELECT count(*)::int AS count FROM public.training_session_variant_selection_audit WHERE session_id=$1 AND selected_variant='challenge'", [selectionFirst])).rows[0].count, 1);

    const timestampSelectionFirst = await fixture.newSession();
    await beginAuthenticated(selection, fixture.self);
    await selectChallenge(selection, timestampSelectionFirst);
    const blockedDirectTimestamp = observe((async () => {
      await beginAuthenticated(coachStatus, fixture.owner);
      return directlyTimestamp(coachStatus, timestampSelectionFirst);
    })());
    await blockedBy(observer, selectionPid, coachPid, "selection-first direct completion timestamp");
    await selection.query("COMMIT");
    assertObservedError(await blockedDirectTimestamp, "Challenge completion requires canonical execution");
    await coachStatus.query("ROLLBACK");
    assert.deepEqual((await control.query("SELECT status::text AS status, completed_at IS NULL AS no_completed_at FROM public.training_sessions WHERE id=$1", [timestampSelectionFirst])).rows[0], { status: "scheduled", no_completed_at: true });
    assert.deepEqual((await control.query("SELECT selected_variant::text AS selected_variant FROM public.training_session_performed_variants WHERE session_id=$1", [timestampSelectionFirst])).rows[0], { selected_variant: "challenge" });
    assert.equal((await control.query("SELECT count(*)::int AS count FROM public.training_session_variant_selection_audit WHERE session_id=$1 AND selected_variant='challenge'", [timestampSelectionFirst])).rows[0].count, 1);

    const completionFirst = await fixture.newSession();
    await beginAuthenticated(coachStatus, fixture.owner);
    const directCompletion = await directlyComplete(coachStatus, completionFirst);
    assert.equal(directCompletion.rowCount, 1);
    const blockedSelection = observe((async () => {
      await beginAuthenticated(selection, fixture.self);
      return selectChallenge(selection, completionFirst);
    })());
    await blockedBy(observer, coachPid, selectionPid, "direct-completion-first selection");
    await coachStatus.query("COMMIT");
    assertObservedError(await blockedSelection, "Challenge selection is locked after workout start");
    await selection.query("ROLLBACK");
    assert.deepEqual((await control.query("SELECT status::text AS status FROM public.training_sessions WHERE id=$1", [completionFirst])).rows[0], { status: "completed" });
    assert.equal((await control.query("SELECT count(*)::int AS count FROM public.training_session_performed_variants WHERE session_id=$1", [completionFirst])).rows[0].count, 0);
    assert.equal((await control.query("SELECT count(*)::int AS count FROM public.training_session_variant_selection_audit WHERE session_id=$1", [completionFirst])).rows[0].count, 0);

    const timestampFirst = await fixture.newSession();
    await beginAuthenticated(coachStatus, fixture.owner);
    const directTimestamp = await directlyTimestamp(coachStatus, timestampFirst);
    assert.equal(directTimestamp.rowCount, 1);
    const blockedTimestampSelection = observe((async () => {
      await beginAuthenticated(selection, fixture.self);
      return selectChallenge(selection, timestampFirst);
    })());
    await blockedBy(observer, coachPid, selectionPid, "direct-completion-timestamp-first selection");
    await coachStatus.query("COMMIT");
    assertObservedError(await blockedTimestampSelection, "Challenge selection is locked after workout start");
    await selection.query("ROLLBACK");
    assert.deepEqual((await control.query("SELECT status::text AS status, completed_at IS NOT NULL AS has_completed_at FROM public.training_sessions WHERE id=$1", [timestampFirst])).rows[0], { status: "scheduled", has_completed_at: true });
    assert.equal((await control.query("SELECT count(*)::int AS count FROM public.workout_results WHERE training_session_id=$1", [timestampFirst])).rows[0].count, 0);
    assert.equal((await control.query("SELECT count(*)::int AS count FROM public.training_session_performed_variants WHERE session_id=$1", [timestampFirst])).rows[0].count, 0);
    assert.equal((await control.query("SELECT count(*)::int AS count FROM public.training_session_variant_selection_audit WHERE session_id=$1", [timestampFirst])).rows[0].count, 0);
  } finally {
    await Promise.allSettled([selection, coachStatus].map((client) => client.query("ROLLBACK")));
    if (fixture) await cleanupExecutionFixture(control, fixture);
    await Promise.allSettled([selection, coachStatus, observer, control].map((client) => client.end()));
  }
});

test("canonical Challenge completion consumes its one-use permit before a direct writer can proceed", { skip: !concurrencyUrl }, async () => {
  const connectionString = localDisposableUrl(concurrencyUrl);
  const [completion, direct, observer, control] = ["completion", "direct", "observer", "control"].map((application_name) => new Client({ connectionString, application_name }));
  let fixture;
  try {
    await Promise.all([completion, direct, observer, control].map((client) => client.connect()));
    fixture = await createExecutionFixture(control, "canonical-direct-race");
    const completionPid = (await completion.query("SELECT pg_backend_pid() AS id")).rows[0].id;
    const directPid = (await direct.query("SELECT pg_backend_pid() AS id")).rows[0].id;
    const session = await fixture.newSession();
    await beginAuthenticated(completion, fixture.self);
    await completion.query("SELECT public.select_my_training_session_variant($1,'challenge')", [session]);
    const attempt = randomUUID();
    await completion.query("INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at) VALUES($1,$2,$3,0,'workout_started','ready',0,clock_timestamp())", [randomUUID(), session, attempt]);
    await completion.query("SELECT public.register_my_workout_session_attempt($1,$2)", [attempt, session]);
    // Hold the same session-row lock the completion RPC uses so the competing
    // direct writer demonstrably waits on a distinct backend PID.
    await completion.query("SELECT id FROM public.training_sessions WHERE id=$1 FOR UPDATE", [session]);
    const blockedDirect = observe((async () => { await beginAuthenticated(direct, fixture.owner); return direct.query("UPDATE public.training_sessions SET status='completed' WHERE id=$1", [session]); })());
    await blockedBy(observer, completionPid, directPid, "canonical-completion/direct-status");
    await completion.query("SELECT * FROM public.complete_my_training_session($1)", [session]);
    await completion.query("COMMIT");
    const directResult = await blockedDirect;
    assert.ok(!directResult.error, "post-canonical same-status update is not a second completion transition");
    await direct.query("COMMIT");
    assert.equal((await control.query("SELECT count(*)::int AS count FROM public.workout_results WHERE training_session_id=$1", [session])).rows[0].count, 1);
    assert.equal((await control.query("SELECT count(*)::int AS count FROM private.training_session_canonical_completion_permits WHERE session_id=$1", [session])).rows[0].count, 0, "permit is consumed in the canonical result/session synchronization");
    await beginAuthenticated(direct, fixture.owner);
    const timestampRewrite = observe(direct.query("UPDATE public.training_sessions SET completed_at=completed_at+interval '1 second' WHERE id=$1", [session]));
    assertObservedError(await timestampRewrite, "Challenge completion requires canonical execution");
    await direct.query("ROLLBACK");
  } finally {
    await Promise.allSettled([completion, direct].map((client) => client.query("ROLLBACK")));
    if (fixture) await cleanupExecutionFixture(control, fixture);
    await Promise.allSettled([completion, direct, observer, control].map((client) => client.end()));
  }
});
