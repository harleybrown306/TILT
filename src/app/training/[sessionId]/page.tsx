import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import WorkoutPlayer from "@/components/workout/workout-player";
import CompletedWorkoutDelivery from "@/components/workout/completed-workout-delivery";
import { mapSessionPrescription, type SessionPrescriptionRow } from "@/lib/training-session-prescription";

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
  video_url: string | null;
};

type WorkoutStep = {
  id: string;
  position: number;
  duration_seconds: number | null;
  rest_seconds: number | null;
  off_hand: boolean;
  notes: string | null;
  exercise_snapshot: { exercise_name?: string; video_url?: string };
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
      athlete_id,
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

  // Session RLS is the documented VIEW boundary. ACT remains a separate,
  // current-actor capability and must fail closed without hiding VIEW data.
  const { data: canAct, error: capabilityError } = await supabase.rpc(
    "can_act_for_training_session",
    { p_session_id: session.id }
  );
  const canActForTraining = !capabilityError && canAct === true && Boolean(session.athlete_id);

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
      exercise_snapshot,
      exercises (
        id,
        name,
        video_url
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

  const liveSteps = (steps ?? []) as WorkoutStep[];
  const { data: prescription, error: prescriptionError } = await supabase.from("training_session_prescriptions")
    .select("workout_id,workout_name,schema_version,prescribed_work_ms,prescribed_rest_ms,prescribed_total_ms,step_count,steps")
    .eq("session_id", session.id).single();
  let prescribed;
  try {
    const videos = new Map(liveSteps.map((step) => [step.id, getOne(step.exercises)?.video_url ?? null]));
    prescribed = prescriptionError || !prescription ? null : mapSessionPrescription(prescription as SessionPrescriptionRow, videos);
  } catch { prescribed = null; }
  const workoutSteps = prescribed?.steps ?? [];

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-white">
      <div className="mx-auto max-w-4xl">
        <Link
          href={canActForTraining ? "/" : session.athlete_user_id ? `/teams/${session.team_id}/athletes/${session.athlete_user_id}` : "/"}
          className="text-sm font-medium text-emerald-400 hover:text-emerald-300"
        >
          ← {canActForTraining ? "Back to dashboard" : session.athlete_user_id ? "Back to athlete history" : "Back to dashboard"}
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
            {prescribed?.workoutName ?? "Assigned Workout"}
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
                const exercise = step;

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
                              {exercise.exerciseName}
                            </h3>

                            {step.offHand && (
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
                                {formatTime(step.durationSeconds)}
                              </p>
                            </div>

                            <div>
                              <p className="text-slate-500">
                                Rest
                              </p>
                              <p className="mt-1 font-medium">
                                {formatTime(step.restSeconds)}
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
  {canActForTraining && session.athlete_id && isCompleted && !resultError && <CompletedWorkoutDelivery actorUserId={user.id} athleteId={session.athlete_id} sessionId={session.id} resultExists={Boolean(results?.length)} />}
  {isCompleted ? (
    <div className="rounded-2xl border border-emerald-500/30 bg-slate-900 p-8">
      <h2 className="text-2xl font-semibold text-emerald-400">Workout completed</h2>
      <p className="mt-3 text-slate-300">This training session is complete.</p>
      {!canActForTraining && <p className="mt-3 text-slate-400">Read-only workout view.</p>}
    </div>
  ) : !canActForTraining ? (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8">
      <h2 className="text-2xl font-semibold">Read-only workout view</h2>
      <p className="mt-3 text-slate-300">Review the assigned exercise sequence above. Training actions are available only to an authorized athlete or guardian.</p>
    </div>
  ) : resultError || !prescribed || !session.athlete_id ? (
    <p className="text-slate-300">Unable to load the durable workout prescription. Please reload before starting.</p>
  ) : (
  <WorkoutPlayer
  workoutName={prescribed?.workoutName ?? "Assigned Workout"}
  actorUserId={user.id}
  athleteId={session.athlete_id}
  workoutId={prescription?.workout_id ?? session.workout_id}
  sessionId={session.id}
  steps={workoutSteps}
  />
  )}
</div>
      </div>
    </main>
  );
}
