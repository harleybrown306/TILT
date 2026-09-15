import "server-only";
import { redirect } from "next/navigation";
import {
  trainingResumeSummary,
  type TrainingResumeSession,
  type TrainingResumeSummary,
} from "./training-resume";
import { localDate } from "./team-attendance";
import { createClient } from "./supabase/server";

type Related<T> = T | T[] | null;

type Result = {
  id: string;
  training_session_id: string;
  athlete_user_id: string;
};

type Prescription = {
  session_id: string;
  schema_version: number;
  prescribed_work_ms: number;
  step_count: number;
};

type Attempt = {
  workout_result_id: string | null;
  training_session_id: string;
  athlete_user_id: string;
  finalization_state: string;
  measurement_version: number;
  measurement_quality: string;
  prescribed_step_count: number;
  completed_work_blocks: number;
  skipped_work_blocks: number;
};

type SessionRow = {
  id: string;
  athlete_user_id: string;
  scheduled_date: string;
  workout_results: Related<Result>;
  training_session_prescriptions: Related<Prescription>;
  workout_session_attempts: Related<Attempt>;
};

const PAGE_SIZE = 1_000;

function one<T>(value: Related<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function mapSession(row: SessionRow): TrainingResumeSession {
  const result = one(row.workout_results);
  const prescription = one(row.training_session_prescriptions);
  const attempts = Array.isArray(row.workout_session_attempts)
    ? row.workout_session_attempts
    : row.workout_session_attempts
      ? [row.workout_session_attempts]
      : [];

  return {
    id: row.id,
    athleteUserId: row.athlete_user_id,
    scheduledDate: row.scheduled_date,
    result: result
      ? {
          id: result.id,
          trainingSessionId: result.training_session_id,
          athleteUserId: result.athlete_user_id,
        }
      : null,
    prescription: prescription
      ? {
          sessionId: prescription.session_id,
          schemaVersion: prescription.schema_version,
          prescribedWorkMs: prescription.prescribed_work_ms,
          stepCount: prescription.step_count,
        }
      : null,
    attempts: attempts.map((attempt) => ({
      workoutResultId: attempt.workout_result_id,
      trainingSessionId: attempt.training_session_id,
      athleteUserId: attempt.athlete_user_id,
      finalizationState: attempt.finalization_state,
      measurementVersion: attempt.measurement_version,
      measurementQuality: attempt.measurement_quality,
      prescribedStepCount: attempt.prescribed_step_count,
      completedWorkBlocks: attempt.completed_work_blocks,
      skippedWorkBlocks: attempt.skipped_work_blocks,
    })),
  };
}

export async function loadMyTrainingResume(): Promise<TrainingResumeSummary> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const rows: SessionRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("training_sessions")
      .select(
        "id,athlete_user_id,scheduled_date,workout_results(id,training_session_id,athlete_user_id),training_session_prescriptions(session_id,schema_version,prescribed_work_ms,step_count),workout_session_attempts(workout_result_id,training_session_id,athlete_user_id,finalization_state,measurement_version,measurement_quality,prescribed_step_count,completed_work_blocks,skipped_work_blocks)",
      )
      .eq("athlete_user_id", user.id)
      .order("scheduled_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error("Unable to load Training Resume history.");

    const page = (data ?? []) as SessionRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  return trainingResumeSummary(rows.map(mapSession), localDate(new Date()));
}
