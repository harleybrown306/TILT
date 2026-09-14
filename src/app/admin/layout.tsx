import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { requirePlatformAdmin } from "@/lib/admin-training-templates-server";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  try { await requirePlatformAdmin(); } catch { redirect("/"); }
  return <main className="min-h-screen bg-slate-950 px-6 py-10 text-white"><div className="mx-auto max-w-5xl">
    <Link href="/" className="text-sm text-emerald-400">← Back to dashboard</Link>
    <div className="mt-8">{children}</div>
  </div></main>;
}
