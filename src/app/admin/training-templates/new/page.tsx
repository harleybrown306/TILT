import Link from "next/link";
import { redirect } from "next/navigation";
import PlanActionForm from "@/components/plans/action-form";
import { planInputClass } from "@/components/plans/schedule-fields";
import { requirePlatformAdmin } from "@/lib/admin-training-templates-server";
import { createTemplate } from "../actions";

export default async function NewTemplatePage() {
  try { await requirePlatformAdmin(); } catch { redirect("/"); }
  return <><Link href="/admin/training-templates" className="text-sm text-emerald-400">← Back to templates</Link>
    <h1 className="my-6 text-4xl font-bold">Create TILT Template</h1>
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6"><PlanActionForm action={createTemplate} label="Create draft template">
      <label className="block font-medium">Template name<input name="name" required className={`${planInputClass} mt-2`} /></label>
      <label className="block font-medium">Description (optional)<textarea name="description" rows={3} className={`${planInputClass} mt-2`} /></label>
      <p className="text-sm text-slate-400">This is a master template, independent of any coach library or team. Build its schedule before publishing.</p>
    </PlanActionForm></section>
  </>;
}
