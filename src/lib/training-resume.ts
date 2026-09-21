import {
  aggregateExerciseAdherence,
  type ExerciseAdherenceAggregate,
  type ExerciseAdherenceAttempt,
  type ExerciseAdherenceInput,
} from "./exercise-adherence";
import { shiftDate } from "./team-attendance";

export type TrainingResumeResult = {
  id: string;
  trainingSessionId: string;
  athleteId: string;
};

export type TrainingResumePrescription = {
  sessionId: string;
  schemaVersion: number;
  prescribedWorkMs: number;
  stepCount: number;
};

export type TrainingResumeSession = {
  id: string;
  athleteId: string;
  scheduledDate: string;
  result: TrainingResumeResult | null;
  prescription: TrainingResumePrescription | null;
  attempts: readonly ExerciseAdherenceAttempt[];
};

export type ResumeHistoryRecord = {
  period: string;
  completedWorkouts: number;
  trainingDays: number;
  prescribedWorkMs: number;
  prescribedTimeCoveredWorkoutCount: number;
  prescribedTimeUncoveredWorkoutCount: number;
};

export type TrainingResumeSummary = {
  overview: {
    completedWorkouts: number;
    trainingDays: number;
    firstTrainingDate: string | null;
    latestTrainingDate: string | null;
  };
  prescribedTrainingTime: {
    prescribedWorkMs: number;
    coveredWorkoutCount: number;
    uncoveredWorkoutCount: number;
    totalCompletedWorkoutCount: number;
    coverageRatio: number | null;
  };
  streaks: {
    current: number;
    longest: number;
  };
  exerciseAdherence: ExerciseAdherenceAggregate;
  history: {
    monthly: ResumeHistoryRecord[];
    yearly: ResumeHistoryRecord[];
  };
};

type CompletedSession = {
  session: TrainingResumeSession;
  prescription: TrainingResumePrescription | null;
  adherenceInput: ExerciseAdherenceInput;
};

function canonicalResult(session: TrainingResumeSession): TrainingResumeResult | null {
  const result = session.result;
  if (
    !result ||
    result.trainingSessionId !== session.id ||
    result.athleteId !== session.athleteId
  ) {
    return null;
  }

  return result;
}

function immutablePrescription(
  session: TrainingResumeSession,
): TrainingResumePrescription | null {
  const prescription = session.prescription;
  if (
    !prescription ||
    prescription.sessionId !== session.id ||
    prescription.schemaVersion !== 1 ||
    !Number.isInteger(prescription.prescribedWorkMs) ||
    prescription.prescribedWorkMs < 0 ||
    !Number.isInteger(prescription.stepCount) ||
    prescription.stepCount <= 0
  ) {
    return null;
  }

  return prescription;
}

function completedSessions(sessions: readonly TrainingResumeSession[]): CompletedSession[] {
  return sessions.flatMap((session) => {
    const result = canonicalResult(session);
    if (!result) return [];

    const prescription = immutablePrescription(session);
    const matchingAttempts = session.attempts.filter(
      (attempt) => attempt.workoutResultId === result.id,
    );

    return [{
      session,
      prescription,
      adherenceInput: {
        result,
        attempt: matchingAttempts.length === 1 ? matchingAttempts[0] : null,
        prescription: prescription
          ? {
              sessionId: prescription.sessionId,
              schemaVersion: prescription.schemaVersion,
              stepCount: prescription.stepCount,
            }
          : null,
      },
    }];
  });
}

function history(
  sessions: readonly CompletedSession[],
  periodFor: (date: string) => string,
): ResumeHistoryRecord[] {
  const records = new Map<string, {
    completedWorkouts: number;
    dates: Set<string>;
    prescribedWorkMs: number;
    covered: number;
    uncovered: number;
  }>();

  for (const completed of sessions) {
    const period = periodFor(completed.session.scheduledDate);
    const record = records.get(period) ?? {
      completedWorkouts: 0,
      dates: new Set<string>(),
      prescribedWorkMs: 0,
      covered: 0,
      uncovered: 0,
    };
    record.completedWorkouts += 1;
    record.dates.add(completed.session.scheduledDate);
    if (completed.prescription) {
      record.prescribedWorkMs += completed.prescription.prescribedWorkMs;
      record.covered += 1;
    } else {
      record.uncovered += 1;
    }
    records.set(period, record);
  }

  return [...records.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([period, record]) => ({
      period,
      completedWorkouts: record.completedWorkouts,
      trainingDays: record.dates.size,
      prescribedWorkMs: record.prescribedWorkMs,
      prescribedTimeCoveredWorkoutCount: record.covered,
      prescribedTimeUncoveredWorkoutCount: record.uncovered,
    }));
}

function streaks(trainingDates: readonly string[], today: string) {
  const dates = [...new Set(trainingDates)].sort();
  const dateSet = new Set(dates);
  let current = 0;
  let date = dateSet.has(today) ? today : shiftDate(today, -1);
  while (dateSet.has(date)) {
    current += 1;
    date = shiftDate(date, -1);
  }

  let longest = 0;
  let run = 0;
  let previous: string | null = null;
  for (const date of dates) {
    run = previous !== null && date === shiftDate(previous, 1) ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = date;
  }

  return { current, longest };
}

export function trainingResumeSummary(
  sessions: readonly TrainingResumeSession[],
  today: string,
): TrainingResumeSummary {
  const completed = completedSessions(sessions);
  const dates = completed.map((entry) => entry.session.scheduledDate);
  const covered = completed.filter((entry) => entry.prescription);
  const prescribedWorkMs = covered.reduce(
    (total, entry) => total + entry.prescription!.prescribedWorkMs,
    0,
  );
  const completedDates = [...new Set(dates)].sort();
  const coveredWorkoutCount = covered.length;
  const completedWorkoutCount = completed.length;

  return {
    overview: {
      completedWorkouts: completedWorkoutCount,
      trainingDays: completedDates.length,
      firstTrainingDate: completedDates[0] ?? null,
      latestTrainingDate: completedDates.at(-1) ?? null,
    },
    prescribedTrainingTime: {
      prescribedWorkMs,
      coveredWorkoutCount,
      uncoveredWorkoutCount: completedWorkoutCount - coveredWorkoutCount,
      totalCompletedWorkoutCount: completedWorkoutCount,
      coverageRatio: completedWorkoutCount
        ? coveredWorkoutCount / completedWorkoutCount
        : null,
    },
    streaks: streaks(completedDates, today),
    exerciseAdherence: aggregateExerciseAdherence(
      completed.map((entry) => entry.adherenceInput),
    ),
    history: {
      monthly: history(completed, (date) => date.slice(0, 7)),
      yearly: history(completed, (date) => date.slice(0, 4)),
    },
  };
}
