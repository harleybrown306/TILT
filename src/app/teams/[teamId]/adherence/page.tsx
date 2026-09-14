import Link from "next/link";
import { loadTeamAttendance } from "@/lib/team-attendance-server";
import { attendanceSummary, localDate } from "@/lib/team-attendance";

type Props = {
  params: Promise<{ teamId: string }>;
  searchParams: Promise<{ window?: string }>;
};

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <p className="text-sm text-slate-400">{label}</p>
      <p className="mt-2 text-3xl font-bold">{value}</p>
    </div>
  );
}

export default async function Page({ params, searchParams }: Props) {
  const { teamId } = await params;
  const query = await searchParams;
  const { team, sessions, athletes } = await loadTeamAttendance(teamId);
  const today = localDate(new Date());
  const days: 7 | 30 = query.window === "30" ? 30 : 7;
  const summary = attendanceSummary(sessions, today, days);

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-white">
      <div className="mx-auto max-w-6xl">
        <Link href={`/teams/${teamId}`} className="text-sm text-emerald-400">
          ← Back to {team.name}
        </Link>
        <header className="my-8">
          <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">
            Attendance Adherence
          </p>
          <h1 className="mt-2 text-4xl font-bold">{team.name}</h1>
          <p className="mt-3 text-slate-400">
            Scheduled-session completion only. This does not measure training quality or effort.
          </p>
        </header>

        <nav className="mb-6 flex gap-2">
          <Link
            href="?window=7"
            className={`rounded-lg px-4 py-2 ${days === 7 ? "bg-emerald-500 text-slate-950" : "bg-slate-800"}`}
          >
            Last 7 days
          </Link>
          <Link
            href="?window=30"
            className={`rounded-lg px-4 py-2 ${days === 30 ? "bg-emerald-500 text-slate-950" : "bg-slate-800"}`}
          >
            Last 30 days
          </Link>
        </nav>

        <section className="grid gap-4 sm:grid-cols-4">
          <Metric label="Expected" value={summary.expected} />
          <Metric label="Completed" value={summary.completed} />
          <Metric label="Missed" value={summary.missed} />
          <Metric label="Attendance" value={summary.percent === null ? "N/A" : `${summary.percent}%`} />
        </section>

        <section className="mt-10">
          <h2 className="mb-4 text-2xl font-semibold">Athlete breakdown</h2>
          <div className="space-y-3">
            {athletes.map((athlete) => {
              const athleteSummary = attendanceSummary(
                sessions.filter((session) => session.athleteUserId === athlete.id),
                today,
                days
              );

              return (
                <Link
                  key={athlete.id}
                  href={`/teams/${teamId}/athletes/${athlete.id}`}
                  className="grid gap-3 rounded-2xl border border-slate-800 bg-slate-900 p-5 hover:border-emerald-500 sm:grid-cols-5"
                >
                  <strong className="text-emerald-400">{athlete.name}</strong>
                  <span>Expected {athleteSummary.expected}</span>
                  <span>Completed {athleteSummary.completed}</span>
                  <span>Missed {athleteSummary.missed}</span>
                  <span className="font-semibold">
                    {athleteSummary.percent === null ? "N/A" : `${athleteSummary.percent}%`}
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
