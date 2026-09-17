import type { WorkoutSessionEvent } from "./workout-session-events";

export type WorkoutStep = {
  id: string; position: number; exerciseName: string; durationSeconds: number;
  restSeconds: number; offHand: boolean; notes: string | null; videoUrl: string | null;
};
export type Checkpoint = {
  version: 1; athleteId: string; sessionId: string; workoutId: string; workoutName: string;
  attemptId: string; startedAt: number; steps: WorkoutStep[]; index: number;
  phase: "ready" | "work" | "rest" | "finished"; phaseStartedAt: number;
  phaseDurationMs: number; pausedAt: number | null; phasePauseMs: number;
  totalPauseMs: number; sequence: number; logicalNow: number; savedWallAt: number;
  finalized: boolean; workProgressMs: number; skippedSteps: number; inferredTransitions: number;
};
export type Change = { checkpoint: Checkpoint; events: WorkoutSessionEvent[] };
export const MAX_RECOVERY_GAP_MS = 24 * 60 * 60 * 1000;
export function recoveryNow(cp: Checkpoint, wall: number) {
  const gap = wall - cp.savedWallAt;
  // Wall jumps >24h or backwards cannot be distinguished safely from absence.
  return cp.logicalNow + (gap >= 0 && gap <= MAX_RECOVERY_GAP_MS ? gap : 0);
}
export function phaseElapsed(cp: Checkpoint, now: number) {
  return Math.min(cp.phaseDurationMs, Math.max(0, (cp.pausedAt ?? now) - cp.phaseStartedAt - cp.phasePauseMs));
}
export function remainingMs(cp: Checkpoint, now: number) { return cp.phaseDurationMs - phaseElapsed(cp, now); }
function emit(cp: Checkpoint, type: WorkoutSessionEvent["event_type"], now: number, events: WorkoutSessionEvent[], uuid: () => string) {
  const step = cp.steps[cp.index];
  const timed = cp.phase === "work" || cp.phase === "rest";
  events.push({ id: uuid(), session_id: cp.sessionId, attempt_id: cp.attemptId,
    sequence: ++cp.sequence, event_type: type, phase: cp.phase,
    workout_exercise_id: timed ? step.id : null, step_position: timed ? step.position : null,
    phase_duration_ms: timed ? cp.phaseDurationMs : null,
    phase_elapsed_ms: timed ? Math.round(phaseElapsed(cp, now)) : null,
    elapsed_ms: Math.min(30 * MAX_RECOVERY_GAP_MS, Math.max(0, Math.round(now - cp.startedAt))),
    occurred_at: new Date(now).toISOString() });
}
export function beginAttempt(input: { athleteId: string; sessionId: string; workoutId: string; workoutName: string; steps: WorkoutStep[] }, now: number, uuid: () => string): Change {
  if (!input.steps.length || input.steps.length > 200) throw new Error("Workout must have 1–200 steps.");
  if (input.steps.some((s) => !Number.isFinite(s.durationSeconds) || !Number.isFinite(s.restSeconds) || s.durationSeconds < 0 || s.restSeconds < 0 || s.durationSeconds > 86400 || s.restSeconds > 86400)) throw new Error("Invalid workout durations.");
  const cp: Checkpoint = { ...input, steps: input.steps.map((s) => ({ ...s })), version: 1,
    attemptId: uuid(), startedAt: now, index: 0, phase: "ready", phaseStartedAt: now,
    phaseDurationMs: 0, pausedAt: null, phasePauseMs: 0, totalPauseMs: 0, sequence: -1,
    logicalNow: now, savedWallAt: now, finalized: false, workProgressMs: 0, skippedSteps: 0, inferredTransitions: 0 };
  const events: WorkoutSessionEvent[] = [];
  emit(cp, "workout_started", now, events, uuid);
  cp.phase = "work"; cp.phaseDurationMs = cp.steps[0].durationSeconds * 1000;
  emit(cp, "exercise_started", now, events, uuid);
  return { checkpoint: cp, events };
}
function advance(cp: Checkpoint, at: number) {
  if (cp.phase === "work" && cp.steps[cp.index].restSeconds > 0) {
    cp.phase = "rest"; cp.phaseDurationMs = cp.steps[cp.index].restSeconds * 1000;
  } else if (cp.index + 1 < cp.steps.length) {
    cp.index++; cp.phase = "work"; cp.phaseDurationMs = cp.steps[cp.index].durationSeconds * 1000;
  } else { cp.phase = "finished"; cp.phaseDurationMs = 0; }
  cp.phaseStartedAt = at; cp.phasePauseMs = 0; cp.pausedAt = null;
}
function startEvent(cp: Checkpoint, at: number, events: WorkoutSessionEvent[], uuid: () => string) {
  if (cp.phase === "work") emit(cp, "exercise_started", at, events, uuid);
  if (cp.phase === "rest") emit(cp, "rest_started", at, events, uuid);
}
export type Command = "tick" | "recover" | "skip" | "pause" | "resume" | "hidden" | "visible" | "finalize";
export function changeAttempt(original: Checkpoint, command: Command, time: number, uuid: () => string, observed = true): Change {
  const cp = { ...original }; const events: WorkoutSessionEvent[] = [];
  const now = Math.max(cp.logicalNow, time); cp.logicalNow = now;
  if (cp.finalized) return { checkpoint: cp, events };
  const expired: { cp: Checkpoint; at: number }[] = [];
  while (cp.pausedAt === null && (cp.phase === "work" || cp.phase === "rest") && remainingMs(cp, now) === 0) {
    const at = cp.phaseStartedAt + cp.phaseDurationMs + cp.phasePauseMs;
    expired.push({ cp: { ...cp }, at });
    if (cp.phase === "work") cp.workProgressMs += cp.phaseDurationMs;
    advance(cp, at);
  }
  // Only one timely foreground expiration is observed. Suspended/recovered
  // transitions update guidance/stats but emit no misleading completion events.
  if (expired.length === 1 && command !== "recover" && observed && now - expired[0].at <= 1500) {
    emit(expired[0].cp, expired[0].cp.phase === "work" ? "exercise_completed" : "rest_completed", expired[0].at, events, uuid);
    cp.sequence = expired[0].cp.sequence; startEvent(cp, expired[0].at, events, uuid);
  } else cp.inferredTransitions += expired.length;
  if (command === "finalize") {
    cp.phase = "finished"; cp.phaseDurationMs = 0; cp.pausedAt = null;
    emit(cp, "workout_completed", now, events, uuid); cp.finalized = true;
  } else if (cp.phase === "work" || cp.phase === "rest") {
    if (command === "pause" && cp.pausedAt === null) {
      emit(cp, "timer_paused", now, events, uuid); cp.pausedAt = now;
    } else if (command === "resume" && cp.pausedAt !== null) {
      const pause = Math.max(0, now - cp.pausedAt); cp.phasePauseMs += pause; cp.totalPauseMs += pause; cp.pausedAt = null;
      emit(cp, "timer_resumed", now, events, uuid);
    } else if (command === "skip" && expired.length === 0) {
      emit(cp, cp.phase === "work" ? "exercise_skipped" : "rest_skipped", now, events, uuid);
      if (cp.phase === "work") { cp.workProgressMs += phaseElapsed(cp, now); cp.skippedSteps++; }
      if (cp.pausedAt !== null) cp.totalPauseMs += Math.max(0, now - cp.pausedAt);
      advance(cp, now); startEvent(cp, now, events, uuid);
    }
  }
  // Finished guidance is still an unfinished attempt until the result is saved.
  // Once timed guidance has reached its finished state, visibility is no
  // longer attributable to a prescribed work/rest phase. Emitting it would
  // create an invalid Measurement V1 event before canonical completion.
  if ((command === "hidden" || command === "visible") && !cp.finalized && (cp.phase === "work" || cp.phase === "rest")) {
    emit(cp, command === "hidden" ? "page_hidden" : "page_visible", now, events, uuid);
  }
  return { checkpoint: cp, events };
}
export function attemptMetrics(cp: Checkpoint, now: number) {
  return {
    prescribedMs: cp.steps.reduce((sum, s) => sum + (s.durationSeconds + s.restSeconds) * 1000, 0),
    elapsedMs: Math.max(0, now - cp.startedAt),
    explicitPauseMs: cp.totalPauseMs + (cp.pausedAt === null ? 0 : Math.max(0, now - cp.pausedAt)),
    workProgressMs: cp.workProgressMs + (cp.phase === "work" ? phaseElapsed(cp, now) : 0),
    skippedSteps: cp.skippedSteps, inferredTransitions: cp.inferredTransitions,
  };
}
