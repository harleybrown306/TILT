import { aggregateExerciseAdherence } from "./exercise-adherence";
import {
  attendanceStatus,
  shiftDate,
  type AttendanceSession,
} from "./team-attendance";

export type CoachAttentionSignalKind =
  | "recent_missed_training"
  | "completion_consistency"
  | "exercise_adherence_change";

export type CoachAttentionSignal = {
  id: string;
  kind: CoachAttentionSignalKind;
  athleteId: string;
  athleteName: string;
  signalDate: string;
  affectedSessionCount: number;
  absolutePercentagePointChange: number;
  text: string;
};

export type CoachAttentionSignalInput = {
  sessions: readonly AttendanceSession[];
  today: string;
};

const CLOSED_WINDOW_DAYS = 7;
const MINIMUM_ADHERENCE_SESSIONS = 2;
const MINIMUM_CONSISTENCY_EXPECTED_SESSIONS = 2;

// First-completion and return facts require a separate, explicitly complete,
// authorized athlete-wide canonical-completion history ordered by Chicago-local
// completedAt. The team-scoped attendance snapshot is intentionally insufficient.

function closedWindow(today: string, offset = 0) {
  const end = shiftDate(today, -1 - offset * CLOSED_WINDOW_DAYS);
  return {
    start: shiftDate(end, 1 - CLOSED_WINDOW_DAYS),
    end,
  };
}

function isInWindow(date: string, window: { start: string; end: string }) {
  return date >= window.start && date <= window.end;
}

function pastOrTodaySessions(sessions: readonly AttendanceSession[], today: string) {
  // One canonical training session may appear more than once in an assembled
  // snapshot. Keeping the first stable row prevents duplicate factual signals.
  const seen = new Set<string>();
  return sessions.filter((session) => {
    if (session.scheduledDate > today || seen.has(session.id)) return false;
    seen.add(session.id);
    return true;
  });
}

function completed(session: AttendanceSession) {
  // `completedAt` is loaded from workout_results, the canonical completion
  // record. A session status or an attempt alone never establishes completion.
  return Boolean(session.completedAt);
}

function signal(
  kind: CoachAttentionSignalKind,
  athleteId: string,
  athleteName: string,
  signalDate: string,
  affectedSessionCount: number,
  absolutePercentagePointChange: number,
  text: string,
): CoachAttentionSignal {
  return {
    id: `${kind}:${athleteId}:${signalDate}`,
    kind,
    athleteId,
    athleteName,
    signalDate,
    affectedSessionCount,
    absolutePercentagePointChange,
    text,
  };
}

export function deriveCoachAttentionSignals({ sessions, today }: CoachAttentionSignalInput) {
  const rows = pastOrTodaySessions(sessions, today);
  const athleteIds = [...new Set(rows.map((session) => session.athleteId))].sort();
  const recent = closedWindow(today);
  const previous = closedWindow(today, 1);
  const signals: CoachAttentionSignal[] = [];

  for (const athleteId of athleteIds) {
    const athleteSessions = rows.filter((session) => session.athleteId === athleteId);
    const athleteName = athleteSessions[0]?.athleteName ?? "Former athlete";
    const recentSessions = athleteSessions.filter((session) => isInWindow(session.scheduledDate, recent));
    const expectedRecent = recentSessions.filter((session) => attendanceStatus(session, today) !== "cancelled");
    const completedRecent = expectedRecent.filter((session) => completed(session));
    const missedRecent = expectedRecent.filter((session) => !completed(session));

    if (missedRecent.length) {
      signals.push(signal(
        "recent_missed_training", athleteId, athleteName, recent.end, missedRecent.length, 0,
        `${missedRecent.length} assigned ${missedRecent.length === 1 ? "session was" : "sessions were"} not completed in the last 7 closed days.`,
      ));
    }

    if (
      expectedRecent.length >= MINIMUM_CONSISTENCY_EXPECTED_SESSIONS &&
      completedRecent.length === expectedRecent.length
    ) {
      signals.push(signal(
        "completion_consistency", athleteId, athleteName, recent.end, expectedRecent.length, 0,
        `Completed ${completedRecent.length} of ${expectedRecent.length} expected sessions in the last 7 closed days.`,
      ));
    }

    const adherenceFor = (window: { start: string; end: string }) => aggregateExerciseAdherence(
      athleteSessions
        .filter((session) => isInWindow(session.scheduledDate, window) && completed(session))
        .map((session) => session.exerciseAdherenceInput!)
        .filter(Boolean),
    );
    const currentAdherence = adherenceFor(recent);
    const previousAdherence = adherenceFor(previous);
    if (
      currentAdherence.available &&
      previousAdherence.available &&
      currentAdherence.eligibleSessionCount >= MINIMUM_ADHERENCE_SESSIONS &&
      previousAdherence.eligibleSessionCount >= MINIMUM_ADHERENCE_SESSIONS
    ) {
      const change = currentAdherence.percentage - previousAdherence.percentage;
      if (change !== 0) {
        signals.push(signal(
          "exercise_adherence_change", athleteId, athleteName, recent.end,
          currentAdherence.eligibleSessionCount + previousAdherence.eligibleSessionCount,
          Math.abs(change),
          `Exercise adherence changed from ${Math.round(previousAdherence.percentage)}% to ${Math.round(currentAdherence.percentage)}% across the two most recent closed 7-day periods.`,
        ));
      }
    }

  }

  return signals.sort((a, b) =>
    b.signalDate.localeCompare(a.signalDate) ||
    b.affectedSessionCount - a.affectedSessionCount ||
    b.absolutePercentagePointChange - a.absolutePercentagePointChange ||
    a.athleteId.localeCompare(b.athleteId) ||
    a.id.localeCompare(b.id),
  );
}
