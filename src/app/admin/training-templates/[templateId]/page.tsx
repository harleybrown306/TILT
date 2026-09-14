import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import PlanActionForm from "@/components/plans/action-form";
import ScheduleFields, { planInputClass } from "@/components/plans/schedule-fields";
import { offsetToDayNumber, scheduleVersion, sortPlanItems, type PlanItem, type PlanWorkout } from "@/lib/training-plans";
import { loadPlanItems } from "@/lib/training-plans-server";
import { loadAdminTemplateWorkouts, requireAdminTemplate, requirePlatformAdmin } from "@/lib/admin-training-templates-server";
import { mutateTemplate } from "../actions";

export default async function AdminTemplatePage({ params }: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await params;
  const context = await requirePlatformAdmin().catch(() => null);
  if (!context) redirect("/");
  const template = await requireAdminTemplate(context, templateId).catch(() => null);
  if (!template) notFound();
  let items: PlanItem[] = [], workouts: PlanWorkout[] = [];
  let failed = false;
  try { [items, workouts] = await Promise.all([loadPlanItems(context, templateId), loadAdminTemplateWorkouts(context)]); } catch { failed = true; }
  const draft = template.status === "draft";
  const action = mutateTemplate.bind(null, templateId);
  const fields = (operation: string, item?: PlanItem) => <>
    <input type="hidden" name="operation" value={operation} /><input type="hidden" name="planVersion" value={template.updated_at} />
    {operation === "publish" && <input type="hidden" name="scheduleVersion" value={scheduleVersion(items)} />}
    {item && <><input type="hidden" name="itemId" value={item.id} /><input type="hidden" name="itemVersion" value={item.updated_at} /></>}
  </>;
  const byId = new Map(workouts.map((workout) => [workout.id, workout]));
  const nextPosition = items.reduce((max, item) => Math.max(max, item.position + 1), 0);
  return <>
    <Link href="/admin/training-templates" className="text-sm text-emerald-400">← Back to templates</Link>
    <header className="my-6"><p className="text-sm text-emerald-400">Master template · {template.status === "active" ? "Published" : template.status}</p><h1 className="mt-3 text-4xl font-bold">{template.name}</h1>
      {template.description && <p className="mt-3 text-slate-400">{template.description}</p>}
      <p className="mt-3 text-sm text-slate-400">{draft ? "Draft master — editable and hidden from the coach library." : "Read-only master. Existing coach copies are independent and will not change."}</p>
    </header>
    {draft && <section className="mb-6 rounded-2xl border border-slate-800 bg-slate-900 p-6"><h2 className="mb-4 text-2xl font-semibold">Template details</h2>
      <PlanActionForm action={action} label="Save template details">{fields("save-plan")}
        <label className="block font-medium">Name<input name="name" required defaultValue={template.name} className={`${planInputClass} mt-2`} /></label>
        <label className="block font-medium">Description<textarea name="description" rows={3} defaultValue={template.description ?? ""} className={`${planInputClass} mt-2`} /></label>
      </PlanActionForm>
    </section>}
    <section className="mb-6"><h2 className="mb-4 text-2xl font-semibold">Workout schedule</h2><p className="mb-4 text-sm text-slate-400">Day 1 is the assignment start date. Order numbers are unique across the schedule; gaps are allowed. Times use America/Chicago.</p>
      {failed ? <p role="alert" className="text-rose-300">Unable to load the schedule. Reload before editing or publishing.</p> : !items.length ? <p className="text-slate-400">No workouts scheduled yet.</p> : <div className="space-y-4">{sortPlanItems(items).map((item) => {
        const workout = byId.get(item.workout_id);
        return <article key={item.id} className="rounded-2xl border border-slate-800 bg-slate-900 p-6"><p className="text-sm text-emerald-400">Day {offsetToDayNumber(item.day_offset)} · Order {item.position + 1}</p><h3 className="mt-2 text-xl font-semibold">{workout?.name ?? "Workout unavailable or no longer public"}</h3>
          {workout && <p className="mt-2 text-sm text-slate-400">{workout.difficulty}{workout.requires_entitlement ? " · Entitlement required" : ""}</p>}
          {draft ? <div className="mt-4 space-y-4"><PlanActionForm action={action} label="Save workout schedule">{fields("save-item", item)}<ScheduleFields item={item} /></PlanActionForm>
            <PlanActionForm action={action} label="Remove workout" confirmation="Remove this workout from the draft master? Existing coach copies are unchanged.">{fields("remove-item", item)}</PlanActionForm>
          </div> : <>{item.scheduled_time && <p className="mt-3 text-slate-400">Scheduled time: {item.scheduled_time}</p>}{item.notes && <p className="mt-3 text-slate-300">{item.notes}</p>}</>}
        </article>;
      })}</div>}
    </section>
    {draft && !failed && <section className="mb-6 rounded-2xl border border-slate-800 bg-slate-900 p-6"><h2 className="mb-4 text-2xl font-semibold">Add workout</h2><p className="mb-4 text-sm text-slate-400">Masters use public workouts. Existing entitlement requirements remain in effect when a coach uses the template.</p>
      {!workouts.length ? <p className="text-slate-400">No public workouts available.</p> : <PlanActionForm action={action} label="Add workout">{fields("add-item")}
        <label className="block font-medium">Workout<select name="workoutId" required defaultValue="" className={`${planInputClass} mt-2`}><option value="">Select a workout</option>{workouts.map((workout) => <option key={workout.id} value={workout.id}>{workout.name} · {workout.difficulty}{workout.requires_entitlement ? " · Entitlement required" : ""}</option>)}</select></label>
        <ScheduleFields nextPosition={nextPosition} />
      </PlanActionForm>}
    </section>}
    <section className="space-y-5 rounded-2xl border border-emerald-500/30 bg-slate-900 p-6">
      {draft ? <><p className="text-slate-400">Save all edits before publishing. Publishing exposes this master in the coach library; it does not assign training.</p><PlanActionForm action={action} label="Publish Template" disabled={failed || !items.length} confirmation="Publish this master template for coaches to view and copy?">{fields("publish")}</PlanActionForm></>
        : template.status === "active" ? <><PlanActionForm action={action} label="Unpublish / Edit" confirmation="Hide this master from the coach library and return it to draft? Existing copies are unchanged.">{fields("unpublish")}</PlanActionForm><PlanActionForm action={action} label="Archive Template" confirmation="Archive this master and hide it from coaches? Existing copies and training history are retained.">{fields("archive")}</PlanActionForm></>
          : <><p className="text-slate-400">Archived master. It is hidden from the coach library. No master deletion is offered.</p><PlanActionForm action={action} label="Return to Draft" confirmation="Return this archived master to draft for editing? It will remain hidden until published.">{fields("edit-archived")}</PlanActionForm></>}
    </section>
  </>;
}
