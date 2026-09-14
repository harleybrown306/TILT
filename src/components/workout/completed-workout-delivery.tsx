"use client";
import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { changeAttempt, recoveryNow } from "@/lib/workout-session-state";
import { flushEvents, mutateBundle, saveChange, storedCheckpoint } from "@/lib/workout-session-storage";
// Only mounted after the server confirms canonical completion. Recovers the narrow
// result-committed/checkpoint-not-finalized window without inserting another result.
export default function CompletedWorkoutDelivery({ userId, sessionId, resultExists }: { userId: string; sessionId: string; resultExists: boolean }) {
  useEffect(() => {
    const client = createClient();
    const verify = async () => { const { data: { user }, error } = await client.auth.getUser(); return error ? null : user?.id ?? null; };
    const finish = async () => {
      if (await verify() !== userId) return;
      try {
        await mutateBundle(userId, (bundle) => {
          const cp = storedCheckpoint(bundle, userId, sessionId);
          if (cp && !cp.finalized) {
            if (resultExists) saveChange(bundle, changeAttempt(cp, "finalize", recoveryNow(cp, Date.now()), crypto.randomUUID.bind(crypto), false), Date.now());
            else { cp.finalized = true; cp.phase = "finished"; }
          }
        });
        await flushEvents(userId, verify);
      } catch { /* Completion is already authoritative, even if recovery fails. */ }
    };
    const periodic = window.setInterval(() => { void flushEvents(userId, verify); }, 30000);
    void finish(); window.addEventListener("online", finish);
    return () => { window.removeEventListener("online", finish); clearInterval(periodic); };
  }, [userId, sessionId, resultExists]);
  return null;
}
