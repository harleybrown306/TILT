import {
  calculateExerciseAdherence,
  type CanonicalWorkoutResult,
  type ExerciseAdherence,
  type ExerciseAdherenceAttempt,
  type ExerciseAdherenceInput,
  type ExerciseAdherencePrescription,
} from "./exercise-adherence";

export type AthleteAdherenceResultRow = {
  id: string;
  trainingSessionId: string;
  athleteUserId: string;
};

export type AthleteAdherenceAttemptRow = ExerciseAdherenceAttempt;
export type AthleteAdherencePrescriptionRow = ExerciseAdherencePrescription;

export type AthleteAdherenceSource = {
  sessionId: string;
  athleteUserId: string;
  result: AthleteAdherenceResultRow | null;
  attempts: readonly AthleteAdherenceAttemptRow[];
  prescription: AthleteAdherencePrescriptionRow | null;
};

export function athleteExerciseAdherenceInput(
  source: AthleteAdherenceSource,
): ExerciseAdherenceInput {
  const result: CanonicalWorkoutResult | null =
    source.result &&
    source.result.trainingSessionId === source.sessionId &&
    source.result.athleteUserId === source.athleteUserId
      ? source.result
      : null;

  const matchingAttempts = result
    ? source.attempts.filter((attempt) => attempt.workoutResultId === result.id)
    : [];

  return {
    result,
    attempt: matchingAttempts.length === 1 ? matchingAttempts[0] : null,
    prescription: source.prescription,
  };
}

export function athleteExerciseAdherence(
  source: AthleteAdherenceSource,
): ExerciseAdherence {
  return calculateExerciseAdherence(athleteExerciseAdherenceInput(source));
}
