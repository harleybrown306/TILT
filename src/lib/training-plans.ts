export type PlanStatus = "draft" | "active" | "archived";
export type Plan = {
  id: string;
  team_id: string | null;
  owner_user_id: string;
  name: string;
  description: string | null;
  status: PlanStatus;
  created_at: string;
  updated_at: string;
};
export type PlanItem = {
  id: string;
  training_plan_id: string;
  workout_id: string;
  day_offset: number;
  position: number;
  scheduled_time: string | null;
  notes: string | null;
  updated_at: string;
};
export type PlanWorkout = {
  id: string;
  name: string;
  description: string | null;
  difficulty: string;
  visibility: "private" | "team" | "public";
  owner_user_id: string | null;
  team_id: string | null;
  requires_entitlement: string | null;
};
export type PlanActionState = { status: "idle" | "error" | "success"; message: string };

const MAX_INTEGER = 2147483647;
export function dayNumberToOffset(day: number) {
  if (!Number.isInteger(day) || day < 1 || day > MAX_INTEGER) throw new Error("Enter a valid day number starting at Day 1.");
  return day - 1;
}
export function offsetToDayNumber(offset: number) {
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_INTEGER) throw new Error("Invalid workout day.");
  return offset + 1;
}
export function isDraft(status: PlanStatus) { return status === "draft"; }
export function sortPlanItems<T extends Pick<PlanItem, "day_offset" | "position" | "id">>(items: T[]) {
  return [...items].sort((a, b) => a.day_offset - b.day_offset || a.position - b.position || a.id.localeCompare(b.id));
}
export function scheduleVersion(items: Pick<PlanItem, "id" | "updated_at">[]) {
  return JSON.stringify([...items].sort((a, b) => a.id.localeCompare(b.id)).map((item) => [item.id, item.updated_at]));
}
export function readInteger(value: FormDataEntryValue | null, label: string, minimum: number) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`Enter a valid ${label}.`);
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > MAX_INTEGER) throw new Error(`Enter a valid ${label}.`);
  return number;
}
export function readText(data: FormData, name: string, required = false) {
  const value = data.get(name);
  if (value !== null && typeof value !== "string") throw new Error("Invalid text field.");
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw new Error("A plan name is required.");
  return text || null;
}
export function readSchedule(data: FormData) {
  const time = readText(data, "scheduledTime");
  if (time && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(time)) throw new Error("Enter a valid scheduled time.");
  return {
    day_offset: dayNumberToOffset(readInteger(data.get("dayNumber"), "day number", 1)),
    position: readInteger(data.get("orderNumber"), "order number", 1) - 1,
    scheduled_time: time,
    notes: readText(data, "notes"),
  };
}
export function isWorkoutUsable(workout: PlanWorkout, teamId: string, userId: string, enabledFeatures: Set<string>) {
  const relevant = workout.visibility === "public" || workout.owner_user_id === userId || (workout.visibility === "team" && workout.team_id === teamId);
  return relevant && (!workout.requires_entitlement || enabledFeatures.has(workout.requires_entitlement));
}
