"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type ChallengeSelectionProps = {
  sessionId: string;
  challengeAvailable: boolean;
  canSelectChallenge: boolean;
  selectionLocked: boolean;
  selectedVariant: "assigned" | "challenge";
};

function selectionErrorMessage(message: string | undefined) {
  if (message === "Challenge selection is locked after workout start") {
    return "This workout has already started, so its performed version cannot change.";
  }

  if (message === "Challenge option is unavailable" || message === "Challenge selection is unavailable") {
    return "Challenge is no longer available for this workout. Your Assigned workout remains selected.";
  }

  return "Unable to select Challenge. Your Assigned workout remains selected.";
}

export default function ChallengeSelection({
  sessionId,
  challengeAvailable,
  canSelectChallenge,
  selectionLocked,
  selectedVariant,
}: ChallengeSelectionProps) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [isSelecting, setIsSelecting] = useState(false);
  const [error, setError] = useState("");

  if (!canSelectChallenge) return null;

  if (selectedVariant === "challenge") {
    return (
      <section className="mt-8 rounded-2xl border border-emerald-500/30 bg-slate-900 p-6" aria-label="Performed workout selection">
        <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Performed workout</p>
        <h2 className="mt-2 text-xl font-semibold">Challenge selected</h2>
        <p className="mt-2 text-sm text-slate-300">This workout will use the approved Challenge prescription.</p>
      </section>
    );
  }

  if (!challengeAvailable) return null;

  if (selectionLocked) {
    return (
      <section className="mt-8 rounded-2xl border border-slate-800 bg-slate-900 p-6" aria-label="Performed workout selection">
        <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Performed workout</p>
        <p className="mt-2 text-sm text-slate-300">Assigned</p>
      </section>
    );
  }

  async function selectChallenge() {
    if (isSelecting) return;
    setIsSelecting(true);
    setError("");

    try {
      const { error: rpcError } = await supabase.rpc("select_my_training_session_variant", {
        p_session_id: sessionId,
        p_variant: "challenge",
      });

      if (rpcError) {
        setError(selectionErrorMessage(rpcError.message));
        return;
      }

      router.refresh();
    } catch (cause) {
      setError(selectionErrorMessage(cause instanceof Error ? cause.message : undefined));
    } finally {
      setIsSelecting(false);
    }
  }

  return (
    <section className="mt-8 rounded-2xl border border-emerald-500/30 bg-slate-900 p-6" aria-labelledby="challenge-heading">
      <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Optional Challenge</p>
      <h2 id="challenge-heading" className="mt-2 text-xl font-semibold">Level Up This TILT</h2>
      <p className="mt-2 max-w-2xl text-sm text-slate-300">Assigned is your coach-prescribed workout. Challenge is an approved harder version you may choose before starting. You can also start Assigned as planned.</p>
      {error && <p className="mt-4 text-sm text-red-300" role="alert">{error}</p>}
      <button
        type="button"
        onClick={() => void selectChallenge()}
        disabled={isSelecting}
        aria-describedby={error ? "challenge-selection-error" : undefined}
        className="mt-5 rounded-xl border border-emerald-400 px-5 py-3 font-semibold text-emerald-300 transition hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isSelecting ? "Selecting Challenge..." : "Level Up This TILT"}
      </button>
      {error && <span id="challenge-selection-error" className="sr-only">{error}</span>}
    </section>
  );
}
