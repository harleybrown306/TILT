"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type WorkoutStep = {
  id: string;
  position: number;
  exerciseName: string;
  durationSeconds: number;
  restSeconds: number;
  offHand: boolean;
  notes: string | null;
};

type WorkoutPlayerProps = {
  workoutName: string;
  sessionId: string;
  steps: WorkoutStep[];
};

type Phase = "ready" | "work" | "rest" | "finished";

function formatClock(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

export default function WorkoutPlayer({
  workoutName,
  sessionId,
  steps,
}: WorkoutPlayerProps) {
  const router = useRouter();
  const supabase = createClient();

  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("ready");
  const [isPaused, setIsPaused] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const startedAtRef = useRef<Date | null>(null);
  const savingRef = useRef(false);

  const currentStep = steps[currentStepIndex];

  const [timeRemaining, setTimeRemaining] = useState(
    currentStep?.durationSeconds ?? 0
  );

  const activeSeconds = steps.reduce(
    (total, step) => total + step.durationSeconds,
    0
  );

  const totalSeconds = steps.reduce(
    (total, step) =>
      total + step.durationSeconds + step.restSeconds,
    0
  );

  const moveToNextStep = useCallback(() => {
    const nextIndex = currentStepIndex + 1;

    if (nextIndex >= steps.length) {
      setPhase("finished");
      setTimeRemaining(0);
      setIsPaused(false);
      return;
    }

    setCurrentStepIndex(nextIndex);
    setPhase("work");
    setTimeRemaining(steps[nextIndex].durationSeconds);
    setIsPaused(false);
  }, [currentStepIndex, steps]);

  useEffect(() => {
    if (phase === "ready" || phase === "finished" || isPaused || !currentStep) {
      return;
    }

    const timer = window.setTimeout(() => {
      if (timeRemaining > 0) {
        setTimeRemaining((previous) => Math.max(previous - 1, 0));
      } else if (phase === "work" && currentStep.restSeconds > 0) {
        setPhase("rest");
        setTimeRemaining(currentStep.restSeconds);
      } else {
        moveToNextStep();
      }
    }, timeRemaining > 0 ? 1000 : 0);

    return () => window.clearTimeout(timer);
  }, [phase, isPaused, timeRemaining, currentStep, moveToNextStep]);

  function startWorkout() {
    if (!currentStep) return;

    startedAtRef.current = new Date();

    setCurrentStepIndex(0);
    setPhase("work");
    setIsPaused(false);
    setSaveError("");
    setTimeRemaining(steps[0].durationSeconds);
  }

  function skipPhase() {
    if (phase === "work") {
      if (currentStep.restSeconds > 0) {
        setPhase("rest");
        setTimeRemaining(currentStep.restSeconds);
      } else {
        moveToNextStep();
      }

      return;
    }

    if (phase === "rest") {
      moveToNextStep();
    }
  }

  async function finishWorkout() {
    if (savingRef.current) return;
    savingRef.current = true;
    setIsSaving(true);
    setSaveError("");

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      setSaveError("Unable to verify your login.");
      savingRef.current = false;
      setIsSaving(false);
      return;
    }

    const { data: session, error: sessionError } = await supabase
      .from("training_sessions")
      .select("athlete_user_id, status")
      .eq("id", sessionId)
      .single();
    const { data: results, error: resultError } = await supabase
      .from("workout_results")
      .select("id")
      .eq("training_session_id", sessionId)
      .limit(1);

    if (sessionError || !session || session.athlete_user_id !== user.id || resultError) {
      setSaveError("Unable to verify permission to complete this workout.");
      savingRef.current = false;
      setIsSaving(false);
      return;
    }

    if (session.status === "completed" || results?.length) {
      router.push(`/training/${sessionId}`);
      router.refresh();
      return;
    }

    const startedAt =
      startedAtRef.current?.toISOString() ??
      new Date().toISOString();

    const activeMinutes = Math.ceil(activeSeconds / 60);
    const totalDurationMinutes = Math.ceil(totalSeconds / 60);

    const { error } = await supabase
      .from("workout_results")
      .insert({
        training_session_id: sessionId,
        athlete_user_id: user.id,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        active_minutes: activeMinutes,
        total_duration_minutes: totalDurationMinutes,
        exercises_completed: steps.length,
        result_data: {
          workout_name: workoutName,
          completed_steps: steps.length,
        },
      });

    if (error) {
      setSaveError(error.message);
      savingRef.current = false;
      setIsSaving(false);
      return;
    }

    router.push("/");
    router.refresh();
  }

  if (steps.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center text-slate-400">
        This workout does not contain any exercises.
      </div>
    );
  }

  if (phase === "finished") {
    return (
      <div className="rounded-2xl border border-emerald-500/30 bg-slate-900 p-8 text-center">
        <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">
          Workout complete
        </p>

        <h2 className="mt-3 text-3xl font-bold">
          Nice work.
        </h2>

        <p className="mt-3 text-slate-400">
          You completed {workoutName}.
        </p>

        {saveError && (
          <div className="mt-5 rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-300">
            {saveError}
          </div>
        )}

        <button
          type="button"
          onClick={finishWorkout}
          disabled={isSaving}
          className="mt-8 w-full rounded-xl bg-emerald-500 px-6 py-4 font-bold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSaving ? "Saving workout..." : "Finish workout"}
        </button>
      </div>
    );
  }

  if (phase === "ready") {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center">
        <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">
          Ready
        </p>

        <h2 className="mt-3 text-3xl font-bold">
          {workoutName}
        </h2>

        <p className="mt-3 text-slate-400">
          {steps.length} {steps.length === 1 ? "exercise" : "exercises"} ready.
        </p>

        <button
          type="button"
          onClick={startWorkout}
          className="mt-8 w-full rounded-xl bg-emerald-500 px-6 py-4 text-lg font-bold text-slate-950 transition hover:bg-emerald-400"
        >
          Begin workout
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">
          {phase === "work" ? "Work" : "Rest"}
        </p>

        <p className="text-sm text-slate-400">
          Exercise {currentStepIndex + 1} of {steps.length}
        </p>
      </div>

      <div className="py-10 text-center">
        <h2 className="text-3xl font-bold">
          {phase === "rest"
            ? "Rest"
            : currentStep.exerciseName}
        </h2>

        {phase === "work" && currentStep.offHand && (
          <p className="mt-2 font-semibold text-emerald-400">
            Off hand
          </p>
        )}

        {phase === "work" && currentStep.notes && (
          <p className="mx-auto mt-4 max-w-xl text-slate-400">
            {currentStep.notes}
          </p>
        )}

        {phase === "rest" && (
          <p className="mt-3 text-slate-400">
            Next:{" "}
            {currentStepIndex + 1 < steps.length
              ? steps[currentStepIndex + 1].exerciseName
              : "Finish workout"}
          </p>
        )}

        <div className="mt-10 text-7xl font-bold tabular-nums sm:text-8xl">
          {formatClock(timeRemaining)}
        </div>

        {isPaused && (
          <p className="mt-4 font-semibold text-amber-400">
            Paused
          </p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => setIsPaused((previous) => !previous)}
          className="rounded-xl border border-slate-700 px-6 py-4 font-semibold transition hover:bg-slate-800"
        >
          {isPaused ? "Resume" : "Pause"}
        </button>

        <button
          type="button"
          onClick={skipPhase}
          className="rounded-xl bg-emerald-500 px-6 py-4 font-bold text-slate-950 transition hover:bg-emerald-400"
        >
          {phase === "rest" ? "Skip rest" : "Next"}
        </button>
      </div>
    </div>
  );
}