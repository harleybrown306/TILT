import Link from "next/link";
import { loadMyTrainingResume } from "@/lib/training-resume-server";

function formatDuration(milliseconds: number) {
  const minutes = Math.round(milliseconds / 60_000);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours === 0) return `${minutes}m`;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${date}T12:00:00Z`));
}

function formatMonth(period: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "long",
    year: "numeric",
  }).format(new Date(`${period}-01T12:00:00Z`));
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

export default async function TrainingResumePage() {
  const resume = await loadMyTrainingResume();
  const { overview, prescribedTrainingTime, streaks, exerciseAdherence, history } = resume;

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-white">
      <div className="mx-auto max-w-6xl">
        <Link href="/" className="text-sm font-medium text-emerald-400 hover:text-emerald-300">
          ← Back to dashboard
        </Link>

        <header className="mt-8 mb-10">
          <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">TILT</p>
          <h1 className="mt-2 text-4xl font-bold">Training Resume</h1>
          <p className="mt-3 max-w-3xl text-slate-400">
            Your Training Resume summarizes workouts recorded in TILT. Prescribed training time reflects documented workout prescriptions and does not verify physical effort or activity.
          </p>
        </header>

        {overview.completedWorkouts === 0 ? (
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <h2 className="text-2xl font-semibold">Your training record will appear here.</h2>
            <p className="mt-2 text-slate-400">Complete an assigned workout to begin building your Training Resume.</p>
          </section>
        ) : (
          <>
            <section className="mb-10">
              <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Training Overview</p>
              <h2 className="mt-1 text-2xl font-semibold">Your documented training record</h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <Metric label="Completed Workouts" value={overview.completedWorkouts} />
                <Metric label="Training Days" value={overview.trainingDays} />
                <Metric label="Training Since" value={overview.firstTrainingDate ? formatDate(overview.firstTrainingDate) : "N/A"} detail={overview.latestTrainingDate ? `Through ${formatDate(overview.latestTrainingDate)}` : undefined} />
                <Metric label="Current Streak" value={`${streaks.current} days`} detail="Consecutive training days" />
                <Metric label="Longest Streak" value={`${streaks.longest} days`} detail="Consecutive training days" />
              </div>
            </section>

            <section className="mb-10 rounded-2xl border border-slate-800 bg-slate-900 p-6">
              <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Documented Prescribed Training Time</p>
              <p className="mt-2 text-4xl font-bold">{formatDuration(prescribedTrainingTime.prescribedWorkMs)}</p>
              <p className="mt-3 text-sm text-slate-400">
                {prescribedTrainingTime.coveredWorkoutCount === prescribedTrainingTime.totalCompletedWorkoutCount
                  ? `Documented for all ${prescribedTrainingTime.totalCompletedWorkoutCount} completed workouts.`
                  : `Documented for ${prescribedTrainingTime.coveredWorkoutCount} of ${prescribedTrainingTime.totalCompletedWorkoutCount} completed workouts.`}
              </p>
            </section>

            <section className="mb-10 rounded-2xl border border-slate-800 bg-slate-900 p-6">
              <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Exercise Adherence</p>
              {exerciseAdherence.available ? (
                <>
                  <p className="mt-2 text-4xl font-bold">{Math.round(exerciseAdherence.percentage)}%</p>
                  <p className="mt-3 text-sm text-slate-400">{exerciseAdherence.completedBlocks} of {exerciseAdherence.prescribedBlocks} prescribed work blocks completed</p>
                  <p className="mt-1 text-sm text-slate-500">{exerciseAdherence.eligibleSessionCount} of {exerciseAdherence.eligibleSessionCount + exerciseAdherence.unavailableSessionCount} completed workouts have qualifying adherence data.</p>
                </>
              ) : (
                <p className="mt-3 text-4xl font-bold">N/A</p>
              )}
            </section>

            <section className="mb-10">
              <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Training History</p>
              <h2 className="mt-1 text-2xl font-semibold">Monthly record</h2>
              <div className="mt-4 space-y-3">
                {[...history.monthly].reverse().map((record) => (
                  <div key={record.period} className="rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:flex sm:items-center sm:justify-between">
                    <div>
                      <h3 className="text-lg font-semibold">{formatMonth(record.period)}</h3>
                      <p className="mt-1 text-sm text-slate-400">{record.completedWorkouts} completed workouts · {record.trainingDays} training days</p>
                    </div>
                    <div className="mt-3 text-sm text-slate-300 sm:mt-0 sm:text-right">
                      <p className="font-semibold">{formatDuration(record.prescribedWorkMs)} documented prescribed time</p>
                      {record.prescribedTimeCoveredWorkoutCount !== record.completedWorkouts && (
                        <p className="mt-1 text-slate-500">Documented for {record.prescribedTimeCoveredWorkoutCount} of {record.completedWorkouts} completed workouts.</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
