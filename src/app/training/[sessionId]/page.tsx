import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import WorkoutPlayer from "@/components/workout/workout-player";
import CompletedWorkoutDelivery from "@/components/workout/completed-workout-delivery";
import WorkoutFeedback from "@/components/workout/workout-feedback";
import WorkoutPreview from "@/components/workout/workout-preview";
import ChallengeSelection from "@/components/workout/challenge-selection";
import { mapSessionPrescription, type SessionPrescriptionRow } from "@/lib/training-session-prescription";
import { loadFamiliarExerciseIds } from "@/lib/athlete-exercise-familiarity-server";
import { loadMyFamilyAthleteContexts } from "@/lib/my-athlete-contexts-server";
import { createOperationalReference, logOperationalFailure } from "@/lib/operational-log";

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

type Athlete = {
  display_name: string;
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
      completed_at,
      workout_id,
      team_id,
      athlete_id,
      athlete_user_id,
      athletes (
        display_name
      ),
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
  const isCompleted = session.status === "completed" || Boolean(session.completed_at) || Boolean(results?.length);

  const workout = getOne(session.workouts as Workout | Workout[] | null);
  const team = getOne(session.teams as Team | Team[] | null);
  const athlete = getOne(session.athletes as Athlete | Athlete[] | null);
  const dashboardHref = session.athlete_id
    ? `/?athlete=${encodeURIComponent(session.athlete_id)}`
    : "/";
  const backHref = canActForTraining
    ? dashboardHref
    : session.athlete_user_id
      ? `/teams/${session.team_id}/athletes/${session.athlete_user_id}`
      : dashboardHref;

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
    logOperationalFailure({
      reference: createOperationalReference(),
      surface: "training_session_load",
      code: "training_session_exercises_load_failed",
    });
  }

  const liveSteps = (steps ?? []) as WorkoutStep[];
  const videos = new Map(liveSteps.map((step) => [step.id, getOne(step.exercises)?.video_url ?? null]));
  const [
    { data: selectedVariant },
    { data: challengeOption, error: challengeOptionError },
    { data: attempts },
    { data: events },
    familyContexts,
  ] = await Promise.all([
    supabase.from("training_session_performed_variants").select("selected_variant").eq("session_id", session.id).single(),
    supabase.from("training_session_challenge_prescriptions")
      .select("source_workout_id,workout_name,schema_version,prescribed_work_ms,prescribed_rest_ms,prescribed_total_ms,step_count,steps")
      .eq("session_id", session.id)
      .single(),
    supabase.from("workout_session_attempts").select("id").eq("training_session_id", session.id).limit(1),
    supabase.from("workout_session_events").select("id").eq("session_id", session.id).limit(1),
    loadMyFamilyAthleteContexts(),
  ]);
  const selectedChallenge = selectedVariant?.selected_variant === "challenge";
  const canSelectChallenge = Boolean(session.athlete_id && familyContexts.some((context) => context.athleteId === session.athlete_id && context.relationshipRole === "self"));
  const selectionLocked = isCompleted || Boolean(attempts?.length) || Boolean(events?.length);
  let challengeAvailable = false;
  try {
    if (!challengeOptionError && challengeOption) {
      const challenge = challengeOption as unknown as { source_workout_id: string } & SessionPrescriptionRow;
      mapSessionPrescription({ ...challenge, workout_id: challenge.source_workout_id }, videos);
      challengeAvailable = true;
    }
  } catch {
    challengeAvailable = false;
  }
  const { data: prescription, error: prescriptionError } = await supabase.from(selectedChallenge ? "training_session_challenge_prescriptions" : "training_session_prescriptions")
    .select(selectedChallenge
      ? "source_workout_id,workout_name,schema_version,prescribed_work_ms,prescribed_rest_ms,prescribed_total_ms,step_count,steps"
      : "workout_id,workout_name,schema_version,prescribed_work_ms,prescribed_rest_ms,prescribed_total_ms,step_count,steps")
    .eq("session_id", session.id).single();
  let prescribed;
  const performedWorkoutId = selectedChallenge
    ? (prescription as unknown as { source_workout_id?: string } | null)?.source_workout_id
    : (prescription as { workout_id?: string } | null)?.workout_id;
  try {
    prescribed = prescriptionError || !prescription ? null : mapSessionPrescription((selectedChallenge
      ? { ...(prescription as unknown as { source_workout_id: string }), workout_id: (prescription as unknown as { source_workout_id: string }).source_workout_id }
      : prescription) as SessionPrescriptionRow, videos);
  } catch { prescribed = null; }
  const workoutSteps = prescribed?.steps ?? [];
  const familiarExerciseIds = session.athlete_id && prescribed
    ? await loadFamiliarExerciseIds(supabase as never, session.athlete_id, workoutSteps.map((step) => step.exerciseId))
    : null;

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-white">
      <div className="mx-auto max-w-4xl">
        <Link
          href={backHref}
          className="text-sm font-medium text-emerald-400 hover:text-emerald-300"
        >
          ← {canActForTraining ? "Back to dashboard" : session.athlete_user_id ? "Back to athlete history" : "Back to dashboard"}
        </Link>

        <header className="mt-8 border-b border-slate-800 pb-8">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">
              {selectedChallenge ? "Challenge Training" : "Assigned Training"}
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

          {athlete?.display_name && (
            <p className="mt-2 text-sm font-medium text-slate-300">
              Training for {athlete.display_name}
            </p>
          )}

          {!selectedChallenge && workout?.description && (
            <p className="mt-5 max-w-2xl text-slate-300">
              {workout.description}
            </p>
          )}
        </header>

        <ChallengeSelection
          sessionId={session.id}
          challengeAvailable={challengeAvailable}
          canSelectChallenge={canSelectChallenge}
          selectionLocked={selectionLocked}
          selectedVariant={selectedChallenge ? "challenge" : "assigned"}
        />

        <WorkoutPreview steps={workoutSteps} familiarExerciseIds={familiarExerciseIds} />

        <div className="border-t border-slate-800 pt-8">
  {canActForTraining && session.athlete_id && isCompleted && !resultError && <CompletedWorkoutDelivery actorUserId={user.id} athleteId={session.athlete_id} sessionId={session.id} resultExists={Boolean(results?.length)} />}
  {isCompleted ? (
    <div className="rounded-2xl border border-emerald-500/30 bg-slate-900 p-8">
      <h2 className="text-2xl font-semibold text-emerald-400">Workout completed</h2>
      <p className="mt-3 text-slate-300">This training session is complete.</p>
      {!canActForTraining && <p className="mt-3 text-slate-400">Read-only workout view.</p>}
      {results?.[0]?.id && <WorkoutFeedback resultId={results[0].id} />}
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
  workoutId={performedWorkoutId ?? session.workout_id}
  sessionId={session.id}
  steps={workoutSteps}
  familiarExerciseIds={familiarExerciseIds}
  />
  )}
</div>
      </div>
    </main>
  );
}
