"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { finalizePersistedWorkoutAttempt } from "@/lib/workout-attempt-finalization";
import { beginAttempt, changeAttempt, recoveryNow, type Checkpoint, type Command, type WorkoutStep } from "@/lib/workout-session-state";
import { flushEvents, mutateBundle, saveChange, storedCheckpoint } from "@/lib/workout-session-storage";

type Input = { actorUserId: string; athleteId: string; sessionId: string; workoutId: string; workoutName: string; steps: WorkoutStep[] };
export function useWorkoutSession(input: Input) {
  const [checkpoint, setCheckpoint] = useState<Checkpoint | null>(null);
  const [ready, setReady] = useState(false); const [warning, setWarning] = useState("");
  const current = useRef<Checkpoint | null>(null); const busy = useRef(Promise.resolve());
  const clock = useRef({ logical: 0, performance: 0, wall: 0 });
  const lastVisibility = useRef<string | null>(null);
  const activeActor = useRef(input.actorUserId);
  const [supabase] = useState(createClient);
  const verifyActor = useCallback(async () => {
    const { data: { user }, error } = await supabase.auth.getUser(); return error ? null : user?.id ?? null;
  }, [supabase]);
  const register = useCallback(async (attemptId: string) => {
    const { error } = await supabase.rpc("register_my_workout_session_attempt", { p_attempt_id: attemptId, p_session_id: input.sessionId });
    if (error) throw error;
  }, [supabase, input.sessionId]);
  const flush = useCallback(() => flushEvents(input.athleteId, input.actorUserId, verifyActor, async (events) => {
    for (const event of events) if (event.event_type === "workout_started") {
      try { await register(event.attempt_id); } catch { setWarning("Workout start telemetry was saved, but attempt registration needs retry."); }
    }
  }), [input.athleteId, input.actorUserId, verifyActor, register]);
  const finalizeAttempt = useCallback(async () => {
    const cp = current.current; if (!cp?.finalized) return;
    await flush();
    await finalizePersistedWorkoutAttempt(supabase, input.sessionId, cp.attemptId);
  }, [flush, supabase, input.sessionId]);
  function now() {
    const anchor = clock.current;
    const mono = Math.max(0, performance.now() - anchor.performance);
    const wall = Date.now() - anchor.wall;
    // Prefer monotonic elapsed; reconcile suspended clocks with bounded wall elapsed.
    const delta = wall >= 0 && wall <= 86400000 ? Math.max(mono, wall) : mono;
    return Math.round(anchor.logical + delta);
  }
  const publish = useCallback((cp: Checkpoint) => {
    current.current = cp;
    clock.current = { logical: cp.logicalNow, performance: performance.now(), wall: Date.now() };
    setCheckpoint(cp);
  }, []);
  const run = useCallback((command: Command | "begin", expected?: { index: number; phase: string; paused: boolean }) => {
    const work = busy.current.then(async () => {
      if (activeActor.current !== input.actorUserId || (command === "begin" && await verifyActor() !== input.actorUserId)) { setWarning("Your signed-in account changed. Reload before continuing."); return; }
      try {
        let createdEvents = false;
        const bundle = await mutateBundle(input.athleteId, (bundle) => {
          const before = bundle.outbox.length;
          const cp = storedCheckpoint(bundle, input.athleteId, input.sessionId);
          if (command === "begin") {
            if (cp) return;
            saveChange(bundle, beginAttempt(input, Date.now(), crypto.randomUUID.bind(crypto)), Date.now());
          } else if (cp && !cp.finalized) {
            if (expected && (cp.index !== expected.index || cp.phase !== expected.phase || (cp.pausedAt !== null) !== expected.paused)) return;
            const time = current.current?.attemptId === cp.attemptId ? Math.max(now(), cp.logicalNow) : recoveryNow(cp, Date.now());
            saveChange(bundle, changeAttempt(cp, command, time, crypto.randomUUID.bind(crypto), document.visibilityState === "visible" && command !== "hidden" && command !== "visible"), Date.now());
          }
          createdEvents = bundle.outbox.length > before;
        });
        const cp = storedCheckpoint(bundle, input.athleteId, input.sessionId); if (cp) publish(cp);
        if (bundle.dropped || bundle.outbox.some((e) => e.status !== "pending")) setWarning("Some workout observations need synchronization review. Workout completion is still available.");
        if (createdEvents || command === "finalize") void flush();
      } catch { setWarning("Workout recovery storage is unavailable. Retry; telemetry will not prevent saving a finished workout."); }
    });
    busy.current = work.catch(() => {}); return work;
  }, [input, verifyActor, publish, flush]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (await verifyActor() !== input.actorUserId) return;
        const bundle = await mutateBundle(input.athleteId, (bundle) => {
          const cp = storedCheckpoint(bundle, input.athleteId, input.sessionId);
          if (cp) {
            saveChange(bundle, changeAttempt(cp, "recover", recoveryNow(cp, Date.now()), crypto.randomUUID.bind(crypto), false), Date.now());
          }
        });
        const recovered = bundle.checkpoints[input.sessionId];
        if (!cancelled && activeActor.current === input.actorUserId && recovered) {
          publish(recovered);
          const { data, error } = await supabase.from("workout_session_events").select("id")
            .eq("session_id", input.sessionId).eq("attempt_id", recovered.attemptId).eq("event_type", "workout_started").limit(1);
          if (!error && data?.length) { try { await register(recovered.attemptId); } catch { setWarning("Workout start telemetry was saved, but attempt registration needs retry."); } }
        }
      } catch { if (!cancelled) setWarning("Unable to load same-device workout recovery. Check browser storage and retry."); }
      finally { if (!cancelled) { setReady(true); void flush(); } }
    })();
    return () => { cancelled = true; };
  }, [input.sessionId, input.athleteId, input.actorUserId, publish, verifyActor, flush, register, supabase]);
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      activeActor.current = session?.user.id ?? "";
      if (activeActor.current !== input.actorUserId) { current.current = null; setWarning("Workout belongs to another signed-in account. Reload after signing in."); }
    });
    return () => subscription.unsubscribe();
  }, [supabase, input.actorUserId]);
  useEffect(() => {
    const visibility = () => {
      const state = document.visibilityState;
      if (!current.current || current.current.finalized || lastVisibility.current === state) return;
      lastVisibility.current = state; void run(state === "hidden" ? "hidden" : "visible");
      if (state === "visible") void flush();
    };
    const online = () => { void flush(); };
    document.addEventListener("visibilitychange", visibility); window.addEventListener("online", online);
    const timer = window.setInterval(() => { if (current.current && !current.current.finalized) void run("tick"); }, 1000);
    const delivery = window.setInterval(() => { void flush(); }, 30000);
    return () => { document.removeEventListener("visibilitychange", visibility); window.removeEventListener("online", online); clearInterval(timer); clearInterval(delivery); };
  }, [run, flush]);
  return { checkpoint, ready, warning, run, flush, finalizeAttempt };
}
