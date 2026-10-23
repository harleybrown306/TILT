import Link from "next/link";
import { TeamMetric, TeamStatusPill, TeamToolGroup, TeamWorkspaceHeader } from "@/components/team-workspace";
import { deriveCoachAttentionSignals } from "@/lib/coach-attention-signals";
import { loadTeamAttentionAttendance } from "@/lib/team-attendance-server";

type PageProps = { params: Promise<{ teamId: string }> };

export default async function TeamDashboardPage({ params }: PageProps) {
  const { teamId } = await params;
  const { team, sessions, athletes, asOfDate } = await loadTeamAttentionAttendance(teamId);
  const today = asOfDate;
  const signals = deriveCoachAttentionSignals({ sessions, today });
  const currentAthleteIds = new Set(athletes.map((athlete) => athlete.id));
  const isOperationalCompletion = (session: typeof sessions[number]) =>
    session.storedStatus !== "cancelled" && Boolean(session.hasCanonicalCompletion);
  const completedSessions = sessions.filter(isOperationalCompletion);
  const scheduledSessions = sessions.filter((session) => session.storedStatus !== "cancelled" && !session.hasCanonicalCompletion);

  const toolGroups = [
    {
      eyebrow: "Team",
      title: "Set up your people",
      description: "Keep the roster and training groups current before making assignments.",
      tools: [
        { href: `/teams/${teamId}/roster`, label: "Roster", description: "Invite and manage athletes, coaches, and pending invitations." },
        { href: `/teams/${teamId}/groups`, label: "Groups", description: "Organize athletes by position, grade, skill, or custom groups." },
      ],
    },
    {
      eyebrow: "Plan",
      title: "Prepare training",
      description: "Build or reuse an active plan from your coach library before assigning work.",
      tools: [
        { href: `/teams/${teamId}/plans`, label: "Training plans", description: "Manage reusable plans and TILT templates." },
      ],
    },
    {
      eyebrow: "Assign",
      title: "Put training in motion",
      description: "Choose a plan and deliver it to the right athletes or groups.",
      tools: [
        { href: `/teams/${teamId}/assign`, label: "Assign training", description: "Assign an active training plan to athletes.", featured: true },
      ],
    },
    {
      eyebrow: "Review",
      title: "Check progress",
      description: "Review scheduled training, follow-through, and team-level trends.",
      tools: [
        { href: `/teams/${teamId}/schedule`, label: "Schedule", description: "Review upcoming team training." },
        { href: `/teams/${teamId}/adherence`, label: "Adherence", description: "Track athlete completion and progress." },
        { href: `/teams/${teamId}/analytics`, label: "Analytics", description: "Review training volume and attendance." },
      ],
    },
  ];

  return <main className="min-h-screen bg-slate-950 px-4 py-5 text-white sm:px-6 sm:py-8 lg:px-8 lg:py-10"><div className="mx-auto max-w-6xl">
    <TeamWorkspaceHeader teamId={teamId} teamName={team.name} />

    <section className="mb-10" aria-labelledby="attention-heading">
      <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400">Team signals</p><h2 id="attention-heading" className="mt-2 text-2xl font-semibold">Attention</h2><p className="mt-2 text-sm leading-6 text-slate-400">Recent factual training signals from your team’s recorded activity.</p></div><TeamStatusPill tone={signals.length > 0 ? "amber" : "slate"}>{signals.length > 0 ? `${signals.length} to review` : "All clear"}</TeamStatusPill></div>
      {signals.length === 0 ? <p className="mt-5 rounded-2xl border border-slate-800 bg-slate-900 p-5 text-sm leading-6 text-slate-400">No eligible attention signals in the current closed-window data.</p> : <ul className="mt-5 space-y-3">{signals.map((signal) => {
        const scheduleHref = `/teams/${teamId}/schedule?athlete=${encodeURIComponent(signal.athleteId)}`;
        const hasCurrentAthleteDetail = currentAthleteIds.has(signal.athleteId);
        return <li key={signal.id} className="rounded-2xl border border-slate-800 bg-slate-900 p-5"><div className="flex flex-wrap items-start justify-between gap-3"><h3 className="text-lg font-semibold">{signal.athleteName}</h3><TeamStatusPill tone="amber">Attention</TeamStatusPill></div><p className="mt-3 text-sm leading-6 text-slate-300">{signal.text}</p><div className="mt-5 flex flex-wrap gap-x-5 gap-y-3 text-sm font-semibold"><Link href={scheduleHref} className="text-emerald-400 transition hover:text-emerald-300">View schedule<span className="sr-only"> for {signal.athleteName}</span></Link>{hasCurrentAthleteDetail ? <Link href={`/teams/${teamId}/athletes/${signal.athleteId}`} className="text-emerald-400 transition hover:text-emerald-300">View athlete<span className="sr-only"> {signal.athleteName}</span></Link> : null}</div></li>;
      })}</ul>}
    </section>

    <section className="mb-10 grid gap-4 sm:grid-cols-3" aria-label="Team summary">
      <TeamMetric label="Athletes" value={athletes.length} detail="Current team roster" />
      <TeamMetric label="Scheduled" value={scheduledSessions.length} detail="Non-cancelled sessions in the last 30 days" />
      <TeamMetric label="Completed" value={completedSessions.length} detail="Canonical completions in the last 30 days" />
    </section>

    <section className="mb-10"><div className="mb-5"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400">Roster</p><h2 className="mt-2 text-2xl font-semibold">Athletes</h2><p className="mt-2 text-sm leading-6 text-slate-400">View athlete activity and training status.</p></div>{athletes.length === 0 ? <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-sm text-slate-400">No athletes are currently on this team.</div> : <div className="space-y-3">{athletes.map((athlete) => {
      const athleteSessions = sessions.filter((session) => session.athleteId === athlete.id);
      const completed = athleteSessions.filter(isOperationalCompletion).length;
      const scheduled = athleteSessions.filter((session) => session.storedStatus !== "cancelled" && !session.hasCanonicalCompletion).length;
      return <Link key={athlete.id} href={`/teams/${teamId}/athletes/${athlete.id}`} className="group block rounded-2xl border border-slate-800 bg-slate-900 p-5 transition hover:border-emerald-400/60 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-300"><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400">Athlete</p><h3 className="mt-2 text-xl font-semibold">{athlete.name}<span aria-hidden="true" className="ml-2 text-emerald-400 opacity-0 transition group-hover:ml-3 group-hover:opacity-100">→</span></h3></div><div className="flex flex-wrap gap-2"><TeamStatusPill tone="sky">{scheduled} scheduled</TeamStatusPill><TeamStatusPill tone="emerald">{completed} completed</TeamStatusPill></div></div></Link>;
    })}</div>}</section>

    <section aria-labelledby="coach-tools-heading"><div className="mb-5"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400">Coach tools</p><h2 id="coach-tools-heading" className="mt-2 text-2xl font-semibold">From setup to review</h2><p className="mt-2 text-sm leading-6 text-slate-400">A clear daily sequence: shape the team, prepare a plan, assign it, then review the results.</p></div><div className="grid gap-4 xl:grid-cols-2">{toolGroups.map((group) => <TeamToolGroup key={group.eyebrow} {...group} />)}</div></section>
  </div></main>;
}
