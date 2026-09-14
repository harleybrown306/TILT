import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/admin-training-templates-server";
import { readAllRows } from "@/lib/training-assignment";
import { PLAN_COLUMNS } from "@/lib/training-plans-server";
import type { Plan } from "@/lib/training-plans";

export default async function AdminTemplatesPage() {
  const context = await requirePlatformAdmin().catch(() => null);
  if (!context) redirect("/");
  let templates: Plan[] = [];
  const counts = new Map<string, number>();
  let failed = false;
  try {
    templates = await readAllRows<Plan>((from, to) => context.supabase.from("training_plans").select(PLAN_COLUMNS)
      .eq("kind", "template").order("created_at", { ascending: false }).order("id").range(from, to));
    if (templates.length) {
      const items = await readAllRows<{ training_plan_id: string }>((from, to) => context.supabase.from("training_plan_items")
        .select("training_plan_id").in("training_plan_id", templates.map((template) => template.id)).order("id").range(from, to));
      items.forEach((item) => counts.set(item.training_plan_id, (counts.get(item.training_plan_id) ?? 0) + 1));
    }
  } catch { failed = true; }
  return <>
    <header className="mb-8 flex flex-wrap items-center justify-between gap-4"><div><h1 className="text-4xl font-bold">TILT Training Templates</h1><p className="mt-3 text-slate-400">Master content managed by platform admins. Only published masters appear in the coach library.</p></div>
      <Link href="/admin/training-templates/new" className="rounded-xl bg-emerald-500 px-5 py-3 font-semibold text-slate-950">Create Template</Link>
    </header>
    {failed ? <p role="alert" className="text-rose-300">Unable to load templates. Reload before making changes.</p> : [["draft", "Draft"], ["active", "Published"], ["archived", "Archived"]].map(([status, label]) => {
      const group = templates.filter((template) => template.status === status);
      return <section key={status} className="mb-8"><h2 className="mb-4 text-2xl font-semibold">{label}</h2>
        {!group.length ? <p className="text-slate-400">No {label.toLowerCase()} templates.</p> : <div className="space-y-4">{group.map((template) => <article key={template.id} className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <p className="text-sm text-emerald-400">Master template · {label}</p><h3 className="mt-3 text-xl font-semibold">{template.name}</h3>
          {template.description && <p className="mt-2 text-slate-400">{template.description}</p>}
          <p className="my-3 text-sm text-slate-400">{counts.get(template.id) ?? 0} scheduled workouts · Created {template.created_at.slice(0, 10)} · Updated {template.updated_at.slice(0, 10)}</p>
          <Link href={`/admin/training-templates/${template.id}`} className="font-semibold text-emerald-400">{status === "draft" ? "Open / Edit" : "Inspect template"} →</Link>
        </article>)}</div>}
      </section>;
    })}
  </>;
}
