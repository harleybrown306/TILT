"use client";

import Link from "next/link";
import { useActionState } from "react";
import { addAthlete, type AddAthleteState } from "./actions";

const initialState: AddAthleteState = { status: "idle", message: "" };

export default function AddAthleteForm() {
  const [state, formAction, pending] = useActionState(addAthlete, initialState);
  const disabled = pending || state.status === "review_required";
  return <form action={formAction} className="space-y-5">
    {state.message && <p role="alert" className={state.status === "review_required" ? "text-amber-300" : "text-rose-300"}>{state.message}</p>}
    {state.status === "review_required" ? <Link href="/" className="font-semibold text-emerald-400 hover:text-emerald-300">Check dashboard →</Link> : <fieldset disabled={disabled} className="space-y-5">
      <label htmlFor="athlete-first-name" className="block font-medium">First name
        <input id="athlete-first-name" name="firstName" required maxLength={199} autoComplete="given-name" className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-emerald-500" />
      </label>
      <label htmlFor="athlete-last-name" className="block font-medium">Last name
        <input id="athlete-last-name" name="lastName" required maxLength={199} autoComplete="family-name" className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-emerald-500" />
      </label>
      <label htmlFor="athlete-graduation-year" className="block font-medium">High school graduation year
        <input id="athlete-graduation-year" name="graduationYear" required type="number" min="2000" max="2100" inputMode="numeric" className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-emerald-500" />
      </label>
      <p className="text-sm text-slate-400">This creates a training profile under your account. They do not need an email or password.</p>
      <button type="submit" disabled={disabled} className="rounded-xl bg-emerald-500 px-5 py-3 font-semibold text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50">{pending ? "Adding…" : "Add athlete"}</button>
    </fieldset>}
  </form>;
}
