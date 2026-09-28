"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Option = { workout_exercise_id: string; exercise_name: string };
type Feedback = {
  feedback_id: string;
  q1_response_state: "selected" | "none" | "skipped";
  selected_exercise_label: string | null;
  coach_note: string | null;
};

function normalized(value: string) {
  return value.replace(/^[\s]+|[\s]+$/g, "");
}

function feedbackRow(value: unknown): Feedback | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;
  if (typeof record.feedback_id !== "string" || !["selected", "none", "skipped"].includes(String(record.q1_response_state))) return null;
  return {
    feedback_id: record.feedback_id,
    q1_response_state: record.q1_response_state as Feedback["q1_response_state"],
    selected_exercise_label: typeof record.selected_exercise_label === "string" ? record.selected_exercise_label : null,
    coach_note: typeof record.coach_note === "string" ? record.coach_note : null,
  };
}

export default function WorkoutFeedback({ resultId }: { resultId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [options, setOptions] = useState<Option[] | null>(null);
  const [choice, setChoice] = useState("");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable" | "submitting">("loading");
  const [message, setMessage] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const canonicalNote = normalized(note);
  const overLimit = canonicalNote.length > 500;

  const readExisting = useCallback(async () => {
    const { data, error } = await supabase.rpc("get_my_workout_feedback", { p_workout_result_id: resultId });
    if (error) return { error: true, feedback: null };
    return { error: false, feedback: feedbackRow(data) };
  }, [resultId, supabase]);

  const load = useCallback(async () => {
    setStatus("loading"); setMessage("");
    const existing = await readExisting();
    if (existing.error) { setStatus("unavailable"); return; }
    if (existing.feedback) { setFeedback(existing.feedback); setStatus("ready"); return; }
    const { data, error } = await supabase.rpc("list_my_workout_feedback_exercise_options", { p_workout_result_id: resultId });
    if (error || !Array.isArray(data) || data.some((row) => !row || typeof row.workout_exercise_id !== "string" || typeof row.exercise_name !== "string")) { setStatus("unavailable"); return; }
    setOptions(data as Option[]); setStatus("ready");
  }, [readExisting, resultId, supabase]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function submit() {
    if (!choice || overLimit || status === "submitting") return;
    const state = choice === "none" || choice === "skipped" ? choice : "selected";
    const selected = state === "selected" ? choice : null;
    setStatus("submitting"); setMessage("");
    const { data, error } = await supabase.rpc("submit_my_workout_feedback", {
      p_workout_result_id: resultId,
      p_q1_response_state: state,
      p_selected_workout_exercise_id: selected,
      p_coach_note: canonicalNote || null,
    });
    const submitted = error ? null : feedbackRow(data);
    if (submitted) { setFeedback(submitted); setStatus("ready"); return; }
    const existing = await readExisting();
    if (existing.feedback) { setFeedback(existing.feedback); setStatus("ready"); return; }
    setStatus(existing.error ? "unavailable" : "ready");
    setMessage("Feedback could not be sent. Your workout is still complete; you can try again.");
  }

  if (dismissed) return null;
  if (feedback) return <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-6" aria-live="polite"><p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Feedback sent</p><h3 className="mt-3 font-semibold">Which exercise felt most challenging?</h3><p className="mt-1 text-slate-300">{feedback.q1_response_state === "selected" ? feedback.selected_exercise_label : feedback.q1_response_state === "none" ? "None" : "Skipped"}</p>{feedback.coach_note && <><h3 className="mt-5 font-semibold">Anything you want your coach to know?</h3><p className="mt-1 whitespace-pre-wrap text-slate-300">{feedback.coach_note}</p></>}</section>;
  if (status === "unavailable") return <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-6" aria-live="polite"><p className="text-slate-300">Feedback is unavailable right now. Your workout is still complete.</p><button type="button" className="mt-3 text-emerald-400" onClick={() => void load()}>Try again</button></section>;
  if (status === "loading" || options === null) return <section className="mt-6 text-sm text-slate-400" aria-live="polite">Loading optional feedback…</section>;
  return <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-6"><p className="text-sm text-slate-400">Optional feedback</p><fieldset className="mt-4"><legend className="font-semibold">Which exercise felt most challenging?</legend><div className="mt-3 space-y-3">{options.map((option) => <label key={option.workout_exercise_id} className="flex gap-3"><input type="radio" name="feedback-choice" value={option.workout_exercise_id} checked={choice === option.workout_exercise_id} onChange={(event) => setChoice(event.target.value)} />{option.exercise_name}</label>)}<label className="flex gap-3"><input type="radio" name="feedback-choice" value="none" checked={choice === "none"} onChange={(event) => setChoice(event.target.value)} />None</label><label className="flex gap-3"><input type="radio" name="feedback-choice" value="skipped" checked={choice === "skipped"} onChange={(event) => setChoice(event.target.value)} />Skip</label></div></fieldset><label className="mt-6 block font-semibold" htmlFor="feedback-note">Anything you want your coach to know?</label><textarea id="feedback-note" className="mt-2 w-full rounded border border-slate-700 bg-slate-950 p-3" value={note} onChange={(event) => setNote(event.target.value)} maxLength={501} /><p className={overLimit ? "mt-1 text-sm text-red-300" : "mt-1 text-sm text-slate-400"}>{canonicalNote.length} / 500</p>{message && <p className="mt-3 text-sm text-red-300" aria-live="polite">{message}</p>}<div className="mt-5 flex gap-4"><button type="button" onClick={() => void submit()} disabled={!choice || overLimit || status === "submitting"} className="rounded bg-emerald-500 px-4 py-2 font-semibold text-slate-950 disabled:opacity-50">{status === "submitting" ? "Sending…" : "Send feedback"}</button><button type="button" onClick={() => setDismissed(true)} className="text-slate-300">Not now</button></div></section>;
}
