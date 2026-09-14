import { createClient } from "@/lib/supabase/server";
import {
  EventPayloadError, MAX_EVENT_BODY_BYTES, parseEventBatch, sameEvent,
  type WorkoutSessionEvent,
} from "@/lib/workout-session-events";

type Acknowledgement = {
  id: string;
  status: "accepted" | "duplicate" | "conflict" | "rejected" | "retry";
};
function reply(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function readPayload(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_EVENT_BODY_BYTES)) {
    throw new EventPayloadError(413);
  }
  if (!request.body) throw new EventPayloadError(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_EVENT_BODY_BYTES) {
        await reader.cancel();
        throw new EventPayloadError(413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new EventPayloadError(400); }
}

export async function POST(request: Request) {
  // Do not trust forwarded-host headers or accept cross-origin cookie writes.
  if (request.headers.get("origin") !== new URL(request.url).origin ||
      (request.headers.has("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin")) {
    return reply({ error: "Same-origin request required." }, 403);
  }
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return reply({ error: "JSON required." }, 415);
  }
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return reply({ error: "Authentication required." }, 401);
    const events = parseEventBatch(await readPayload(request));
    const sessionIds = [...new Set(events.map((event) => event.session_id))];
    const { data: sessions, error: sessionError } = await supabase.from("training_sessions")
      .select("id").in("id", sessionIds).eq("athlete_user_id", user.id);
    if (sessionError) return reply({ error: "Unable to verify sessions. Retry safely." }, 503);
    if (!sessions || sessionIds.some((id) => !sessions.some((session) => session.id === id))) {
      return reply({ error: "Session unavailable for athlete telemetry." }, 403);
    }

    async function insertEvent(event: WorkoutSessionEvent): Promise<Acknowledgement> {
      try {
        // Individual inserts allow partial acknowledgements without one invalid
        // event discarding the rest. RLS remains the final write authority.
        const { error } = await supabase.from("workout_session_events").insert(event);
        if (!error) return { id: event.id, status: "accepted" };
        if (error.code === "23505") {
          const { data, error: readError } = await supabase.from("workout_session_events")
            .select("id,session_id,attempt_id,sequence,event_type,workout_exercise_id,step_position,phase,phase_duration_ms,phase_elapsed_ms,elapsed_ms,occurred_at")
            .or(`id.eq.${event.id},and(session_id.eq.${event.session_id},attempt_id.eq.${event.attempt_id},sequence.eq.${event.sequence})`)
            .limit(2);
          if (readError) return { id: event.id, status: "retry" };
          return { id: event.id, status: data?.length === 1 && sameEvent(data[0], event) ? "duplicate" : "conflict" };
        }
        return { id: event.id, status: ["42501", "23514", "23503", "22003"].includes(error.code) ? "rejected" : "retry" };
      } catch { return { id: event.id, status: "retry" }; }
    }
    const acknowledgements: Acknowledgement[] = [];
    // Bound database concurrency, including duplicate lookup requests.
    for (let index = 0; index < events.length; index += 4) {
      acknowledgements.push(...await Promise.all(events.slice(index, index + 4).map(insertEvent)));
    }
    return reply({ acknowledgements });
  } catch (error) {
    return error instanceof EventPayloadError
      ? reply({ error: error.message }, error.status)
      : reply({ error: "Telemetry unavailable. Retry safely." }, 503);
  }
}
