"use client";
import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { finalizePersistedWorkoutAttempt } from "@/lib/workout-attempt-finalization";
import { changeAttempt, recoveryNow } from "@/lib/workout-session-state";
import { flushEvents, mutateBundle, saveChange, storedCheckpoint } from "@/lib/workout-session-storage";
// Only mounted after the server confirms canonical completion. Recovers the narrow
// result-committed/checkpoint-not-finalized window without inserting another result.
export default function CompletedWorkoutDelivery({ actorUserId, athleteId, sessionId, resultExists }: { actorUserId: string; athleteId: string; sessionId: string; resultExists: boolean }) {
  useEffect(() => {
    const client = createClient();
    const verify = async () => { const { data: { user }, error } = await client.auth.getUser(); return error ? null : user?.id ?? null; };
    const finish = async () => {
      if (await verify() !== actorUserId) return;
      try {
        await mutateBundle(athleteId, (bundle) => {
          const cp = storedCheckpoint(bundle, athleteId, sessionId);
          if (cp && !cp.finalized) {
            if (resultExists) saveChange(bundle, changeAttempt(cp, "finalize", recoveryNow(cp, Date.now()), crypto.randomUUID.bind(crypto), false), Date.now());
            else { cp.finalized = true; cp.phase = "finished"; }
          }
        });
        await flushEvents(athleteId, actorUserId, verify);
        const bundle = await mutateBundle(athleteId, () => {});
        const checkpoint = storedCheckpoint(bundle, athleteId, sessionId);
        if (resultExists && checkpoint?.finalized) {
          await finalizePersistedWorkoutAttempt(client, sessionId, checkpoint.attemptId);
        }
      } catch { /* Completion is already authoritative, even if recovery fails. */ }
    };
    const periodic = window.setInterval(() => { void finish(); }, 30000);
    void finish(); window.addEventListener("online", finish);
    return () => { window.removeEventListener("online", finish); clearInterval(periodic); };
  }, [actorUserId, athleteId, sessionId, resultExists]);
  return null;
}
