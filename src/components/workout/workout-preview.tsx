"use client";

import { useEffect, useRef, useState } from "react";
import type { WorkoutStep } from "@/lib/workout-session-state";
import ExerciseVideo, { safeVideoUrl } from "./exercise-video";

export default function WorkoutPreview({ steps }: { steps: WorkoutStep[] }) {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const demoTriggers = useRef(new Map<string, HTMLButtonElement>());
  const demoCloses = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterOpen = useRef<string | null>(null);
  const focusAfterClose = useRef<string | null>(null);

  useEffect(() => {
    const openedStepId = focusAfterOpen.current;
    if (openedStepId && selectedStepId === openedStepId) {
      demoCloses.current.get(openedStepId)?.focus();
      focusAfterOpen.current = null;
    }
    const stepId = focusAfterClose.current;
    if (stepId && selectedStepId === null) {
      demoTriggers.current.get(stepId)?.focus();
      focusAfterClose.current = null;
    }
  }, [selectedStepId]);

  function closeDemo(stepId: string) {
    focusAfterClose.current = stepId;
    setSelectedStepId(null);
  }
  function openDemo(stepId: string) {
    focusAfterOpen.current = stepId;
    setSelectedStepId(stepId);
  }

  return <section className="py-8">
    <div className="mb-5 flex items-end justify-between gap-4">
      <div><p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Workout</p><h2 className="mt-1 text-2xl font-semibold">Exercise sequence</h2></div>
      <p className="text-sm text-slate-400">{steps.length} {steps.length === 1 ? "step" : "steps"}</p>
    </div>
    {steps.length === 0 ? <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-slate-400">No exercises are available for this workout.</div> : <div className="space-y-3">
      {steps.map((step, index) => {
        const demoUrl = safeVideoUrl(step.videoUrl);
        const isOpen = selectedStepId === step.id;
        const panelId = `exercise-demo-${step.id}`;
        return <div key={step.id} className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <div className="flex gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-500 font-bold text-slate-950">{index + 1}</div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-col justify-between gap-3 sm:flex-row">
                <div><h3 className="text-lg font-semibold">{step.exerciseName}</h3>{step.offHand && <p className="mt-1 text-sm font-medium text-emerald-400">Off hand</p>}</div>
                <div className="flex gap-5 text-sm"><div><p className="text-slate-500">Work</p><p className="mt-1 font-medium">{formatTime(step.durationSeconds)}</p></div><div><p className="text-slate-500">Rest</p><p className="mt-1 font-medium">{formatTime(step.restSeconds)}</p></div></div>
              </div>
              {step.notes && <p className="mt-3 text-sm text-slate-400">{step.notes}</p>}
              {demoUrl && !isOpen && <button ref={(node) => { if (node) demoTriggers.current.set(step.id, node); else demoTriggers.current.delete(step.id); }} type="button" aria-label={`View demo for ${step.exerciseName}`} aria-expanded={false} aria-controls={panelId} onClick={() => openDemo(step.id)} className="mt-4 text-sm font-semibold text-emerald-400 hover:text-emerald-300">View demo</button>}
              {demoUrl && isOpen && <div id={panelId} role="region" aria-label={`Demo for ${step.exerciseName}`} className="mt-4 border-t border-slate-800 pt-4"><ExerciseVideo url={demoUrl} /><button ref={(node) => { if (node) demoCloses.current.set(step.id, node); else demoCloses.current.delete(step.id); }} type="button" aria-label={`Close demo for ${step.exerciseName}`} onClick={() => closeDemo(step.id)} className="mt-4 text-sm font-semibold text-emerald-400 hover:text-emerald-300">Close demo</button></div>}
            </div>
          </div>
        </div>;
      })}
    </div>}
  </section>;
}

function formatTime(seconds: number) {
  if (!seconds) return "—";
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0 ? `${minutes} min` : `${minutes}m ${remainingSeconds}s`;
}
