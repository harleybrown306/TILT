import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import TeamCreationForm from "./team-form";

export default async function NewTeamPage() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/login");
  return <main className="min-h-screen bg-slate-950 px-6 py-10 text-white">
    <div className="mx-auto max-w-2xl">
      <Link href="/" className="text-sm font-medium text-emerald-400 hover:text-emerald-300">← Back to dashboard</Link>
      <header className="my-8">
        <h1 className="text-4xl font-bold">Create Team</h1>
        <p className="mt-3 text-slate-400">Create your first team or add another team to coach.</p>
      </header>
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6"><TeamCreationForm /></section>
    </div>
  </main>;
}
