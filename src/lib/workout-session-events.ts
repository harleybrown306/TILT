export const MAX_EVENT_BATCH = 25;
export const MAX_EVENT_BODY_BYTES = 64 * 1024;
const MAX_ELAPSED_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PHASE_MS = 24 * 60 * 60 * 1000;

export const EVENT_TYPES = [
  "workout_started", "exercise_started", "exercise_completed", "exercise_skipped",
  "rest_started", "rest_completed", "rest_skipped", "timer_paused", "timer_resumed",
  "page_hidden", "page_visible", "workout_completed",
] as const;
type EventType = typeof EVENT_TYPES[number];
type Phase = "ready" | "work" | "rest" | "finished";
export type WorkoutSessionEvent = {
  id: string;
  session_id: string;
  attempt_id: string;
  sequence: number;
  event_type: EventType;
  workout_exercise_id: string | null;
  step_position: number | null;
  phase: Phase;
  phase_duration_ms: number | null;
  phase_elapsed_ms: number | null;
  elapsed_ms: number;
  occurred_at: string;
};

export class EventPayloadError extends Error {
  constructor(public status: number) { super("Invalid workout event payload."); }
}

const required = ["id", "session_id", "attempt_id", "sequence", "event_type", "phase", "elapsed_ms", "occurred_at"];
const optional = ["workout_exercise_id", "step_position", "phase_duration_ms", "phase_elapsed_ms"];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function uuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}
function integer(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
function invalid(): never { throw new EventPayloadError(400); }

export function parseEventBatch(payload: unknown): WorkoutSessionEvent[] {
  if (!record(payload) || Object.keys(payload).length !== 1 || !Array.isArray(payload.events)) invalid();
  if (payload.events.length > MAX_EVENT_BATCH) throw new EventPayloadError(413);
  if (payload.events.length === 0) invalid();
  return payload.events.map((value: unknown) => {
    if (!record(value) || required.some((key) => !(key in value)) ||
        Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) invalid();
    if (!uuid(value.id) || !uuid(value.session_id) || !uuid(value.attempt_id) ||
        !integer(value.sequence, 2147483647) || !integer(value.elapsed_ms, MAX_ELAPSED_MS) ||
        !EVENT_TYPES.includes(value.event_type as EventType) ||
        !["ready", "work", "rest", "finished"].includes(value.phase as string)) invalid();
    if (typeof value.occurred_at !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.occurred_at) ||
        !Number.isFinite(Date.parse(value.occurred_at)) ||
        new Date(value.occurred_at).toISOString() !== value.occurred_at) invalid();
    const step = value.workout_exercise_id ?? null;
    const position = value.step_position ?? null;
    const duration = value.phase_duration_ms ?? null;
    const elapsed = value.phase_elapsed_ms ?? null;
    if ((step === null) !== (position === null) ||
        (step !== null && !uuid(step)) ||
        (position !== null && !integer(position, 2147483647)) ||
        (duration !== null && !integer(duration, MAX_PHASE_MS)) ||
        (elapsed !== null && !integer(elapsed, MAX_PHASE_MS))) invalid();
    if ((value.phase === "work" || value.phase === "rest") &&
        (step === null || duration === null || elapsed === null || Number(elapsed) > Number(duration))) invalid();
    if (String(value.event_type).startsWith("exercise_") && value.phase !== "work") invalid();
    if (String(value.event_type).startsWith("rest_") && value.phase !== "rest") invalid();
    if (value.event_type === "workout_started" && value.phase !== "ready") invalid();
    if (value.event_type === "workout_completed" && value.phase !== "finished") invalid();
    if (["timer_paused", "timer_resumed"].includes(String(value.event_type)) &&
        !["work", "rest"].includes(String(value.phase))) invalid();
    return {
      id: value.id.toLowerCase(), session_id: value.session_id.toLowerCase(),
      attempt_id: value.attempt_id.toLowerCase(), sequence: value.sequence,
      event_type: value.event_type as EventType, phase: value.phase as Phase,
      workout_exercise_id: typeof step === "string" ? step.toLowerCase() : null,
      step_position: position as number | null, phase_duration_ms: duration as number | null,
      phase_elapsed_ms: elapsed as number | null, elapsed_ms: value.elapsed_ms,
      occurred_at: value.occurred_at,
    };
  });
}

// Compare only accepted client fields; receipt timestamps never come from clients.
export function sameEvent(stored: Record<string, unknown>, incoming: WorkoutSessionEvent): boolean {
  return Object.entries(incoming).every(([key, value]) =>
    key === "occurred_at"
      ? typeof stored[key] === "string" && Date.parse(stored[key] as string) === Date.parse(value as string)
      : stored[key] === value);
}
