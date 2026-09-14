import Link from "next/link";
import { loadTeamAttendance } from "@/lib/team-attendance-server";
import {
  attendanceStatus,
  completedLate,
  formatScheduledDate,
  localDate,
  type AttendanceSession,
  type AttendanceStatus,
} from "@/lib/team-attendance";

type Props = {
  params: Promise<{ teamId: string }>;
  searchParams: Promise<{
    athlete?: string;
    status?: string;
    from?: string;
    to?: string;
  }>;
};

const tones: Record<AttendanceStatus, string> = {
  completed: "bg-emerald-500/15 text-emerald-300",
  pending: "bg-amber-500/15 text-amber-300",
  upcoming: "bg-sky-500/15 text-sky-300",
  missed: "bg-rose-500/15 text-rose-300",
  cancelled: "bg-slate-700 text-slate-300",
};

function Row({
  session,
  today,
  teamId,
}: {
  session: AttendanceSession;
  today: string;
  teamId: string;
}) {
  const status = attendanceStatus(session, today);
  const completedDate = session.completedAt
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        month: "short",
        day: "numeric",
      }).format(new Date(session.completedAt))
    : null;

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <Link
            className="font-semibold text-emerald-400 hover:text-emerald-300"
            href={`/teams/${teamId}/athletes/${session.athleteUserId}`}
          >
            {session.athleteName}
          </Link>
          <h3 className="mt-1 text-lg font-semibold">{session.workoutName}</h3>
          <p className="mt-1 text-sm text-slate-400">
            {formatScheduledDate(session.scheduledDate)}
            {completedDate ? ` · Completed ${completedDate}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold capitalize ${tones[status]}`}
          >
            {status}
          </span>
          {completedLate(session) && (
            <span className="text-xs text-amber-300">Completed late</span>
          )}
        </div>
      </div>
    </div>
  );
}

export default async function Page({ params, searchParams }: Props) {
  const { teamId } = await params;
  const query = await searchParams;
  const { team, sessions, athletes } = await loadTeamAttendance(teamId);
  const today = localDate(new Date());
  const shown = sessions.filter(
    (session) =>
      (!query.athlete || session.athleteUserId === query.athlete) &&
      (!query.status || attendanceStatus(session, today) === query.status) &&
      (!query.from || session.scheduledDate >= query.from) &&
      (!query.to || session.scheduledDate <= query.to)
  );
  const sections = [
    { title: "Today", rows: shown.filter((session) => session.scheduledDate === today) },
    { title: "Upcoming", rows: shown.filter((session) => session.scheduledDate > today) },
    {
      title: "Recent / Past",
      rows: shown
        .filter((session) => session.scheduledDate < today)
        .sort((first, second) => second.scheduledDate.localeCompare(first.scheduledDate)),
    },
  ];

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-white">
      <div className="mx-auto max-w-6xl">
        <Link href={`/teams/${teamId}`} className="text-sm text-emerald-400">
          ← Back to {team.name}
        </Link>
        <header className="my-8">
          <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">
            Coach Schedule
          </p>
          <h1 className="mt-2 text-4xl font-bold">{team.name} training</h1>
          <p className="mt-3 text-slate-400">
            Scheduled-session attendance in America/Chicago.
          </p>
        </header>

        <form className="mb-8 grid gap-3 rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:grid-cols-5">
          <select name="athlete" defaultValue={query.athlete ?? ""} className="rounded-lg bg-slate-950 p-3">
            <option value="">All athletes</option>
            {athletes.map((athlete) => (
              <option key={athlete.id} value={athlete.id}>
                {athlete.name}
              </option>
            ))}
          </select>
          <select name="status" defaultValue={query.status ?? ""} className="rounded-lg bg-slate-950 p-3">
            <option value="">All statuses</option>
            {Object.keys(tones).map((status) => (
              <option key={status}>{status}</option>
            ))}
          </select>
          <input aria-label="From date" name="from" type="date" defaultValue={query.from} className="rounded-lg bg-slate-950 p-3" />
          <input aria-label="To date" name="to" type="date" defaultValue={query.to} className="rounded-lg bg-slate-950 p-3" />
          <button className="rounded-lg bg-emerald-500 p-3 font-semibold text-slate-950">
            Apply filters
          </button>
        </form>

        {sections.map((section) => (
          <section key={section.title} className="mb-9">
            <h2 className="mb-4 text-2xl font-semibold">
              {section.title} <span className="text-base text-slate-500">({section.rows.length})</span>
            </h2>
            <div className="space-y-3">
              {section.rows.length ? (
                section.rows.map((session) => (
                  <Row key={session.id} session={session} today={today} teamId={teamId} />
                ))
              ) : (
                <p className="rounded-2xl border border-slate-800 bg-slate-900 p-5 text-slate-400">
                  No matching sessions.
                </p>
              )}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
