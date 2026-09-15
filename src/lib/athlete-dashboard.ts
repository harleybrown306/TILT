import { localDate, shiftDate } from "./team-attendance";
import type { ExerciseAdherence, ExerciseAdherenceInput } from "./exercise-adherence";

export type AthleteDashboardSession = {
  id: string;
  teamId: string;
  teamName: string;
  scheduledDate: string;
  status: string;
  workoutName: string;
  completedAt: string | null;
  prescribedWorkMs: number | null;
  prescribedTotalMs: number | null;
  exerciseAdherence?: ExerciseAdherence;
  exerciseAdherenceInput?: ExerciseAdherenceInput;
};

export function isCompleted(session: AthleteDashboardSession) {
  return session.status === "completed" || Boolean(session.completedAt);
}

function completedOnOrBefore(
  session: AthleteDashboardSession,
  today: string
) {
  return isCompleted(session) && session.scheduledDate <= today;
}

export function completedPrescribedWorkMs(
  sessions: AthleteDashboardSession[],
  predicate: (session: AthleteDashboardSession) => boolean
) {
  return sessions.reduce(
    (total, session) =>
      predicate(session) && session.prescribedWorkMs !== null
        ? total + session.prescribedWorkMs
        : total,
    0
  );
}

export function displayMinutes(milliseconds: number) {
  return Math.round(milliseconds / 60_000);
}

export function athleteDashboardMetrics(
  sessions: AthleteDashboardSession[],
  today: string
) {
  const weekStart = shiftDate(today, -6);
  const monthStart = `${today.slice(0, 7)}-01`;
  const completed = sessions.filter((session) => completedOnOrBefore(session, today));
  const trainingDays = new Set(completed.map((session) => session.scheduledDate));
  const weeklyWorkMs = completedPrescribedWorkMs(
    sessions,
    (session) =>
      completedOnOrBefore(session, today) &&
      session.scheduledDate >= weekStart
  );
  const monthlyWorkMs = completedPrescribedWorkMs(
    sessions,
    (session) =>
      completedOnOrBefore(session, today) &&
      session.scheduledDate >= monthStart
  );

  let streak = 0;
  let date = trainingDays.has(today) ? today : shiftDate(today, -1);
  while (trainingDays.has(date)) {
    streak += 1;
    date = shiftDate(date, -1);
  }

  return {
    weeklyWorkMs,
    monthlyWorkMs,
    totalCompletedWorkouts: completed.length,
    trainingDays: trainingDays.size,
    currentStreak: streak,
  };
}

export function activityBuckets(
  sessions: AthleteDashboardSession[],
  today: string,
  days = 7
) {
  const dates = Array.from({ length: days }, (_, index) =>
    shiftDate(today, index + 1 - days)
  );
  const workByDate = new Map(dates.map((date) => [date, 0]));

  for (const session of sessions) {
    if (
      completedOnOrBefore(session, today) &&
      session.prescribedWorkMs !== null &&
      workByDate.has(session.scheduledDate)
    ) {
      workByDate.set(
        session.scheduledDate,
        (workByDate.get(session.scheduledDate) ?? 0) + session.prescribedWorkMs
      );
    }
  }

  return dates.map((date) => ({
    date,
    workMs: workByDate.get(date) ?? 0,
  }));
}

export function completionDateLabel(completedAt: string | null) {
  return completedAt ? localDate(new Date(completedAt)) : null;
}
