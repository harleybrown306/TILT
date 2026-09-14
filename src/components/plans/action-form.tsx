"use client";

import { useActionState, type ReactNode } from "react";
import Link from "next/link";
import type { PlanActionState } from "@/lib/training-plans";

const initialState: PlanActionState = { status: "idle", message: "" };
export default function PlanActionForm({ action, children, label, confirmation, disabled = false }: {
  action: (state: PlanActionState, data: FormData) => Promise<PlanActionState>;
  children: ReactNode;
  label: string;
  confirmation?: string;
  disabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  const blocked = pending || disabled || state.status === "review_required";
  const failed = state.status === "error" || state.status === "review_required";
  return <form action={formAction} onSubmit={(event) => {
    if (confirmation && !window.confirm(confirmation)) event.preventDefault();
  }} className="space-y-4">
    {state.message && <p role={failed ? "alert" : "status"} className={failed ? "text-rose-300" : "text-emerald-400"}>{state.message}</p>}
    {state.recoveryUrl && <Link href={state.recoveryUrl} className="inline-block text-emerald-400">Review draft copy →</Link>}
    <fieldset disabled={blocked} className="space-y-4">
      {children}
      <button type="submit" disabled={blocked} className="rounded-xl bg-emerald-500 px-5 py-3 font-semibold text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50">
        {pending ? "Saving…" : label}
      </button>
    </fieldset>
  </form>;
}
