import Link from "next/link";
import { displayMinutes } from "@/lib/athlete-dashboard";
import { localDate } from "@/lib/team-attendance";
import { loadTeamAttendance } from "@/lib/team-attendance-server";
import { aggregateExerciseAdherence, type ExerciseAdherenceInput } from "@/lib/exercise-adherence";
import { completedInWindow, teamAnalytics, teamTrend } from "@/lib/team-analytics";

type Props = { params: Promise<{ teamId: string }>; searchParams: Promise<{ window?: string; sort?: string }> };

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5"><p className="text-sm text-slate-400">{label}</p><p className="mt-2 text-3xl font-bold">{value}</p></div>;
}

export default async function TeamAnalyticsPage({ params, searchParams }: Props) {
  const { teamId } = await params;
  const query = await searchParams;
  const { team, sessions, athletes } = await loadTeamAttendance(teamId);
  const today = localDate(new Date());
  const days: 7 | 30 = query.window === "30" ? 30 : 7;
  const summary = teamAnalytics(sessions, today, days);
  const trend = teamTrend(sessions, today, days);
  const unavailableAdherenceInput: ExerciseAdherenceInput = {
    result: null,
    attempt: null,
    prescription: null,
  };
  const adherenceFor = (rows: typeof sessions) => aggregateExerciseAdherence(
    rows
      .filter((session) => completedInWindow(session, today, days))
      .map((session) => session.exerciseAdherenceInput ?? unavailableAdherenceInput)
  );
  const teamExerciseAdherence = adherenceFor(sessions);
  const max = Math.max(...trend.map((item) => item.prescribedWorkMs), 1);
  const athleteRows = athletes.map((athlete) => {
    const athleteSessions = sessions.filter((session) => session.athleteUserId === athlete.id);
    return {
      athlete,
      metrics: teamAnalytics(athleteSessions, today, days),
      adherence: adherenceFor(athleteSessions),
    };
  });
  const sort = query.sort ?? "minutes";
  athleteRows.sort((first, second) => {
    if (sort === "name") return first.athlete.name.localeCompare(second.athlete.name);
    if (sort === "workouts") return second.metrics.completedWorkouts - first.metrics.completedWorkouts || first.athlete.name.localeCompare(second.athlete.name);
    if (sort === "attendance") return (second.metrics.attendance ?? -1) - (first.metrics.attendance ?? -1) || first.athlete.name.localeCompare(second.athlete.name);
    return second.metrics.prescribedWorkMs - first.metrics.prescribedWorkMs || first.athlete.name.localeCompare(second.athlete.name);
  });
  const followUp = athleteRows.filter((row) => row.metrics.missed > 0);

  return <main className="min-h-screen bg-slate-950 px-6 py-10 text-white"><div className="mx-auto max-w-6xl">
    <Link href={`/teams/${teamId}`} className="text-sm text-emerald-400">← Back to {team.name}</Link>
    <header className="my-8"><p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Team Analytics</p><h1 className="mt-2 text-4xl font-bold">{team.name}</h1><p className="mt-3 text-slate-400">Completed prescribed training volume and scheduled-session attendance. These minutes do not measure physical activity.</p></header>
    <nav className="mb-6 flex gap-2"><Link href="?window=7" className={`rounded-lg px-4 py-2 ${days === 7 ? "bg-emerald-500 text-slate-950" : "bg-slate-800"}`}>Last 7 days</Link><Link href="?window=30" className={`rounded-lg px-4 py-2 ${days === 30 ? "bg-emerald-500 text-slate-950" : "bg-slate-800"}`}>Last 30 days</Link></nav>
    <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6"><Metric label="Completed Workouts" value={summary.completedWorkouts}/><Metric label="Prescribed Minutes" value={displayMinutes(summary.prescribedWorkMs)}/><Metric label="Training Days" value={summary.trainingDays}/><Metric label="Attendance" value={summary.attendance === null ? "N/A" : `${summary.attendance}%`}/><Metric label="Active Athletes" value={summary.activeAthletes}/><Metric label="Exercise Adherence" value={teamExerciseAdherence.available ? `${teamExerciseAdherence.completedBlocks} of ${teamExerciseAdherence.prescribedBlocks} blocks • ${Math.round(teamExerciseAdherence.percentage)}%` : "N/A"}/></section>
    <p className="mt-3 text-sm text-slate-400">{teamExerciseAdherence.available ? `${teamExerciseAdherence.eligibleSessionCount} eligible of ${teamExerciseAdherence.eligibleSessionCount + teamExerciseAdherence.unavailableSessionCount} completed workouts in this window.` : "No eligible completed workouts in this window."}</p>
    <section className="mt-10"><p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Training volume</p><h2 className="mt-1 text-2xl font-semibold">Daily prescribed minutes</h2><div className="mt-4 grid gap-1 rounded-2xl border border-slate-800 bg-slate-900 p-5" style={{ gridTemplateColumns: `repeat(${days}, minmax(0, 1fr))` }}>{trend.map((item) => <div key={item.date} className="flex min-w-0 flex-col items-center gap-2"><span className="text-xs">{displayMinutes(item.prescribedWorkMs)}</span><div className="flex h-28 w-full items-end rounded bg-slate-800 p-1"><div className="w-full rounded bg-emerald-500" style={{ height: `${Math.max(item.prescribedWorkMs ? 8 : 0, item.prescribedWorkMs / max * 100)}%` }}/></div><span className="text-xs text-slate-500">{item.date.slice(5)}</span></div>)}</div></section>
    <section className="mt-10"><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Athletes</p><h2 className="mt-1 text-2xl font-semibold">Training overview</h2></div><div className="flex gap-2 text-sm">{[["minutes","Minutes"],["workouts","Workouts"],["attendance","Attendance"],["name","Name"]].map(([value,label]) => <Link key={value} href={`?window=${days}&sort=${value}`} className={`rounded px-3 py-2 ${sort === value ? "bg-emerald-500 text-slate-950" : "bg-slate-800"}`}>{label}</Link>)}</div></div><div className="mt-4 space-y-3">{athleteRows.map(({ athlete, metrics, adherence }) => <Link key={athlete.id} href={`/teams/${teamId}/athletes/${athlete.id}`} className="grid gap-2 rounded-2xl border border-slate-800 bg-slate-900 p-5 hover:border-emerald-500 sm:grid-cols-7"><strong className="text-emerald-400">{athlete.name}</strong><span>{metrics.completedWorkouts} workouts</span><span>{displayMinutes(metrics.prescribedWorkMs)} prescribed min</span><span>{metrics.trainingDays} days</span><span>{metrics.missed} missed</span><span>{metrics.attendance === null ? "Attendance N/A" : `${metrics.attendance}% attendance`}</span><span>{adherence.available ? `${adherence.completedBlocks}/${adherence.prescribedBlocks} blocks • ${Math.round(adherence.percentage)}%` : "Exercise adherence N/A"}</span></Link>)}</div></section>
    <section className="mt-10"><p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Needs follow-up</p><h2 className="mt-1 text-2xl font-semibold">Missed scheduled training</h2><p className="mt-1 text-sm text-slate-400">Athletes appear here only when they have one or more missed expected sessions in this window.</p><div className="mt-4 space-y-3">{followUp.length ? followUp.map(({ athlete, metrics }) => <Link key={athlete.id} href={`/teams/${teamId}/athletes/${athlete.id}`} className="block rounded-2xl border border-amber-500/40 bg-slate-900 p-5"><strong>{athlete.name}</strong><p className="mt-1 text-sm text-slate-400">{metrics.missed} missed scheduled {metrics.missed === 1 ? "session" : "sessions"}</p></Link>) : <p className="rounded-2xl border border-slate-800 bg-slate-900 p-5 text-slate-400">No missed expected sessions in this window.</p>}</div></section>
  </div></main>;
}
