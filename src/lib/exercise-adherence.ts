export type CanonicalWorkoutResult = {
  id: string;
  trainingSessionId: string;
  athleteUserId: string;
};

export type ExerciseAdherenceAttempt = {
  workoutResultId: string | null;
  trainingSessionId: string;
  athleteUserId: string;
  finalizationState: string;
  measurementVersion: number;
  measurementQuality: string;
  prescribedStepCount: number;
  completedWorkBlocks: number;
  skippedWorkBlocks: number;
  completedRestBlocks?: number;
  skippedRestBlocks?: number;
};

export type ExerciseAdherencePrescription = {
  sessionId: string;
  schemaVersion: number;
  stepCount: number;
};

export type ExerciseAdherenceInput = {
  result: CanonicalWorkoutResult | null;
  attempt: ExerciseAdherenceAttempt | null;
  prescription: ExerciseAdherencePrescription | null;
};

export type AvailableExerciseAdherence = {
  available: true;
  completedBlocks: number;
  prescribedBlocks: number;
  skippedBlocks: number;
  ratio: number;
  percentage: number;
};

export type UnavailableExerciseAdherence = {
  available: false;
  completedBlocks: null;
  prescribedBlocks: null;
  skippedBlocks: null;
  ratio: null;
  percentage: null;
};

export type ExerciseAdherence =
  | AvailableExerciseAdherence
  | UnavailableExerciseAdherence;

type ExerciseAdherenceAggregateBase = {
  completedBlocks: number;
  prescribedBlocks: number;
  skippedBlocks: number;
  eligibleSessionCount: number;
  unavailableSessionCount: number;
};

export type ExerciseAdherenceAggregate =
  | (ExerciseAdherenceAggregateBase & {
      available: true;
      ratio: number;
      percentage: number;
    })
  | (ExerciseAdherenceAggregateBase & {
      available: false;
      ratio: null;
      percentage: null;
    });

const unavailable: UnavailableExerciseAdherence = {
  available: false,
  completedBlocks: null,
  prescribedBlocks: null,
  skippedBlocks: null,
  ratio: null,
  percentage: null,
};

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

export function calculateExerciseAdherence(
  input: ExerciseAdherenceInput,
): ExerciseAdherence {
  const { result, attempt, prescription } = input;

  if (!result || !attempt || !prescription) {
    return unavailable;
  }

  if (
    attempt.workoutResultId !== result.id ||
    attempt.trainingSessionId !== result.trainingSessionId ||
    attempt.athleteUserId !== result.athleteUserId ||
    prescription.sessionId !== result.trainingSessionId ||
    attempt.finalizationState !== "finalized_completed" ||
    attempt.measurementVersion !== 1 ||
    attempt.measurementQuality !== "complete" ||
    prescription.schemaVersion !== 1
  ) {
    return unavailable;
  }

  const prescribedBlocks = prescription.stepCount;
  const completedBlocks = attempt.completedWorkBlocks;
  const skippedBlocks = attempt.skippedWorkBlocks;

  if (
    !isNonNegativeInteger(prescribedBlocks) ||
    prescribedBlocks === 0 ||
    !isNonNegativeInteger(completedBlocks) ||
    !isNonNegativeInteger(skippedBlocks) ||
    !isNonNegativeInteger(attempt.prescribedStepCount) ||
    attempt.prescribedStepCount !== prescribedBlocks ||
    completedBlocks + skippedBlocks !== prescribedBlocks
  ) {
    return unavailable;
  }

  const ratio = completedBlocks / prescribedBlocks;

  return {
    available: true,
    completedBlocks,
    prescribedBlocks,
    skippedBlocks,
    ratio,
    percentage: ratio * 100,
  };
}

export function aggregateExerciseAdherence(
  inputs: readonly ExerciseAdherenceInput[],
): ExerciseAdherenceAggregate {
  let completedBlocks = 0;
  let prescribedBlocks = 0;
  let skippedBlocks = 0;
  let eligibleSessionCount = 0;
  let unavailableSessionCount = 0;

  for (const input of inputs) {
    const adherence = calculateExerciseAdherence(input);

    if (!adherence.available) {
      unavailableSessionCount += 1;
      continue;
    }

    completedBlocks += adherence.completedBlocks;
    prescribedBlocks += adherence.prescribedBlocks;
    skippedBlocks += adherence.skippedBlocks;
    eligibleSessionCount += 1;
  }

  if (prescribedBlocks === 0) {
    return {
      available: false,
      completedBlocks,
      prescribedBlocks,
      skippedBlocks,
      eligibleSessionCount,
      unavailableSessionCount,
      ratio: null,
      percentage: null,
    };
  }

  const ratio = completedBlocks / prescribedBlocks;

  return {
    available: true,
    completedBlocks,
    prescribedBlocks,
    skippedBlocks,
    eligibleSessionCount,
    unavailableSessionCount,
    ratio,
    percentage: ratio * 100,
  };
}
