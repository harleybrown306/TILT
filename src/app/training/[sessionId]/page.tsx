import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import WorkoutPlayer from "@/components/workout/workout-player";

type PageProps = {
  params: Promise<{
    sessionId: string;
  }>;
};

type Workout = {
  id: string;
  name: string;
  description: string | null;
};

type Team = {
  id: string;
  name: string;
};

type Exercise = {
  id: string;
  name: string;
};

type WorkoutStep = {
  id: string;
  position: number;
  duration_seconds: number | null;
  rest_seconds: number | null;
  off_hand: boolean;
  notes: string | null;
  exercises: Exercise | Exercise[] | null;
};

function getOne<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value;
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${date}T12:00:00`));
}

function formatTime(seconds: number | null) {
  if (!seconds) return "—";

  if (seconds < 60) {
    return `${seconds} sec`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (remainingSeconds === 0) {
    return `${minutes} min`;
  }

  return `${minutes}m ${remainingSeconds}s`;
}

export default async function TrainingSessionPage({
  params,
}: PageProps) {
  const { sessionId } = await params;

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: session, error: sessionError } = await supabase
    .from("training_sessions")
    .select(`
      id,
      scheduled_date,
      status,
      workout_id,
      team_id,
      athlete_user_id,
      workouts (
        id,
        name,
        description
      ),
      teams (
        id,
        name
      )
    `)
    .eq("id", sessionId)
    .single();

  if (sessionError || !session) {
    notFound();
  }

  const isAssignedAthlete = session.athlete_user_id === user.id;

  if (!isAssignedAthlete) {
    const { data: membership, error: membershipError } = await supabase
      .from("team_memberships")
      .select("role")
      .eq("team_id", session.team_id)
      .eq("user_id", user.id)
      .single();

    if (membershipError || !membership ||
        !["coach", "assistant_coach"].includes(membership.role)) {
      notFound();
    }
  }

  const { data: results, error: resultError } = await supabase
    .from("workout_results")
    .select("id")
    .eq("training_session_id", session.id)
    .limit(1);

  // Fail closed: an unreadable result must not offer another completion.
  const isCompleted = session.status === "completed" || Boolean(results?.length);

  const workout = getOne(session.workouts as Workout | Workout[] | null);
  const team = getOne(session.teams as Team | Team[] | null);

  const { data: steps, error: stepsError } = await supabase
    .from("workout_exercises")
    .select(`
      id,
      position,
      duration_seconds,
      rest_seconds,
      off_hand,
      notes,
      exercises (
        id,
        name
      )
    `)
    .eq("workout_id", session.workout_id)
    .order("position", { ascending: true });

  if (stepsError) {
    console.error(
      "Unable to load workout exercises:",
      stepsError.message
    );
  }

  const workoutSteps = (steps ?? []) as WorkoutStep[];

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-white">
      <div className="mx-auto max-w-4xl">
        <Link
          href={isAssignedAthlete ? "/" : `/teams/${session.team_id}/athletes/${session.athlete_user_id}`}
          className="text-sm font-medium text-emerald-400 hover:text-emerald-300"
        >
          ← {isAssignedAthlete ? "Back to dashboard" : "Back to athlete history"}
        </Link>

        <header className="mt-8 border-b border-slate-800 pb-8">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">
              Assigned Training
            </p>

            <span className="rounded-full bg-slate-800 px-3 py-1 text-xs font-medium capitalize text-slate-300">
              {session.status.replace("_", " ")}
            </span>
          </div>

          <h1 className="mt-4 text-4xl font-bold">
            {workout?.name ?? "Assigned Workout"}
          </h1>

          <p className="mt-3 text-slate-400">
            {team?.name ?? "Your team"} ·{" "}
            {formatDate(session.scheduled_date)}
          </p>

          {workout?.description && (
            <p className="mt-5 max-w-2xl text-slate-300">
              {workout.description}
            </p>
          )}
        </header>

        <section className="py-8">
          <div className="mb-5 flex items-end justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">
                Workout
              </p>

              <h2 className="mt-1 text-2xl font-semibold">
                Exercise sequence
              </h2>
            </div>

            <p className="text-sm text-slate-400">
              {workoutSteps.length}{" "}
              {workoutSteps.length === 1 ? "step" : "steps"}
            </p>
          </div>

          {workoutSteps.length === 0 ? (
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-slate-400">
              No exercises are available for this workout.
            </div>
          ) : (
            <div className="space-y-3">
              {workoutSteps.map((step, index) => {
                const exercise = getOne(step.exercises);

                return (
                  <div
                    key={step.id}
                    className="rounded-2xl border border-slate-800 bg-slate-900 p-5"
                  >
                    <div className="flex gap-4">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-500 font-bold text-slate-950">
                        {index + 1}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-col justify-between gap-3 sm:flex-row">
                          <div>
                            <h3 className="text-lg font-semibold">
                              {exercise?.name ?? "Exercise"}
                            </h3>

                            {step.off_hand && (
                              <p className="mt-1 text-sm font-medium text-emerald-400">
                                Off hand
                              </p>
                            )}
                          </div>

                          <div className="flex gap-5 text-sm">
                            <div>
                              <p className="text-slate-500">
                                Work
                              </p>
                              <p className="mt-1 font-medium">
                                {formatTime(step.duration_seconds)}
                              </p>
                            </div>

                            <div>
                              <p className="text-slate-500">
                                Rest
                              </p>
                              <p className="mt-1 font-medium">
                                {formatTime(step.rest_seconds)}
                              </p>
                            </div>
                          </div>
                        </div>

                        {step.notes && (
                          <p className="mt-3 text-sm text-slate-400">
                            {step.notes}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <div className="border-t border-slate-800 pt-8">
  {isCompleted ? (
    <div className="rounded-2xl border border-emerald-500/30 bg-slate-900 p-8">
      <h2 className="text-2xl font-semibold text-emerald-400">Workout completed</h2>
      <p className="mt-3 text-slate-300">This training session is complete.</p>
      {!isAssignedAthlete && <p className="mt-3 text-slate-400">Read-only coach view.</p>}
    </div>
  ) : !isAssignedAthlete ? (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8">
      <h2 className="text-2xl font-semibold">Read-only coach view</h2>
      <p className="mt-3 text-slate-300">Review the assigned exercise sequence above. Only the assigned athlete can complete this workout.</p>
    </div>
  ) : resultError ? (
    <p className="text-slate-300">Unable to verify workout completion. Please reload before starting.</p>
  ) : (
  <WorkoutPlayer
  workoutName={workout?.name ?? "Assigned Workout"}
  sessionId={session.id}
  steps={workoutSteps.map((step) => ({
      id: step.id,
      position: step.position,
      exerciseName:
        getOne(step.exercises)?.name ?? "Exercise",
      durationSeconds: step.duration_seconds ?? 0,
      restSeconds: step.rest_seconds ?? 0,
      offHand: step.off_hand,
      notes: step.notes,
    }))}
  />
  )}
</div>
      </div>
    </main>
  );
}