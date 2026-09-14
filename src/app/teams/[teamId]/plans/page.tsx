import Link from "next/link";
import { redirect } from "next/navigation";
import { readAllRows } from "@/lib/training-assignment";
import { PLAN_COLUMNS, requirePlanCoach } from "@/lib/training-plans-server";
import { archiveDescription, type Plan } from "@/lib/training-plans";
import PlanActionForm from "@/components/plans/action-form";
import { duplicateTemplate } from "./actions";

export default async function TrainingPlansPage({ params, searchParams }: {
  params: Promise<{ teamId: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { teamId } = await params;
  const context = await requirePlanCoach(teamId).catch(() => null);
  if (!context) redirect("/");
  const requestedView = (await searchParams)?.view;
  const view = requestedView === "templates" || requestedView === "archived" ? requestedView : "mine";
  let plans: Plan[] = [];
  const counts = new Map<string, number>();
  let loadFailed = false;
  try {
    plans = await readAllRows<Plan>((from, to) => {
      const query = context.supabase.from("training_plans").select(PLAN_COLUMNS);
      const scoped = view === "templates" ? query.eq("kind", "template").eq("visibility", "public").eq("status", "active")
        : query.eq("kind", "coach").eq("visibility", "private").eq("owner_user_id", context.user.id);
      return scoped.order("created_at", { ascending: false }).order("id").range(from, to);
    });
    if (view !== "templates") plans = plans.filter((plan) => view === "archived" ? plan.status === "archived" : plan.status !== "archived");
    if (plans.length) {
      const items = await readAllRows<{ training_plan_id: string }>((from, to) => context.supabase.from("training_plan_items")
        .select("training_plan_id").in("training_plan_id", plans.map((plan) => plan.id)).order("id").range(from, to));
      items.forEach((item) => counts.set(item.training_plan_id, (counts.get(item.training_plan_id) ?? 0) + 1));
    }
  } catch { loadFailed = true; }
  const sections = view === "templates" ? [{ title: "TILT Templates", plans }]
    : view === "archived" ? [{ title: "Archived", plans }]
    : ["draft", "active"].map((status) => ({ title: status === "draft" ? "Draft" : "Active", plans: plans.filter((plan) => plan.status === status) }));
  return <>
    <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
      <div><h1 className="text-4xl font-bold">Training Plans</h1><p className="mt-3 text-slate-400">My Plans belong to you and can be reused across any team where you coach. This team remains your assignment context.</p></div>
      <Link href={`/teams/${teamId}/plans/new`} className="rounded-xl bg-emerald-500 px-5 py-3 font-semibold text-slate-950">Create Training Plan</Link>
    </header>
    <nav aria-label="Training plan library" className="mb-8 flex flex-wrap gap-5">
      {[["mine", "My Plans"], ["templates", "TILT Templates"], ["archived", "Archived"]].map(([key, label]) => <Link key={key} href={`/teams/${teamId}/plans?view=${key}`} aria-current={view === key ? "page" : undefined} className={view === key ? "font-semibold text-emerald-400" : "text-slate-400"}>{label}</Link>)}
    </nav>
    {view === "templates" && <p className="mb-6 text-slate-400">Use a TILT template to create an independent draft in My Plans. Master templates cannot be edited or assigned directly.</p>}
    {loadFailed ? <p role="alert" className="text-rose-300">Unable to load plans. Reload before making changes.</p> : sections.map((section) => {
      return <section key={section.title} className="mb-8">
        <h2 className="mb-4 text-2xl font-semibold">{section.title}</h2>
        {section.plans.length === 0 ? <p className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-slate-400">{view === "templates" ? "No public TILT templates are available yet." : `No ${section.title.toLowerCase()} plans.`}</p> : <div className="space-y-4">
          {section.plans.map((plan) => <article key={plan.id} className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <span className="rounded-full bg-slate-800 px-3 py-1 text-xs capitalize text-emerald-400">{plan.status}</span>
            <h3 className="mt-3 text-xl font-semibold">{plan.name}</h3>
            {plan.description && <p className="mt-2 text-slate-400">{plan.description}</p>}
            <p className="mt-3 text-sm text-slate-400">{counts.get(plan.id) ?? 0} workouts</p>
            {view === "archived" && <p className="mt-3 text-sm text-slate-400">{archiveDescription(plan)}</p>}
            <Link href={`/teams/${teamId}/plans/${plan.id}`} className="my-4 inline-block font-semibold text-emerald-400">{view !== "templates" && plan.status === "draft" ? "Open / Edit" : "Open plan"} →</Link>
            {view === "templates" && <PlanActionForm action={duplicateTemplate.bind(null, teamId, plan.id)} label="Use Template"><p className="text-sm text-slate-400">Copy into your coach library to customize it.</p></PlanActionForm>}
          </article>)}
        </div>}
      </section>;
    })}
  </>;
}
