import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/admin-training-templates-server";

export default async function AdminPage() {
  try { await requirePlatformAdmin(); } catch { redirect("/"); }
  return <><h1 className="mb-8 text-4xl font-bold">TILT Admin</h1>
    <Link href="/admin/training-templates" className="block rounded-2xl border border-slate-800 bg-slate-900 p-6 hover:border-emerald-500"><h2 className="text-2xl font-semibold">Training Templates</h2><p className="mt-3 text-slate-400">Create and publish master TILT schedules for coaches to copy.</p></Link>
  </>;
}
