import Link from "next/link";
import { deriveCoachAttentionSignals } from "@/lib/coach-attention-signals";
import { localDate } from "@/lib/team-attendance";
import { loadTeamAttendance } from "@/lib/team-attendance-server";

type PageProps = { params: Promise<{ teamId: string }> };

export default async function TeamDashboardPage({ params }: PageProps) {
  const { teamId } = await params;
  const { team, sessions, athletes } = await loadTeamAttendance(teamId);
  const today = localDate(new Date());
  const signals = deriveCoachAttentionSignals({ sessions, today });
  const currentAthleteIds = new Set(athletes.map((athlete) => athlete.id));
  const completedSessions = sessions.filter((session) => Boolean(session.completedAt));
  const scheduledSessions = sessions.filter((session) => session.storedStatus !== "cancelled" && !session.completedAt);

  return <main className="min-h-screen bg-slate-950 px-6 py-10 text-white"><div className="mx-auto max-w-6xl">
    <Link href="/" className="text-sm font-medium text-emerald-400 hover:text-emerald-300">← Back to dashboard</Link>
    <header className="mt-8 mb-10"><p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Coach Dashboard</p><h1 className="mt-2 text-4xl font-bold">{team.name}</h1><p className="mt-3 text-slate-400">Manage your roster, assignments, and athlete progress.</p></header>

    <section className="mb-10" aria-labelledby="attention-heading">
      <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Team signals</p>
      <h2 id="attention-heading" className="mt-1 text-2xl font-semibold">Attention</h2>
      <p className="mt-1 text-sm text-slate-400">Recent factual training signals from your team’s recorded activity.</p>
      {signals.length === 0 ? <p className="mt-4 rounded-2xl border border-slate-800 bg-slate-900 p-5 text-slate-400">No eligible attention signals in the current closed-window data.</p> : <ul className="mt-4 space-y-3">{signals.map((signal) => {
        const scheduleHref = `/teams/${teamId}/schedule?athlete=${encodeURIComponent(signal.athleteId)}`;
        const hasCurrentAthleteDetail = currentAthleteIds.has(signal.athleteId);
        return <li key={signal.id} className="rounded-2xl border border-slate-800 bg-slate-900 p-5"><h3 className="text-lg font-semibold">{signal.athleteName}</h3><p className="mt-2 text-sm text-slate-300">{signal.text}</p><div className="mt-4 flex flex-wrap gap-4 text-sm font-medium"><Link href={scheduleHref} className="text-emerald-400 hover:text-emerald-300">View schedule for {signal.athleteName}</Link>{hasCurrentAthleteDetail ? <Link href={`/teams/${teamId}/athletes/${signal.athleteId}`} className="text-emerald-400 hover:text-emerald-300">View {signal.athleteName}</Link> : null}</div></li>;
      })}</ul>}
    </section>

    <section className="mb-10 grid gap-4 sm:grid-cols-3" aria-label="Team summary">
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6"><p className="text-sm text-slate-400">Athletes</p><p className="mt-2 text-3xl font-bold">{athletes.length}</p></div>
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6"><p className="text-sm text-slate-400">Scheduled</p><p className="mt-2 text-3xl font-bold">{scheduledSessions.length}</p></div>
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6"><p className="text-sm text-slate-400">Completed</p><p className="mt-2 text-3xl font-bold">{completedSessions.length}</p></div>
    </section>

    <section className="mb-10"><div className="mb-4"><p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Roster</p><h2 className="mt-1 text-2xl font-semibold">Athletes</h2><p className="mt-1 text-sm text-slate-400">View athlete activity and training status.</p></div>{athletes.length === 0 ? <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-slate-400">No athletes are currently on this team.</div> : <div className="space-y-4">{athletes.map((athlete) => {
      const athleteSessions = sessions.filter((session) => session.athleteId === athlete.id);
      const completed = athleteSessions.filter((session) => session.completedAt).length;
      const scheduled = athleteSessions.filter((session) => session.storedStatus !== "cancelled" && !session.completedAt).length;
      return <Link key={athlete.id} href={`/teams/${teamId}/athletes/${athlete.id}`} className="block rounded-2xl border border-slate-800 bg-slate-900 p-6 transition hover:border-emerald-500 hover:bg-slate-800"><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><p className="text-sm font-semibold uppercase tracking-wide text-emerald-400">Athlete</p><h3 className="mt-2 text-xl font-semibold">{athlete.name}</h3></div><div className="flex gap-6 text-sm"><div><p className="text-slate-500">Scheduled</p><p className="mt-1 text-lg font-semibold">{scheduled}</p></div><div><p className="text-slate-500">Completed</p><p className="mt-1 text-lg font-semibold">{completed}</p></div></div></div></Link>;
    })}</div>}</section>

    <section><div className="mb-4"><p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Next</p><h2 className="mt-1 text-2xl font-semibold">Coach Tools</h2></div><div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <Link href={`/teams/${teamId}/roster`} className="rounded-2xl border border-slate-800 bg-slate-900 p-6 transition hover:border-emerald-500 hover:bg-slate-800"><h3 className="text-lg font-semibold">Roster</h3><p className="mt-2 text-sm text-slate-400">Invite athletes and assistant coaches, manage members, and review pending invitations.</p></Link>
      <Link href={`/teams/${teamId}/plans`} className="rounded-2xl border border-slate-800 bg-slate-900 p-6 transition hover:border-emerald-500 hover:bg-slate-800"><h3 className="text-lg font-semibold">Training Plans</h3><p className="mt-2 text-sm text-slate-400">Manage your coach library, use TILT templates, and reuse plans across your teams.</p></Link>
      <Link href={`/teams/${teamId}/groups`} className="rounded-2xl border border-slate-800 bg-slate-900 p-6 transition hover:border-emerald-500 hover:bg-slate-800"><h3 className="text-lg font-semibold">Groups</h3><p className="mt-2 text-sm text-slate-400">Organize athletes by position, grade, skill, or custom groups.</p></Link>
      <Link href={`/teams/${teamId}/assign`} className="rounded-2xl border border-slate-800 bg-slate-900 p-6 transition hover:border-emerald-500 hover:bg-slate-800"><h3 className="text-lg font-semibold">Assign Training</h3><p className="mt-2 text-sm text-slate-400">Assign training plans to athletes.</p></Link>
      <Link href={`/teams/${teamId}/schedule`} className="rounded-2xl border border-slate-800 bg-slate-900 p-6 transition hover:border-emerald-500"><h3 className="text-lg font-semibold">Schedule</h3><p className="mt-2 text-sm text-slate-400">Review upcoming team training.</p></Link>
      <Link href={`/teams/${teamId}/adherence`} className="rounded-2xl border border-slate-800 bg-slate-900 p-6 transition hover:border-emerald-500"><h3 className="text-lg font-semibold">Adherence</h3><p className="mt-2 text-sm text-slate-400">Track athlete completion and progress.</p></Link>
      <Link href={`/teams/${teamId}/analytics`} className="rounded-2xl border border-slate-800 bg-slate-900 p-6 transition hover:border-emerald-500"><h3 className="text-lg font-semibold">Analytics</h3><p className="mt-2 text-sm text-slate-400">Review team training volume and attendance.</p></Link>
    </div></section>
  </div></main>;
}
