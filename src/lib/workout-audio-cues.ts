import { remainingMs, type Checkpoint, type Command } from "./workout-session-state";
import type { WorkoutSessionEvent } from "./workout-session-events";

export type WorkoutAudioCueKind = "work_start" | "ten_seconds" | "rest_start" | "workout_complete";

export type WorkoutAudioCue = {
  kind: WorkoutAudioCueKind;
  key: string;
};

export type WorkoutVoicePromptKind = "upcoming_exercise";

export type WorkoutVoicePrompt = {
  kind: WorkoutVoicePromptKind;
  key: string;
  text: string;
};

export type WorkoutAudioTransition = {
  before: Checkpoint | null;
  after: Checkpoint;
  command: Command | "begin";
  events: readonly WorkoutSessionEvent[];
  foreground: boolean;
  recovery: boolean;
};

function hasEvent(events: readonly WorkoutSessionEvent[], eventType: WorkoutSessionEvent["event_type"]) {
  return events.some((event) => event.event_type === eventType);
}

function cue(kind: WorkoutAudioCueKind, checkpoint: Checkpoint): WorkoutAudioCue {
  return {
    kind,
    // phaseStartedAt is rewritten only when the state machine enters a new
    // phase, making this stable across renders and ordinary ticks.
    key: `${checkpoint.attemptId}:${checkpoint.phaseStartedAt}:${kind}`,
  };
}

const MINIMUM_UPCOMING_EXERCISE_REST_MS = 4_000;
// Exercise names are free-form content. This keeps a malformed or unusually
// long frozen label from turning a short rest into stale guidance.
export const MAX_SPOKEN_EXERCISE_NAME_LENGTH = 80;

export function normalizeSpokenExerciseName(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > MAX_SPOKEN_EXERCISE_NAME_LENGTH || /[\p{C}]/u.test(normalized)) return null;
  return normalized;
}

function voicePrompt(checkpoint: Checkpoint, text: string): WorkoutVoicePrompt {
  return {
    kind: "upcoming_exercise",
    // Unlike a beep, this represents the next exercise announced during this
    // exact rest phase. It is separately claimable and never persisted.
    key: `${checkpoint.attemptId}:${checkpoint.phaseStartedAt}:upcoming_exercise_voice`,
    text,
  };
}

// This deliberately plans from state-machine transitions, never from render
// timing, telemetry delivery, or audio playback. Recovery is always silent.
export function planWorkoutAudioCues(transition: WorkoutAudioTransition): WorkoutAudioCue[] {
  const { before, after, command, events, foreground, recovery } = transition;
  if (!foreground || recovery || after.pausedAt !== null) return [];

  const cues: WorkoutAudioCue[] = [];
  const startedWork = after.phase === "work" && hasEvent(events, "exercise_started");
  const enteredRest = before?.phase === "work" && after.phase === "rest"
    && hasEvent(events, "rest_started");
  const finishedWorkout = after.phase === "finished" && (
    (before?.phase === "work" && (hasEvent(events, "exercise_completed") || hasEvent(events, "exercise_skipped")))
    || (before?.phase === "rest" && (hasEvent(events, "rest_completed") || hasEvent(events, "rest_skipped")))
  );

  if (startedWork) cues.push(cue("work_start", after));
  if (enteredRest) cues.push(cue("rest_start", after));
  if (finishedWorkout) cues.push(cue("workout_complete", after));

  // Only a foreground timer tick may cross this threshold. A pause, resume,
  // visibility event, skip, or recovered snapshot is never a cue trigger.
  if (command === "tick" && before?.phase === "work" && after.phase === "work"
      && before.index === after.index && before.phaseStartedAt === after.phaseStartedAt
      && before.pausedAt === null && remainingMs(before, before.logicalNow) > 10_000
      && remainingMs(after, after.logicalNow) <= 10_000) {
    cues.push(cue("ten_seconds", after));
  }
  return cues;
}

// Voice is deliberately a pure, best-effort presentation plan. The state
// machine remains the only workout clock and recovery is always silent.
export function planWorkoutVoicePrompts(transition: WorkoutAudioTransition): WorkoutVoicePrompt[] {
  const { before, after, events, foreground, recovery } = transition;
  if (!foreground || recovery || after.pausedAt !== null || after.phase !== "rest") return [];
  if (before?.phase !== "work" || !hasEvent(events, "rest_started")) return [];
  if (after.phaseDurationMs < MINIMUM_UPCOMING_EXERCISE_REST_MS) return [];

  const next = after.steps[after.index + 1];
  const exerciseName = normalizeSpokenExerciseName(next?.exerciseName);
  if (!exerciseName) return [];
  return [voicePrompt(after, `Next up, ${exerciseName}. Ready.`)];
}

// Claim every planned cue before optional playback. This keeps mute/unmute
// presentation-only: enabling sound later cannot replay a historical cue.
export function claimWorkoutAudioCues(cues: readonly WorkoutAudioCue[], emitted: Set<string>) {
  return cues.filter((audioCue) => {
    if (emitted.has(audioCue.key)) return false;
    emitted.add(audioCue.key);
    return true;
  });
}

export function claimWorkoutVoicePrompts(prompts: readonly WorkoutVoicePrompt[], emitted: Set<string>) {
  return prompts.filter((prompt) => {
    if (emitted.has(prompt.key)) return false;
    emitted.add(prompt.key);
    return true;
  });
}
