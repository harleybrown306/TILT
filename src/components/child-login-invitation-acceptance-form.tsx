"use client";

import { useActionState } from "react";
import type { ChildLoginInvitationAcceptanceState } from "@/app/child-login-invite/[token]/actions";

const idle: ChildLoginInvitationAcceptanceState = { status: "idle", message: "" };

export default function ChildLoginInvitationAcceptanceForm({ action, label = "Claim child login" }: {
  action: (state: ChildLoginInvitationAcceptanceState, data: FormData) => Promise<ChildLoginInvitationAcceptanceState>;
  label?: string;
}) {
  const [state, formAction, pending] = useActionState(action, idle);
  const failed = state.status === "error" || state.status === "review_required";
  return <form action={formAction} className="mt-6 space-y-4">
    {state.message && <p role={failed ? "alert" : "status"} className={failed ? "text-rose-300" : "text-emerald-400"}>{state.message}</p>}
    <button type="submit" disabled={pending || state.status === "review_required"} className="rounded-xl bg-emerald-500 px-4 py-2 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50">{pending ? "Confirming…" : label}</button>
  </form>;
}
