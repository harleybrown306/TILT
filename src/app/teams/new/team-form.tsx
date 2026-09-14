"use client";

import Link from "next/link";
import { useActionState } from "react";
import { MAX_TEAM_NAME_LENGTH, type TeamCreationState } from "@/lib/team-creation";
import { createTeam } from "./actions";

const initialState: TeamCreationState = { status: "idle", message: "" };
export default function TeamCreationForm() {
  const [state, formAction, pending] = useActionState(createTeam, initialState);
  const disabled = pending || state.status === "review_required";
  return <form action={formAction} className="space-y-5">
    {state.message && <p role="alert" className="text-rose-300">{state.message}</p>}
    {state.status === "review_required" && <div className="flex flex-wrap gap-5">
      <Link href="/" className="font-semibold text-emerald-400">Check dashboard →</Link>
      {state.teamUrl && <Link href={state.teamUrl} className="font-semibold text-emerald-400">Check created team →</Link>}
    </div>}
    <fieldset disabled={disabled} className="space-y-5">
      <label htmlFor="team-name" className="block font-medium">Team name</label>
      <input id="team-name" name="name" required maxLength={MAX_TEAM_NAME_LENGTH} autoComplete="off"
        className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-emerald-500" />
      <p className="text-sm text-slate-400">You will be the coach of this team. Your roles on existing teams stay the same.</p>
      <button type="submit" disabled={disabled} className="rounded-xl bg-emerald-500 px-5 py-3 font-semibold text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50">
        {pending ? "Creating…" : "Create Team"}
      </button>
    </fieldset>
  </form>;
}
