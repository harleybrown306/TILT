import type { WorkoutStep } from "./workout-session-state";

type SnapshotStepV1 = { workout_exercise_id: string; exercise_id: string; exercise_name: string; position: number; work_ms: number; rest_ms: number; off_hand: boolean; notes: string | null };
export type SessionPrescriptionRow = { workout_id: string; workout_name: string; schema_version: number; prescribed_work_ms: number; prescribed_rest_ms: number; prescribed_total_ms: number; step_count: number; steps: unknown };
function uuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
export function mapSessionPrescription(row: SessionPrescriptionRow, videoByStepId: ReadonlyMap<string,string|null>): { workoutName: string; steps: WorkoutStep[] } {
  if (row.schema_version !== 1 || !Array.isArray(row.steps) || row.steps.length !== row.step_count || !row.workout_name.trim()) throw new Error("Unsupported or invalid training prescription.");
  const steps = row.steps.map((value) => {
    const s = value as Partial<SnapshotStepV1>;
    if (!uuid(s.workout_exercise_id) || !uuid(s.exercise_id) || typeof s.exercise_name !== "string" || !s.exercise_name.trim() || !Number.isInteger(s.position) || s.position! < 0 || !Number.isInteger(s.work_ms) || s.work_ms! < 0 || !Number.isInteger(s.rest_ms) || s.rest_ms! < 0 || typeof s.off_hand !== "boolean" || !(s.notes === null || typeof s.notes === "string")) throw new Error("Unsupported or invalid training prescription.");
    return { id:s.workout_exercise_id, position:s.position!, exerciseName:s.exercise_name, durationSeconds:s.work_ms!/1000, restSeconds:s.rest_ms!/1000, offHand:s.off_hand, notes:s.notes, videoUrl:videoByStepId.get(s.workout_exercise_id) ?? null };
  });
  const work = steps.reduce((n,s)=>n+s.durationSeconds*1000,0), rest=steps.reduce((n,s)=>n+s.restSeconds*1000,0);
  if (work !== row.prescribed_work_ms || rest !== row.prescribed_rest_ms || work+rest !== row.prescribed_total_ms) throw new Error("Training prescription totals are invalid.");
  return { workoutName: row.workout_name, steps };
}
