import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { requirePlanCoach } from "@/lib/training-plans-server";

// Each page and mutation also authorizes independently; this layout is only the shell.
export default async function PlansLayout({ children, params }: { children: ReactNode; params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  try { await requirePlanCoach(teamId); } catch { redirect("/"); }
  return <main className="min-h-screen bg-slate-950 px-6 py-10 text-white">
    <div className="mx-auto max-w-5xl">
      <Link href={`/teams/${teamId}`} className="text-sm font-medium text-emerald-400 hover:text-emerald-300">← Back to team dashboard</Link>
      <div className="mt-8">{children}</div>
    </div>
  </main>;
}
