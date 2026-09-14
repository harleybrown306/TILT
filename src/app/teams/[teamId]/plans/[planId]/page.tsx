import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import PlanActionForm from "@/components/plans/action-form";
import ScheduleFields, { planInputClass } from "@/components/plans/schedule-fields";
import { isDraft, offsetToDayNumber, scheduleVersion, sortPlanItems, type PlanItem, type PlanWorkout } from "@/lib/training-plans";
import { loadPlanItems, loadPlanWorkouts, requirePlanCoach, requireTeamPlan } from "@/lib/training-plans-server";
import { mutatePlan } from "../actions";

export default async function PlanBuilderPage({ params }: { params: Promise<{ teamId: string; planId: string }> }) {
  const { teamId, planId } = await params;
  const context = await requirePlanCoach(teamId).catch(() => null);
  if (!context) redirect("/");
  const plan = await requireTeamPlan(context, teamId, planId).catch(() => null);
  if (!plan) notFound();
  let items: PlanItem[] = [], workouts: PlanWorkout[] = [];
  let loadFailed = false;
  try {
    [items, workouts] = await Promise.all([loadPlanItems(context, planId), loadPlanWorkouts(context, teamId)]);
  } catch { loadFailed = true; }
  const draft = isDraft(plan.status);
  const action = mutatePlan.bind(null, teamId, planId);
  const fields = (operation: string, item?: PlanItem) => <>
    <input type="hidden" name="operation" value={operation} />
    <input type="hidden" name="planVersion" value={plan.updated_at} />
    {operation === "activate" && <input type="hidden" name="scheduleVersion" value={scheduleVersion(items)} />}
    {item && <><input type="hidden" name="itemId" value={item.id} /><input type="hidden" name="itemVersion" value={item.updated_at} /></>}
  </>;
  const workoutById = new Map(workouts.map((workout) => [workout.id, workout]));
  const nextPosition = items.reduce((max, item) => Math.max(max, item.position + 1), 0);

  return <>
    <Link href={`/teams/${teamId}/plans`} className="text-sm text-emerald-400">← Back to Training Plans</Link>
    <header className="my-6">
      <span className="rounded-full bg-slate-800 px-3 py-1 text-sm capitalize text-emerald-400">{plan.status}</span>
      <h1 className="mt-4 text-4xl font-bold">{plan.name}</h1>
      {plan.description && <p className="mt-3 text-slate-400">{plan.description}</p>}
      {!draft && <p className="mt-3 text-sm text-slate-400">This plan is read-only. Its workout structure is locked to preserve assigned training.</p>}
    </header>
    {draft && <section className="mb-6 rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <h2 className="mb-4 text-2xl font-semibold">Plan details</h2>
      <PlanActionForm action={action} label="Save plan details">
        {fields("save-plan")}
        <label className="block font-medium">Plan name<input name="name" required defaultValue={plan.name} className={`${planInputClass} mt-2`} /></label>
        <label className="block font-medium">Description (optional)<textarea name="description" rows={3} defaultValue={plan.description ?? ""} className={`${planInputClass} mt-2`} /></label>
      </PlanActionForm>
    </section>}
    <section className="mb-6">
      <h2 className="mb-4 text-2xl font-semibold">Workout schedule</h2>
      <p className="mb-4 text-sm text-slate-400">Day 1 is the assignment&apos;s start date. Day 2 is the following day. Order numbers must be unique across the plan; gaps are allowed. Workouts on the same day follow their order numbers. Times use America/Chicago.</p>
      {loadFailed ? <p role="alert" className="text-rose-300">Unable to load the schedule or usable workouts. Reload before changing or activating this plan.</p> : items.length === 0 ? <p className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-slate-400">No workouts yet. Add your first workout below.</p> : <div className="space-y-4">
        {sortPlanItems(items).map((item) => {
          const workout = workoutById.get(item.workout_id);
          return <article key={item.id} className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <p className="text-sm font-semibold text-emerald-400">Day {offsetToDayNumber(item.day_offset)} · Order {item.position + 1}</p>
            <h3 className="mt-2 text-xl font-semibold">{workout?.name ?? "Workout unavailable"}</h3>
            {workout && <p className="mt-2 text-sm capitalize text-slate-400">{workout.difficulty}</p>}
            {!workout && <p className="mt-2 text-sm text-rose-300">This workout is no longer accessible or requires an entitlement.</p>}
            {draft ? <div className="mt-4 space-y-4">
              <PlanActionForm action={action} label="Save workout schedule">{fields("save-item", item)}<ScheduleFields item={item} /></PlanActionForm>
              <PlanActionForm action={action} label="Remove workout" confirmation="Remove this workout from the draft plan?">{fields("remove-item", item)}</PlanActionForm>
            </div> : <>
              {item.scheduled_time && <p className="mt-3 text-sm text-slate-400">Scheduled time: {item.scheduled_time}</p>}
              {item.notes && <p className="mt-3 text-slate-300">{item.notes}</p>}
            </>}
          </article>;
        })}
      </div>}
    </section>
    {draft && !loadFailed && <section className="mb-6 rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <h2 className="mb-4 text-2xl font-semibold">Add workout</h2>
      {workouts.length === 0 ? <p className="text-slate-400">No usable workouts are available for you and this team. An existing visible workout with any required entitlement is needed.</p> : <PlanActionForm action={action} label="Add workout">
        {fields("add-item")}
        <label className="block font-medium">Workout<select name="workoutId" required defaultValue="" className={`${planInputClass} mt-2`}>
          <option value="">Select a workout</option>
          {workouts.map((workout) => <option key={workout.id} value={workout.id}>{workout.name} · {workout.difficulty}{workout.description ? ` — ${workout.description}` : ""}</option>)}
        </select></label>
        <ScheduleFields nextPosition={nextPosition} />
      </PlanActionForm>}
    </section>}
    <section className="rounded-2xl border border-emerald-500/30 bg-slate-900 p-6">
      {draft ? <>
        <h2 className="mb-3 text-2xl font-semibold">Ready to assign?</h2>
        <p className="mb-4 text-slate-400">Activation locks the plan structure. Save all edits before activating. This does not assign training automatically.</p>
        <PlanActionForm action={action} label="Activate Plan" disabled={loadFailed || !items.length} confirmation="Activate this plan and lock its structure?">{fields("activate")}</PlanActionForm>
      </> : plan.status === "active" ? <div className="space-y-5">
        <Link href={`/teams/${teamId}/assign`} className="inline-block rounded-xl bg-emerald-500 px-5 py-3 font-semibold text-slate-950">Assign Training</Link>
        <PlanActionForm action={action} label="Archive Plan" confirmation="Archive this plan? New assignments will be disabled. Existing assignments and sessions will be retained.">{fields("archive")}</PlanActionForm>
      </div> : <p className="text-slate-400">Archived plan. Its schedule and history are retained, and it cannot be newly assigned.</p>}
    </section>
  </>;
}
