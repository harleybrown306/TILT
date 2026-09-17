import { type Checkpoint, type Change } from "./workout-session-state";
import { MAX_EVENT_BATCH, MAX_EVENT_BODY_BYTES, type WorkoutSessionEvent } from "./workout-session-events";
export type QueuedEvent = { event: WorkoutSessionEvent; status: "pending" | "conflict" | "rejected" };
export type Bundle = { athleteId: string; checkpoints: Record<string, Checkpoint>; outbox: QueuedEvent[]; dropped: number };
export const MAX_OUTBOX = 2500;
const empty = (athleteId: string): Bundle => ({ athleteId, checkpoints: {}, outbox: [], dropped: 0 });
let database: Promise<IDBDatabase> | undefined;
function db() {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("tilt-workout-session-v1", 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("users")) request.result.createObjectStore("users", { keyPath: "userId" });
      if (!request.result.objectStoreNames.contains("athletes")) request.result.createObjectStore("athletes", { keyPath: "athleteId" });
    };
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = undefined; }; resolve(request.result); };
  });
  return database;
}
type LegacyBundle = { userId?: unknown; checkpoints?: unknown; outbox?: unknown; dropped?: unknown };
export function migrateLegacyBundle(athleteId: string, legacy: LegacyBundle | undefined): Bundle | undefined {
  // The v1 key is an authenticated user ID. It is safely attributable only for
  // established same-UUID athletes; no parent-keyed record is ever attached to a child.
  if (!legacy || legacy.userId !== athleteId || !legacy.checkpoints || !Array.isArray(legacy.outbox) || !Number.isInteger(legacy.dropped)) return;
  const checkpoints = legacy.checkpoints as Record<string, Checkpoint & { userId?: unknown }>;
  if (Object.values(checkpoints).some((checkpoint) => !checkpoint || checkpoint.userId !== athleteId)) return;
  return {
    athleteId,
    checkpoints: Object.fromEntries(Object.entries(checkpoints).map(([sessionId, checkpoint]) => {
      const rest = { ...checkpoint };
      delete rest.userId;
      return [sessionId, { ...rest, athleteId }];
    })) as Record<string, Checkpoint>,
    outbox: legacy.outbox as QueuedEvent[],
    dropped: legacy.dropped as number,
  };
}
export async function mutateBundle(athleteId: string, mutate: (bundle: Bundle) => void): Promise<Bundle> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["athletes", "users"], "readwrite");
    const store = transaction.objectStore("athletes"); const legacyStore = transaction.objectStore("users"); let bundle: Bundle;
    const get = store.get(athleteId);
    get.onsuccess = () => {
      try {
        if (get.result) {
          bundle = get.result;
          if (bundle.athleteId !== athleteId) throw new Error("Workout storage identity mismatch.");
          mutate(bundle); store.put(bundle);
          return;
        }
        const legacy = legacyStore.get(athleteId);
        legacy.onsuccess = () => {
          try {
            bundle = migrateLegacyBundle(athleteId, legacy.result) ?? empty(athleteId);
            // Move only proven same-UUID legacy state so it cannot later be replayed.
            if (legacy.result && bundle.outbox.length + Object.keys(bundle.checkpoints).length > 0) legacyStore.delete(athleteId);
            mutate(bundle); store.put(bundle);
          } catch { transaction.abort(); }
        };
      } catch { transaction.abort(); }
    };
    transaction.oncomplete = () => resolve(bundle);
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("Unable to persist workout."));
  });
}
export function storedCheckpoint(bundle: Bundle, athleteId: string, sessionId: string): Checkpoint | undefined {
  const cp = bundle.checkpoints[sessionId];
  if (!cp) return;
  if (cp.version !== 1 || cp.athleteId !== athleteId || cp.sessionId !== sessionId ||
      !Array.isArray(cp.steps) || !cp.steps.length || cp.steps.length > 200 ||
      !Number.isInteger(cp.index) || cp.index < 0 || cp.index >= cp.steps.length ||
      !Number.isFinite(cp.logicalNow) || !Number.isFinite(cp.savedWallAt) ||
      !Number.isFinite(cp.phaseStartedAt) || !Number.isFinite(cp.phaseDurationMs) || cp.phaseDurationMs < 0 ||
      !["ready", "work", "rest", "finished"].includes(cp.phase)) {
    throw new Error("Invalid or incompatible workout checkpoint. Stored data was preserved.");
  }
  return cp;
}
export function saveChange(bundle: Bundle, change: Change, wall: number) {
  const cp = change.checkpoint;
  cp.savedWallAt = wall;
  bundle.checkpoints[cp.sessionId] = cp;
  for (const event of change.events) {
    if (bundle.outbox.length < MAX_OUTBOX) bundle.outbox.push({ event, status: "pending" });
    else bundle.dropped++;
  }
  // Keep active attempts; finalized checkpoints are only same-device recovery markers.
  const finalized = Object.values(bundle.checkpoints).filter((p) => p.finalized).sort((a, b) => b.logicalNow - a.logicalNow);
  for (const old of finalized.slice(50)) delete bundle.checkpoints[old.sessionId];
}
export function eventBatch(bundle: Bundle): WorkoutSessionEvent[] {
  const batch: WorkoutSessionEvent[] = [];
  for (const item of bundle.outbox) {
    if (item.status !== "pending") continue;
    const candidate = [...batch, item.event];
    if (candidate.length > MAX_EVENT_BATCH || new TextEncoder().encode(JSON.stringify({ events: candidate })).length > MAX_EVENT_BODY_BYTES) break;
    batch.push(item.event);
  }
  return batch;
}
export function acknowledge(bundle: Bundle, sent: WorkoutSessionEvent[], payload: unknown) {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { acknowledgements?: unknown }).acknowledgements)) return;
  const acknowledgements = (payload as { acknowledgements: { id?: unknown; status?: unknown }[] }).acknowledgements;
  const sentIds = new Set(sent.map((e) => e.id));
  for (const ack of acknowledgements) {
    if (!ack || typeof ack.id !== "string" || !sentIds.has(ack.id)) continue;
    const item = bundle.outbox.find((e) => e.event.id === ack.id);
    if (!item) continue;
    if (ack.status === "accepted" || ack.status === "duplicate") bundle.outbox = bundle.outbox.filter((e) => e !== item);
    else if (ack.status === "conflict" || ack.status === "rejected") item.status = ack.status;
  }
}
const flushing = new Map<string, Promise<void>>();
export function flushEvents(athleteId: string, actorUserId: string, verifyActor: () => Promise<string | null>, afterAcknowledged?: (events: WorkoutSessionEvent[]) => Promise<void> | void): Promise<void> {
  const existing = flushing.get(athleteId); if (existing) return existing;
  const work = (async () => {
  try {
    for (let batchIndex = 0; batchIndex < 4; batchIndex++) {
      if (await verifyActor() !== actorUserId) return;
      const bundle = await mutateBundle(athleteId, () => {});
      const events = eventBatch(bundle); if (!events.length) return;
      const response = await fetch("/api/workout-session-events", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ events }), keepalive: true,
      });
      if (!response.ok) return;
      const payload: unknown = await response.json();
      const current = await mutateBundle(athleteId, (current) => acknowledge(current, events, payload));
      const acknowledgements = (payload as { acknowledgements?: { id?: unknown; status?: unknown }[] }).acknowledgements ?? [];
      const accepted = events.filter((event) => acknowledgements.some((ack) => ack?.id === event.id && (ack.status === "accepted" || ack.status === "duplicate")));
      if (accepted.length) await afterAcknowledged?.(accepted);
      const next = eventBatch(current);
      if (next.length && next.every((event, index) => event.id === events[index]?.id)) return;
    }
  } catch { /* Offline/uncertain delivery retains original events. */ }
  finally { flushing.delete(athleteId); }
  })();
  flushing.set(athleteId, work); return work;
}
