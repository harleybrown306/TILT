import { remainingMs, type Checkpoint, type Command } from "./workout-session-state";
import type { WorkoutSessionEvent } from "./workout-session-events";

export type WorkoutAudioCueKind = "work_start" | "ten_seconds" | "rest_start" | "workout_complete";

export type WorkoutAudioCue = {
  kind: WorkoutAudioCueKind;
  key: string;
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

// Claim every planned cue before optional playback. This keeps mute/unmute
// presentation-only: enabling sound later cannot replay a historical cue.
export function claimWorkoutAudioCues(cues: readonly WorkoutAudioCue[], emitted: Set<string>) {
  return cues.filter((audioCue) => {
    if (emitted.has(audioCue.key)) return false;
    emitted.add(audioCue.key);
    return true;
  });
}
