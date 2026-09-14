import Link from "next/link";
import { redirect } from "next/navigation";
import PlanActionForm from "@/components/plans/action-form";
import { planInputClass } from "@/components/plans/schedule-fields";
import { requirePlanCoach } from "@/lib/training-plans-server";
import { createPlan } from "../actions";

export default async function NewPlanPage({ params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  try { await requirePlanCoach(teamId); } catch { redirect("/"); }
  return <>
    <Link href={`/teams/${teamId}/plans`} className="text-sm text-emerald-400">← Back to Training Plans</Link>
    <h1 className="my-6 text-4xl font-bold">Create Training Plan</h1>
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <PlanActionForm action={createPlan.bind(null, teamId)} label="Create draft plan">
        <label className="block font-medium">Plan name<input name="name" required className={`${planInputClass} mt-2`} /></label>
        <label className="block font-medium">Description (optional)<textarea name="description" rows={3} className={`${planInputClass} mt-2`} /></label>
        <p className="text-sm text-slate-400">The plan starts as a draft for this team. Add workouts, then activate it before assigning training.</p>
      </PlanActionForm>
    </div>
  </>;
}
