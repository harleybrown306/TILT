"use client";

import { useActionState, useState } from "react";
import type { FamilyAthleteContext } from "@/lib/my-athlete-contexts-server";
import type { FamilyInvitationAcceptanceState } from "@/app/family-invite/[token]/actions";

const idle: FamilyInvitationAcceptanceState = { status: "idle", message: "" };

export default function FamilyInvitationAcceptanceForm({
  action,
  contexts,
}: {
  action: (state: FamilyInvitationAcceptanceState, data: FormData) => Promise<FamilyInvitationAcceptanceState>;
  contexts: FamilyAthleteContext[];
}) {
  const [mode, setMode] = useState<"existing" | "child">(contexts.length ? "existing" : "child");
  const [selectedAthleteId, setSelectedAthleteId] = useState(contexts[0]?.athleteId ?? "");
  const [state, formAction, pending] = useActionState(action, idle);
  const disabled = pending || state.status === "review_required";
  return <form action={formAction} className="mt-6 space-y-5">
    {state.message && <p role={state.status === "error" || state.status === "review_required" ? "alert" : "status"} className={state.status === "error" || state.status === "review_required" ? "text-rose-300" : "text-emerald-400"}>{state.message}</p>}
    {contexts.length > 0 && <fieldset disabled={disabled} className="space-y-3">
      <legend className="font-semibold">Who is joining this team?</legend>
      {contexts.map((context) => <label key={context.athleteId} className="flex cursor-pointer items-center gap-3 rounded-xl border border-slate-700 bg-slate-950 p-4">
        <input type="radio" name="athleteId" value={context.athleteId} checked={mode === "existing" && context.athleteId === selectedAthleteId} onChange={() => { setSelectedAthleteId(context.athleteId); setMode("existing"); }} />
        <span><span className="block font-medium">{context.displayName}</span>{context.graduationYear && <span className="text-sm text-slate-400">Class of {context.graduationYear}</span>}</span>
      </label>)}
      <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-slate-700 bg-slate-950 p-4">
        <input type="radio" name="athleteId" value="" checked={mode === "child"} onChange={() => setMode("child")} />
        <span className="font-medium">Add a child</span>
      </label>
    </fieldset>}
    {contexts.length === 0 && <input type="hidden" name="athleteId" value="" />}
    {mode === "child" && <fieldset disabled={disabled} className="space-y-4 rounded-xl border border-slate-700 bg-slate-950 p-4">
      <legend className="px-1 font-semibold">Child details</legend>
      <label className="block font-medium">First name<input name="firstName" required maxLength={100} autoComplete="off" className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 p-3 text-white" /></label>
      <label className="block font-medium">Last name<input name="lastName" required maxLength={100} autoComplete="off" className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 p-3 text-white" /></label>
      <label className="block font-medium">High school graduation year<input name="graduationYear" required inputMode="numeric" pattern="[0-9]{4}" maxLength={4} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 p-3 text-white" /></label>
    </fieldset>}
    <button type="submit" disabled={disabled} className="rounded-xl bg-emerald-500 px-4 py-2 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50">{pending ? "Adding…" : "Add athlete to team"}</button>
  </form>;
}
