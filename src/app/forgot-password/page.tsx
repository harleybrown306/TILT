"use client";

import { FormEvent, useState } from "react";
import { authPath } from "@/lib/auth-continuation";
import { createClient } from "@/lib/supabase/client";

export default function ForgotPasswordPage() {
  const supabase = createClient();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setLoading(true); setError("");
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent("/reset-password")}` });
    setLoading(false);
    if (error) { setError("We could not request a password reset. Please try again later."); return; }
    setSent(true);
  }
  return <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6"><div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-xl"><p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">TILT</p><h1 className="mt-2 text-3xl font-bold text-white">Reset your password</h1>{sent ? <p className="mt-5 text-sm text-slate-300">If an account exists for that email, we&apos;ve sent password reset instructions.</p> : <form onSubmit={submit} className="mt-6 space-y-5"><label className="block text-sm font-medium text-slate-200">Email<input className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-emerald-500" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" /></label>{error && <p role="alert" className="text-sm text-red-300">{error}</p>}<button disabled={loading} className="w-full rounded-lg bg-emerald-500 px-4 py-3 font-semibold text-slate-950 disabled:opacity-60">{loading ? "Sending..." : "Send reset instructions"}</button></form>}<p className="mt-6 text-sm text-slate-400"><a className="text-emerald-400 hover:text-emerald-300" href={authPath("/login", null)}>Back to sign in</a></p></div></main>;
}
