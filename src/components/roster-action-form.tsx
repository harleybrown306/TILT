"use client";

import { useActionState, useState, type ReactNode } from "react";
import { formatInvitationDate, type RosterState } from "@/lib/team-invitations";

const idle: RosterState = { status: "idle", message: "" };
export default function RosterActionForm({ action, label, children, confirmation, resetHref }: {
  action: (state: RosterState, data: FormData) => Promise<RosterState>;
  label: string; children?: ReactNode; confirmation?: string; resetHref?: string;
}) {
  const [state, formAction, pending] = useActionState(action, idle);
  const [copyMessage, setCopyMessage] = useState("");
  const disabled = pending || state.status === "review_required" || state.status === "success";
  const failed = state.status === "error" || state.status === "review_required";
  const link = state.invitationPath ? (typeof window === "undefined" ? state.invitationPath : new URL(state.invitationPath, window.location.origin).href) : "";
  return <form action={formAction} className="space-y-4" onSubmit={(event) => {
    if (confirmation && !window.confirm(confirmation)) event.preventDefault();
  }}>
    {state.message && <p role={failed ? "alert" : "status"} className={failed ? "text-rose-300" : "text-emerald-400"}>{state.message}</p>}
    {link && <div className="space-y-3">
      <p className="text-slate-300">{state.email} · {state.role?.replace("_", " ")}</p>
      {state.expiresAt && <p className="text-sm text-slate-400">Expires {formatInvitationDate(state.expiresAt)}</p>}
      <label className="block text-sm text-slate-400">Invitation URL<input readOnly value={link} onFocus={(event) => event.target.select()} className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-white" /></label>
      <button type="button" className="rounded-lg border border-emerald-500 px-4 py-2 text-emerald-400" onClick={async () => {
        try { await navigator.clipboard.writeText(link); setCopyMessage("Invitation link copied."); }
        catch { setCopyMessage("Copy is unavailable. Select the invitation URL and copy it manually."); }
      }}>Copy Invitation Link</button>
      {copyMessage && <p role="status" className="text-sm text-slate-400">{copyMessage}</p>}
      {resetHref && <a href={resetHref} className="block text-emerald-400">Invite another person →</a>}
    </div>}
    {!link && <fieldset disabled={disabled} className="space-y-4">
      {children}
      <button type="submit" disabled={disabled} className="rounded-xl bg-emerald-500 px-4 py-2 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50">{pending ? "Saving…" : label}</button>
    </fieldset>}
  </form>;
}
