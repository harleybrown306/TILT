"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { resetPassword } from "./actions";
import { initialResetPasswordState } from "./reset-password-state";

export default function ResetPasswordForm() {
  const router = useRouter();
  const [state, action, pending] = useActionState(resetPassword, initialResetPasswordState);
  return <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6"><div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-xl"><p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">TILT</p><h1 className="mt-2 text-3xl font-bold text-white">Choose a new password</h1>{state.status === "success" ? <div className="mt-5 space-y-4"><p className="text-sm text-slate-300">{state.message}</p><button onClick={() => { router.push("/"); router.refresh(); }} className="rounded-lg bg-emerald-500 px-4 py-3 font-semibold text-slate-950">Continue to TILT</button></div> : <form action={action} className="mt-6 space-y-5"><label className="block text-sm font-medium text-slate-200">New password<input className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-emerald-500" name="password" type="password" required autoComplete="new-password" /></label><label className="block text-sm font-medium text-slate-200">Confirm password<input className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-emerald-500" name="confirmation" type="password" required autoComplete="new-password" /></label>{state.status === "error" && <p role="alert" className="text-sm text-red-300">{state.message}</p>}<button disabled={pending} className="w-full rounded-lg bg-emerald-500 px-4 py-3 font-semibold text-slate-950 disabled:opacity-60">{pending ? "Updating..." : "Update password"}</button></form>}</div></main>;
}
