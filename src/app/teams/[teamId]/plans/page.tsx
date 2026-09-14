import Link from "next/link";
import { redirect } from "next/navigation";
import { readAllRows } from "@/lib/training-assignment";
import { requirePlanCoach } from "@/lib/training-plans-server";
import type { Plan, PlanStatus } from "@/lib/training-plans";

export default async function TrainingPlansPage({ params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  const context = await requirePlanCoach(teamId).catch(() => null);
  if (!context) redirect("/");
  let plans: Plan[] = [];
  const counts = new Map<string, number>();
  let loadFailed = false;
  try {
    plans = await readAllRows<Plan>((from, to) => context.supabase.from("training_plans")
      .select("id, name, description, status, team_id, owner_user_id, created_at, updated_at")
      .eq("team_id", teamId).order("created_at", { ascending: false }).order("id").range(from, to));
    if (plans.length) {
      const items = await readAllRows<{ training_plan_id: string }>((from, to) => context.supabase.from("training_plan_items")
        .select("training_plan_id").in("training_plan_id", plans.map((plan) => plan.id)).order("id").range(from, to));
      items.forEach((item) => counts.set(item.training_plan_id, (counts.get(item.training_plan_id) ?? 0) + 1));
    }
  } catch { loadFailed = true; }
  const statuses: PlanStatus[] = ["draft", "active", "archived"];
  return <>
    <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
      <div><h1 className="text-4xl font-bold">Training Plans</h1><p className="mt-3 text-slate-400">Build reusable workout schedules for your team.</p></div>
      <Link href={`/teams/${teamId}/plans/new`} className="rounded-xl bg-emerald-500 px-5 py-3 font-semibold text-slate-950">Create Training Plan</Link>
    </header>
    {loadFailed ? <p role="alert" className="text-rose-300">Unable to load plans. Reload before making changes.</p> : statuses.map((status) => {
      const group = plans.filter((plan) => plan.status === status);
      return <section key={status} className="mb-8">
        <h2 className="mb-4 text-2xl font-semibold capitalize">{status}</h2>
        {group.length === 0 ? <p className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-slate-400">No {status} plans.</p> : <div className="space-y-4">
          {group.map((plan) => <article key={plan.id} className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <span className="rounded-full bg-slate-800 px-3 py-1 text-xs capitalize text-emerald-400">{plan.status}</span>
            <h3 className="mt-3 text-xl font-semibold">{plan.name}</h3>
            {plan.description && <p className="mt-2 text-slate-400">{plan.description}</p>}
            <p className="mt-3 text-sm text-slate-400">{counts.get(plan.id) ?? 0} workouts</p>
            <Link href={`/teams/${teamId}/plans/${plan.id}`} className="mt-4 inline-block font-semibold text-emerald-400">{status === "draft" ? "Open / Edit" : "Open plan"} →</Link>
          </article>)}
        </div>}
      </section>;
    })}
  </>;
}
