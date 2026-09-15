import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  athleteExerciseAdherenceInput,
  type AthleteAdherenceAttemptRow,
} from "@/lib/athlete-exercise-adherence";
import { calculateExerciseAdherence, type ExerciseAdherence } from "@/lib/exercise-adherence";
import { createClient } from "@/lib/supabase/server";

type PageProps = {
  params: Promise<{
    teamId: string;
    athleteId: string;
  }>;
};

type Profile = {
  id: string;
  full_name: string | null;
};

type Workout = {
  id: string;
  name: string;
};

type Related<T> = T | T[] | null;

type Result = {
  id: string;
  training_session_id: string;
  athlete_user_id: string;
};

type Prescription = {
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

type TrainingSession = {
  id: string;
  athlete_user_id: string;
  scheduled_date: string;
  status: string;
  workouts: Related<Workout>;
  workout_results: Related<Result>;
  workout_session_attempts: Related<Attempt>;
  training_session_prescriptions: Related<Prescription>;
};

type TrainingSessionWithAdherence = TrainingSession & {
  exerciseAdherence: ExerciseAdherence;
};

function getOne<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value;
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${date}T12:00:00`));
}

export default async function AthleteDetailPage({
  params,
}: PageProps) {
  const { teamId, athleteId } = await params;

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: coachMembership } = await supabase
    .from("team_memberships")
    .select("role")
    .eq("team_id", teamId)
    .eq("user_id", user.id)
    .single();

  if (
    !coachMembership ||
    !["coach", "assistant_coach"].includes(coachMembership.role)
  ) {
    redirect("/");
  }

  const [
    { data: team, error: teamError },
    { data: athleteMembership, error: athleteError },
    { data: sessions, error: sessionError },
  ] = await Promise.all([
    supabase
      .from("teams")
      .select("id, name")
      .eq("id", teamId)
      .single(),

    supabase
      .from("team_memberships")
      .select(`
        user_id,
        role,
        profiles!team_memberships_user_id_fkey (
          id,
          full_name
        )
      `)
      .eq("team_id", teamId)
      .eq("user_id", athleteId)
      .eq("role", "athlete")
      .single(),

    supabase
      .from("training_sessions")
      .select(`
        id,
        athlete_user_id,
        scheduled_date,
        status,
        workouts (
          id,
          name
        ),
        workout_results (
          id,
          training_session_id,
          athlete_user_id
        ),
        workout_session_attempts (
          workout_result_id,
          training_session_id,
          athlete_user_id,
          finalization_state,
          measurement_version,
          measurement_quality,
          prescribed_step_count,
          completed_work_blocks,
          skipped_work_blocks
        ),
        training_session_prescriptions (
          schema_version,
          step_count
        )
      `)
      .eq("team_id", teamId)
      .eq("athlete_user_id", athleteId)
      .order("scheduled_date", { ascending: false }),
  ]);

  if (teamError || !team) {
    notFound();
  }

  if (athleteError || !athleteMembership) {
    notFound();
  }

  if (sessionError) {
    console.error(
      "Unable to load athlete sessions:",
      sessionError.message
    );
  }

  const profile = getOne(
    athleteMembership.profiles as Profile | Profile[] | null
  );

  const athleteSessions: TrainingSessionWithAdherence[] = ((sessions ?? []) as TrainingSession[]).map((session) => {
    const result = getOne(session.workout_results);
    const prescription = getOne(session.training_session_prescriptions);
    const attempts = Array.isArray(session.workout_session_attempts)
      ? session.workout_session_attempts
      : session.workout_session_attempts
        ? [session.workout_session_attempts]
        : [];
    const adherenceInput = athleteExerciseAdherenceInput({
      sessionId: session.id,
      athleteUserId: session.athlete_user_id,
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
            sessionId: session.id,
            schemaVersion: prescription.schema_version,
            stepCount: prescription.step_count,
          }
        : null,
    });

    return {
      ...session,
      exerciseAdherence: calculateExerciseAdherence(adherenceInput),
    };
  });

  const scheduledSessions = athleteSessions.filter(
    (session) => session.status !== "completed"
  );

  const completedSessions = athleteSessions.filter(
    (session) => session.status === "completed"
  );

  const totalSessions = athleteSessions.length;

  const completionRate =
    totalSessions === 0
      ? 0
      : Math.round((completedSessions.length / totalSessions) * 100);

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-white">
      <div className="mx-auto max-w-6xl">
        <Link
          href={`/teams/${teamId}`}
          className="text-sm font-medium text-emerald-400 hover:text-emerald-300"
        >
          ← Back to {team.name}
        </Link>

        <header className="mt-8 mb-10">
          <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">
            Athlete Profile
          </p>

          <h1 className="mt-2 text-4xl font-bold">
            {profile?.full_name ?? "Unnamed athlete"}
          </h1>

          <p className="mt-3 text-slate-400">
            {team.name} training activity and adherence.
          </p>
        </header>

        <section className="mb-10 grid gap-4 sm:grid-cols-3">
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <p className="text-sm text-slate-400">
              Scheduled
            </p>

            <p className="mt-2 text-3xl font-bold">
              {scheduledSessions.length}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <p className="text-sm text-slate-400">
              Completed
            </p>

            <p className="mt-2 text-3xl font-bold">
              {completedSessions.length}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <p className="text-sm text-slate-400">
              Completion rate
            </p>

            <p className="mt-2 text-3xl font-bold">
              {completionRate}%
            </p>
          </div>
        </section>

        <section className="mb-10">
          <div className="mb-4">
            <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">
              Training
            </p>

            <h2 className="mt-1 text-2xl font-semibold">
              Assigned Workouts
            </h2>

            <p className="mt-1 text-sm text-slate-400">
              All scheduled and completed training for this athlete.
            </p>
          </div>

          {athleteSessions.length === 0 ? (
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-slate-400">
              No training sessions have been assigned yet.
            </div>
          ) : (
            <div className="space-y-4">
              {athleteSessions.map((session) => {
                const workout = getOne(session.workouts);

                return (
                  <div
                    key={session.id}
                    className="rounded-2xl border border-slate-800 bg-slate-900 p-6"
                  >
                    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
                      <div>
                        <div className="flex flex-wrap items-center gap-3">
                          <p className="text-sm font-semibold text-emerald-400">
                            {formatDate(session.scheduled_date)}
                          </p>

                          <span
                            className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${
                              session.status === "completed"
                                ? "bg-emerald-500/10 text-emerald-400"
                                : "bg-slate-800 text-slate-300"
                            }`}
                          >
                            {session.status.replace("_", " ")}
                          </span>
                        </div>

                        <h3 className="mt-3 text-xl font-semibold">
                          {workout?.name ?? "Assigned workout"}
                        </h3>
                        {session.status === "completed" && (
                          <p className="mt-2 text-sm text-slate-400">
                            {session.exerciseAdherence.available
                              ? `Exercise adherence: ${session.exerciseAdherence.completedBlocks} of ${session.exerciseAdherence.prescribedBlocks} prescribed work blocks completed (${Math.round(session.exerciseAdherence.percentage)}%)`
                              : "Exercise adherence: N/A"}
                          </p>
                        )}
                      </div>

                      <Link
                        href={`/training/${session.id}`}
                        className="rounded-lg border border-slate-700 px-5 py-3 text-center text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
                      >
                        View workout
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
