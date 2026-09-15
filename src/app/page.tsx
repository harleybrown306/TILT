import Link from "next/link";
import { redirect } from "next/navigation";
import SignOutButton from "@/components/sign-out-button";
import {
  activityBuckets,
  athleteDashboardMetrics,
  displayMinutes,
  isCompleted,
  type AthleteDashboardSession,
} from "@/lib/athlete-dashboard";
import {
  athleteExerciseAdherenceInput,
  type AthleteAdherenceAttemptRow,
} from "@/lib/athlete-exercise-adherence";
import {
  aggregateExerciseAdherence,
  calculateExerciseAdherence,
  type ExerciseAdherence,
} from "@/lib/exercise-adherence";
import { attendanceStatus, formatScheduledDate, localDate, shiftDate } from "@/lib/team-attendance";
import { createClient } from "@/lib/supabase/server";

type Team = { id: string; name: string };
type Membership = {
  id: string;
  role: "coach" | "assistant_coach" | "athlete";
  team_id: string;
  teams: Team | Team[] | null;
};
type Related<T> = T | T[] | null;
type Result = {
  id: string;
  training_session_id: string;
  athlete_user_id: string;
  completed_at: string;
};
type Prescription = {
  workout_name: string;
  prescribed_work_ms: number;
  prescribed_total_ms: number;
  schema_version: number;
  step_count: number;
};
type Attempt = {
  workout_result_id: string | null;
  training_session_id: string;
  athlete_user_id: string;
  finalization_state: string;
  measurement_version: number;
  measurement_quality: string;
  prescribed_step_count: number;
  completed_work_blocks: number;
  skipped_work_blocks: number;
};
type SessionRow = {
  id: string;
  team_id: string;
  athlete_user_id: string;
  scheduled_date: string;
  status: string;
  teams: Related<Team>;
  training_session_prescriptions: Related<Prescription>;
  workout_results: Related<Result>;
  workout_session_attempts: Related<Attempt>;
};

type AthleteDashboardSessionWithAdherence = AthleteDashboardSession & {
  exerciseAdherence: ExerciseAdherence;
  exerciseAdherenceInput: ReturnType<typeof athleteExerciseAdherenceInput>;
};

function one<T>(value: Related<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function sessionStatus(session: AthleteDashboardSession, today: string) {
  return attendanceStatus(
    {
      scheduledDate: session.scheduledDate,
      storedStatus: session.status,
      completedAt: session.completedAt,
    },
    today
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "completed"
      ? "bg-emerald-500/15 text-emerald-300"
      : status === "pending"
        ? "bg-amber-500/15 text-amber-300"
        : status === "upcoming"
          ? "bg-sky-500/15 text-sky-300"
          : "bg-slate-800 text-slate-300";

  return (
    <span className={`rounded-full px-3 py-1 text-xs font-semibold capitalize ${tone}`}>
      {status}
    </span>
  );
}

function TrainingCard({
  session,
  today,
  recent = false,
}: {
  session: AthleteDashboardSessionWithAdherence;
  today: string;
  recent?: boolean;
}) {
  const status = sessionStatus(session, today);
  const prescribedMinutes =
    session.prescribedWorkMs === null ? null : displayMinutes(session.prescribedWorkMs);

  return (
    <div className="flex flex-col justify-between gap-5 rounded-2xl border border-slate-800 bg-slate-900 p-6 sm:flex-row sm:items-center">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm font-semibold text-emerald-400">
            {formatScheduledDate(session.scheduledDate)}
          </p>
          <StatusPill status={status} />
        </div>
        <h3 className="mt-3 text-xl font-semibold">{session.workoutName}</h3>
        <p className="mt-1 text-sm text-slate-400">{session.teamName}</p>
        {recent && (
          <>
            <p className="mt-2 text-sm text-slate-400">
              {prescribedMinutes === null
                ? "Prescribed minutes unavailable for this session."
                : `${prescribedMinutes} prescribed work min`}
              {session.completedAt
                ? ` · Completed ${new Intl.DateTimeFormat("en-US", {
                    timeZone: "America/Chicago",
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  }).format(new Date(session.completedAt))}`
                : ""}
            </p>
            <p className="mt-2 text-sm text-slate-400">
              {session.exerciseAdherence.available
                ? `Exercise adherence: ${session.exerciseAdherence.completedBlocks} of ${session.exerciseAdherence.prescribedBlocks} prescribed work blocks completed (${Math.round(session.exerciseAdherence.percentage)}%)`
                : "Exercise adherence: N/A"}
            </p>
          </>
        )}
      </div>
      <Link
        href={`/training/${session.id}`}
        className={`rounded-lg px-5 py-3 text-center font-semibold transition ${
          isCompleted(session)
            ? "border border-slate-700 text-slate-200 hover:bg-slate-800"
            : "bg-emerald-500 text-slate-950 hover:bg-emerald-400"
        }`}
      >
        {isCompleted(session) ? "View workout" : "Start workout"}
      </Link>
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <p className="text-sm text-slate-400">{label}</p>
      <p className="mt-2 text-3xl font-bold">{value}</p>
      {detail && <p className="mt-2 text-xs text-slate-500">{detail}</p>}
    </div>
  );
}

export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const [
    { data: profile },
    { data: memberships, error: membershipError },
    { data: rows, error: sessionError },
  ] = await Promise.all([
    supabase.from("profiles").select("full_name,platform_role").eq("id", user.id).single(),
    supabase
      .from("team_memberships")
      .select("id,role,team_id,teams(id,name)")
      .eq("user_id", user.id),
    supabase
      .from("training_sessions")
      .select(
        "id,team_id,athlete_user_id,scheduled_date,status,teams(id,name),training_session_prescriptions(workout_name,prescribed_work_ms,prescribed_total_ms,schema_version,step_count),workout_results(id,training_session_id,athlete_user_id,completed_at),workout_session_attempts(workout_result_id,training_session_id,athlete_user_id,finalization_state,measurement_version,measurement_quality,prescribed_step_count,completed_work_blocks,skipped_work_blocks)"
      )
      .eq("athlete_user_id", user.id)
      .order("scheduled_date", { ascending: true })
      .order("id", { ascending: true }),
  ]);

  if (membershipError) console.error("Unable to load memberships:", membershipError.message);
  if (sessionError) console.error("Unable to load training sessions:", sessionError.message);

  const teamMemberships = (memberships ?? []) as Membership[];
  const athleteMemberships = teamMemberships.filter((membership) => membership.role === "athlete");
  const coachMemberships = teamMemberships.filter(
    (membership) => membership.role === "coach" || membership.role === "assistant_coach"
  );
  const sessions: AthleteDashboardSessionWithAdherence[] = ((rows ?? []) as SessionRow[]).map((row) => {
    const team = one(row.teams);
    const prescription = one(row.training_session_prescriptions);
    const result = one(row.workout_results);
    const attempts = Array.isArray(row.workout_session_attempts)
      ? row.workout_session_attempts
      : row.workout_session_attempts
        ? [row.workout_session_attempts]
        : [];
    const adherenceSource = {
      sessionId: row.id,
      athleteUserId: row.athlete_user_id,
      result: result
        ? {
            id: result.id,
            trainingSessionId: result.training_session_id,
            athleteUserId: result.athlete_user_id,
          }
        : null,
      attempts: attempts.map((attempt): AthleteAdherenceAttemptRow => ({
        workoutResultId: attempt.workout_result_id,
        trainingSessionId: attempt.training_session_id,
        athleteUserId: attempt.athlete_user_id,
        finalizationState: attempt.finalization_state,
        measurementVersion: attempt.measurement_version,
        measurementQuality: attempt.measurement_quality,
        prescribedStepCount: attempt.prescribed_step_count,
        completedWorkBlocks: attempt.completed_work_blocks,
        skippedWorkBlocks: attempt.skipped_work_blocks,
      })),
      prescription: prescription
        ? {
            sessionId: row.id,
            schemaVersion: prescription.schema_version,
            stepCount: prescription.step_count,
          }
        : null,
    };
    const adherenceInput = athleteExerciseAdherenceInput(adherenceSource);

    return {
      id: row.id,
      teamId: row.team_id,
      teamName: team?.name ?? "Team",
      scheduledDate: row.scheduled_date,
      status: row.status,
      workoutName: prescription?.workout_name ?? "Assigned workout",
      completedAt: result?.completed_at ?? null,
      prescribedWorkMs: prescription?.prescribed_work_ms ?? null,
      prescribedTotalMs: prescription?.prescribed_total_ms ?? null,
      exerciseAdherence: calculateExerciseAdherence(adherenceInput),
      exerciseAdherenceInput: adherenceInput,
    };
  });
  const today = localDate(new Date());
  const metrics = athleteDashboardMetrics(sessions, today);
  const todayTraining = sessions.filter((session) => session.scheduledDate === today && !isCompleted(session));
  const upcomingTraining = sessions.filter(
    (session) => session.scheduledDate > today && !isCompleted(session)
  );
  const recentActivity = sessions
    .filter((session) => isCompleted(session) && session.scheduledDate <= today)
    .sort((first, second) => {
      const firstDate = first.completedAt ?? first.scheduledDate;
      const secondDate = second.completedAt ?? second.scheduledDate;
      return secondDate.localeCompare(firstDate);
    })
    .slice(0, 5);
  const chart = activityBuckets(sessions, today);
  const weeklyExerciseAdherence = aggregateExerciseAdherence(
    sessions
      .filter(
        (session) =>
          isCompleted(session) &&
          session.scheduledDate <= today &&
          session.scheduledDate >= shiftDate(today, -6)
      )
      .map((session) => session.exerciseAdherenceInput)
  );
  const chartMax = Math.max(...chart.map((bucket) => bucket.workMs), 1);
  const displayName = profile?.full_name || user.email || "TILT User";

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-white">
      <div className="mx-auto max-w-6xl">
        <header className="mb-10 flex items-start justify-between gap-6">
          <div>
            <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">TILT</p>
            <h1 className="mt-2 text-4xl font-bold">Welcome, {displayName}</h1>
            <p className="mt-3 text-slate-400">Your Time Interval Lacrosse Training dashboard.</p>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            {athleteMemberships.length > 0 && (
              <Link href="/training-resume" className="font-semibold text-emerald-400">Training Resume</Link>
            )}
            {profile?.platform_role === "admin" && (
              <Link href="/admin" className="font-semibold text-emerald-400">Admin</Link>
            )}
            <SignOutButton />
          </div>
        </header>

        {athleteMemberships.length > 0 && (
          <>
            <section id="athlete-training" className="mb-10">
              <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Today</p>
              <h2 className="mt-1 text-2xl font-semibold">Today&apos;s Training</h2>
              <p className="mt-1 text-sm text-slate-400">What you need to complete today.</p>
              <div className="mt-4 space-y-4">
                {todayTraining.length ? todayTraining.map((session) => (
                  <TrainingCard key={session.id} session={session} today={today} />
                )) : (
                  <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
                    <p className="font-medium">You&apos;re caught up for today.</p>
                    <p className="mt-1 text-sm text-slate-400">No unfinished training is scheduled for today.</p>
                  </div>
                )}
              </div>
            </section>

            <section className="mb-10">
              <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Time summary</p>
              <h2 className="mt-1 text-2xl font-semibold">Your training time</h2>
              <p className="mt-1 text-sm text-slate-400">Minutes are completed prescribed work, not measured physical activity.</p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
                <Metric label="Weekly Prescribed Minutes" value={displayMinutes(metrics.weeklyWorkMs)} detail="Rolling 7 local dates" />
                <Metric label="Monthly Prescribed Minutes" value={displayMinutes(metrics.monthlyWorkMs)} detail="Current local calendar month" />
                <Metric label="Completed Workouts" value={metrics.totalCompletedWorkouts} />
                <Metric label="Training Days" value={metrics.trainingDays} detail="Distinct scheduled completion dates" />
                <Metric label="Current Training Streak" value={`${metrics.currentStreak} days`} detail="Consecutive training days" />
                <Metric
                  label="Exercise Adherence"
                  value={weeklyExerciseAdherence.available
                    ? `${weeklyExerciseAdherence.completedBlocks} of ${weeklyExerciseAdherence.prescribedBlocks} blocks • ${Math.round(weeklyExerciseAdherence.percentage)}%`
                    : "N/A"}
                  detail={weeklyExerciseAdherence.available
                    ? `${weeklyExerciseAdherence.eligibleSessionCount} eligible of ${weeklyExerciseAdherence.eligibleSessionCount + weeklyExerciseAdherence.unavailableSessionCount} completed workouts in 7 days`
                    : "No eligible completed workouts in 7 days"}
                />
              </div>
            </section>

            <section className="mb-10">
              <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Activity trend</p>
              <h2 className="mt-1 text-2xl font-semibold">Last 7 days</h2>
              <p className="mt-1 text-sm text-slate-400">Completed prescribed work minutes by scheduled date.</p>
              <div className="mt-4 grid grid-cols-7 gap-2 rounded-2xl border border-slate-800 bg-slate-900 p-5">
                {chart.map((bucket) => {
                  const minutes = displayMinutes(bucket.workMs);
                  return (
                    <div key={bucket.date} className="flex min-w-0 flex-col items-center gap-2">
                      <span className="text-xs font-semibold text-slate-300">{minutes}</span>
                      <div className="flex h-28 w-full items-end rounded bg-slate-800 p-1">
                        <div className="w-full rounded bg-emerald-500" style={{ height: `${Math.max(bucket.workMs ? 8 : 0, (bucket.workMs / chartMax) * 100)}%` }} />
                      </div>
                      <span className="text-center text-xs text-slate-500">{formatScheduledDate(bucket.date).split(",")[0]}</span>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="mb-10">
              <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Schedule</p>
              <h2 className="mt-1 text-2xl font-semibold">Upcoming Training</h2>
              <div className="mt-4 space-y-4">
                {upcomingTraining.length ? upcomingTraining.map((session) => (
                  <TrainingCard key={session.id} session={session} today={today} />
                )) : <p className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-slate-400">No upcoming workouts are currently scheduled.</p>}
              </div>
            </section>

            <section className="mb-10">
              <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Progress</p>
              <h2 className="mt-1 text-2xl font-semibold">Recent Activity</h2>
              <div className="mt-4 space-y-4">
                {recentActivity.length ? recentActivity.map((session) => (
                  <TrainingCard key={session.id} session={session} today={today} recent />
                )) : <p className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-slate-400">Completed workouts will appear here.</p>}
              </div>
            </section>
          </>
        )}

        <section>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold">Your teams</h2>
              <p className="mt-1 text-sm text-slate-400">Your experience depends on your role within each team.</p>
            </div>
            <Link href="/teams/new" className="rounded-xl bg-emerald-500 px-5 py-3 font-semibold text-slate-950 hover:bg-emerald-400">Create Team</Link>
          </div>
          {teamMemberships.length === 0 ? (
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-slate-400">You are not currently a member of a team.</div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {teamMemberships.map((membership) => {
                const team = one(membership.teams);
                return (
                  <Link key={membership.id} href={membership.role === "athlete" ? "/#athlete-training" : `/teams/${membership.team_id}`} className="block rounded-2xl border border-slate-800 bg-slate-900 p-6 transition hover:border-emerald-500 hover:bg-slate-800">
                    <p className="text-sm font-semibold uppercase tracking-wide text-emerald-400">{membership.role.replace("_", " ")}</p>
                    <h3 className="mt-2 text-xl font-semibold">{team?.name ?? "Unnamed team"}</h3>
                    <p className="mt-3 text-sm text-slate-400">{membership.role === "athlete" ? "View your assigned training" : "Open team management dashboard"}</p>
                  </Link>
                );
              })}
            </div>
          )}
          {coachMemberships.length === 0 && athleteMemberships.length === 0 && <p className="mt-4 text-sm text-slate-500">Join a team or create one to get started.</p>}
        </section>
      </div>
    </main>
  );
}
