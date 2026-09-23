"use client";

import { useActionState, useState, type ReactNode } from "react";

export type FamilyInvitationActionState = {
  status: "idle" | "error" | "success" | "review_required";
  message: string;
  invitationPath?: string;
  email?: string;
  expiresAt?: string;
};

const idle: FamilyInvitationActionState = { status: "idle", message: "" };

export default function FamilyInvitationActionForm({ action, label, linkDescription, resetLabel, children, resetHref, confirmation }: {
  action: (state: FamilyInvitationActionState, data: FormData) => Promise<FamilyInvitationActionState>;
  label: string; linkDescription?: string; resetLabel?: string;
  children?: ReactNode;
  resetHref?: string;
  confirmation?: string;
}) {
  const [state, formAction, pending] = useActionState(action, idle);
  const [copyMessage, setCopyMessage] = useState("");
  const disabled = pending || state.status === "success" || state.status === "review_required";
  const link = state.invitationPath ? (typeof window === "undefined" ? state.invitationPath : new URL(state.invitationPath, window.location.origin).href) : "";
  const failed = state.status === "error" || state.status === "review_required";

  return <form action={formAction} className="space-y-4" onSubmit={(event) => {
    if (confirmation && !window.confirm(confirmation)) event.preventDefault();
  }}>
    {state.message && <p role={failed ? "alert" : "status"} className={failed ? "text-rose-300" : "text-emerald-400"}>{state.message}</p>}
    {link ? <div className="space-y-3">
      <p className="text-sm text-slate-300">{linkDescription ?? "Send this link to the parent or guardian. They&apos;ll choose which athlete is joining the team."}</p>
      <label className="block text-sm text-slate-400">Family invitation link<input readOnly value={link} onFocus={(event) => event.target.select()} className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-white" /></label>
      <button type="button" className="rounded-lg border border-emerald-500 px-4 py-2 text-emerald-400" onClick={async () => {
        try { await navigator.clipboard.writeText(link); setCopyMessage("Invitation link copied."); }
        catch { setCopyMessage("Copy is unavailable. Select the invitation link and copy it manually."); }
      }}>Copy invitation link</button>
      {copyMessage && <p role="status" className="text-sm text-slate-400">{copyMessage}</p>}
      {resetHref && <a href={resetHref} className="block text-emerald-400">{resetLabel ?? "Invite another family →"}</a>}
    </div> : <fieldset disabled={disabled} className="space-y-4">
      {children}
      <button type="submit" disabled={disabled} className="rounded-xl bg-emerald-500 px-4 py-2 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50">{pending ? "Creating…" : label}</button>
    </fieldset>}
  </form>;
}
