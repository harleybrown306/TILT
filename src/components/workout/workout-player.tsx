"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { completeTrainingSession } from "@/lib/complete-training-session";
import { remainingMs, type WorkoutStep } from "@/lib/workout-session-state";
import { useWorkoutSession } from "./use-workout-session";
import ExerciseVideo, { safeVideoUrl } from "./exercise-video";
import { useWorkoutAudio } from "./use-workout-audio";

type WorkoutPlayerProps = {
  workoutName: string;
  sessionId: string;
  actorUserId: string;
  athleteId: string;
  workoutId: string;
  steps: WorkoutStep[];
};

function formatClock(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

export default function WorkoutPlayer({ workoutName, sessionId, actorUserId, athleteId, workoutId, steps: prescribedSteps }: WorkoutPlayerProps) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const audio = useWorkoutAudio();
  const input = useMemo(() => ({ workoutName, sessionId, actorUserId, athleteId, workoutId, steps: prescribedSteps }), [workoutName, sessionId, actorUserId, athleteId, workoutId, prescribedSteps]);
  const { checkpoint, ready, warning, run, flush, finalizeAttempt } = useWorkoutSession(input, { onStateTransition: audio.handleTransition });
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [pendingReview, setPendingReview] = useState<{ phase: "work" | "rest"; index: number; stepId: string } | null>(null);
  const [openReview, setOpenReview] = useState<{ stepId: string; name: string; url: string } | null>(null);
  const savingRef = useRef(false);
  const reviewRequestClaim = useRef(false);
  const steps = checkpoint?.steps ?? prescribedSteps;
  const phase = checkpoint?.phase ?? "ready";
  const currentStepIndex = checkpoint?.index ?? 0;
  const currentStep = steps[currentStepIndex];
  const isPaused = checkpoint?.pausedAt != null;
  const timeRemaining = checkpoint ? Math.ceil(remainingMs(checkpoint, checkpoint.logicalNow) / 1000) : 0;
  const nextVideoUrl = safeVideoUrl(steps[currentStepIndex + 1]?.videoUrl);
  const expected = { index: currentStepIndex, phase, paused: isPaused };
  const reviewIndex = phase === "work" ? currentStepIndex : phase === "rest" ? currentStepIndex + 1 : -1;
  const reviewStep = reviewIndex >= 0 ? steps[reviewIndex] : undefined;
  const reviewUrl = safeVideoUrl(reviewStep?.videoUrl);
  const storageWarning = warning ? <p role="status" className="mb-4 text-sm text-amber-300">{warning}</p> : null;
  function startWorkout() { audio.unlock(); void run("begin"); }
  function skipPhase() { void run("skip", expected); }
  function requestReview() {
    if (!reviewStep || !reviewUrl || reviewRequestClaim.current || pendingReview || openReview || (phase !== "work" && phase !== "rest")) return;
    const request = { phase, index: currentStepIndex, stepId: reviewStep.id } as const;
    if (isPaused) { setOpenReview({ stepId: reviewStep.id, name: reviewStep.exerciseName, url: reviewUrl }); return; }
    reviewRequestClaim.current = true; setPendingReview(request);
    void run("pause", expected).catch(() => {
      reviewRequestClaim.current = false;
      setPendingReview((current) => current === request ? null : current);
    });
  }
  useEffect(() => {
    if (!pendingReview || !checkpoint) return;
    queueMicrotask(() => {
      if (checkpoint.phase !== pendingReview.phase || checkpoint.index !== pendingReview.index) { reviewRequestClaim.current = false; setPendingReview(null); return; }
      if (checkpoint.pausedAt === null) return;
      const targetIndex = checkpoint.phase === "work" ? checkpoint.index : checkpoint.index + 1;
      const target = checkpoint.steps[targetIndex]; const url = safeVideoUrl(target?.videoUrl);
      if (!target || target.id !== pendingReview.stepId || !url) { reviewRequestClaim.current = false; setPendingReview(null); return; }
      setOpenReview({ stepId: target.id, name: target.exerciseName, url }); reviewRequestClaim.current = false; setPendingReview(null);
    });
  }, [checkpoint, pendingReview]);
  useEffect(() => {
    if (!openReview || !checkpoint || checkpoint.phase === "finished") { if (openReview && checkpoint?.phase === "finished") queueMicrotask(() => setOpenReview(null)); return; }
    const targetIndex = checkpoint.phase === "work" ? checkpoint.index : checkpoint.phase === "rest" ? checkpoint.index + 1 : -1;
    if (targetIndex < 0 || checkpoint.steps[targetIndex]?.id !== openReview.stepId) queueMicrotask(() => setOpenReview(null));
  }, [checkpoint, openReview]);

  async function finishWorkout() {
    if (savingRef.current || !checkpoint || checkpoint.finalized) return;
    savingRef.current = true; setIsSaving(true); setSaveError("");
    try {
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError || !user || user.id !== actorUserId) throw new Error("Unable to verify your signed-in account.");
      await completeTrainingSession(supabase, sessionId);
      // Result is committed first. Telemetry/recovery failure cannot undo it.
      await run("finalize").catch(() => {});
      await Promise.race([finalizeAttempt().catch(() => {}), new Promise<void>((resolve) => window.setTimeout(resolve, 2000))]);
      void flush(); router.push(`/training/${sessionId}`); router.refresh();
    } catch (error) { setSaveError(error instanceof Error ? error.message : "Unable to save workout. Retry safely."); }
    finally { savingRef.current = false; setIsSaving(false); }
  }

  if (!ready) return <p className="text-slate-400">Loading workout recovery...</p>;
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
        {storageWarning}
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
          disabled={isSaving || Boolean(checkpoint?.finalized)}
          className="mt-8 w-full rounded-xl bg-emerald-500 px-6 py-4 font-bold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {checkpoint?.finalized ? "Workout saved" : isSaving ? "Saving workout..." : "Finish workout"}
        </button>
      </div>
    );
  }

  if (phase === "ready") {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center">
        {storageWarning}
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
        {storageWarning}
        <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">
          {phase === "work" ? "Work" : "Rest"}
        </p>

        <p className="text-sm text-slate-400">
          Exercise {currentStepIndex + 1} of {steps.length}
        </p>
      </div>

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          aria-pressed={audio.soundEnabled}
          aria-label={audio.soundEnabled ? "Turn workout sound off" : "Turn workout sound on"}
          onClick={() => audio.setEnabled(!audio.soundEnabled)}
          className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold transition hover:bg-slate-800"
        >
          Sound: {audio.soundEnabled ? "On" : "Off"}
        </button>
      </div>

      {openReview ? (
        <section className="mt-6 rounded-xl border border-slate-700 p-4" aria-label={`Demo for ${openReview.name}`}>
          <p className="font-semibold">Review demo: {openReview.name}</p>
          <ExerciseVideo url={openReview.url} />
          <button type="button" onClick={() => setOpenReview(null)} className="mt-4 rounded-lg border border-slate-700 px-4 py-2 font-semibold">Close demo</button>
        </section>
      ) : (
        <div className="mt-4 flex justify-end">
          {reviewStep && reviewUrl && <button type="button" onClick={requestReview} disabled={Boolean(pendingReview)} aria-label={`Review demo for ${reviewStep.exerciseName}`} className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold transition hover:bg-slate-800 disabled:opacity-60">Review demo</button>}
        </div>
      )}

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

        {phase === "rest" && nextVideoUrl && <video aria-hidden="true" className="hidden" muted playsInline preload="metadata" src={nextVideoUrl} />}
        {phase === "work" && <ExerciseVideo key={currentStep.id} url={safeVideoUrl(currentStep.videoUrl)} />}

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
          onClick={() => void run(isPaused ? "resume" : "pause", expected)}
          disabled={Boolean(openReview)}
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
