"use client";

import { FormEvent, Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authPath, safeAuthContinuation } from "@/lib/auth-continuation";
import { createClient } from "@/lib/supabase/client";

export default function SignupPage() {
  return <Suspense fallback={<main className="min-h-screen bg-slate-950" />}><SignupForm /></Suspense>;
}

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [confirmationNeeded, setConfirmationNeeded] = useState(false);
  const [loading, setLoading] = useState(false);
  const next = searchParams.get("next");

  async function handleSignup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);
    const destination = safeAuthContinuation(next);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName.trim() },
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(destination)}`,
      },
    });
    if (error) {
      setError("We could not create your account. Check your details and try again.");
      setLoading(false);
      return;
    }
    if (!data.session) {
      setConfirmationNeeded(true);
      setLoading(false);
      return;
    }
    router.push(destination);
    router.refresh();
  }

  return <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6"><div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-xl">
    <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">TILT</p>
    <h1 className="mt-2 text-3xl font-bold text-white">Create your account</h1>
    {confirmationNeeded ? <div className="mt-5 space-y-4 text-sm text-slate-300"><p>Check your email to confirm your account.</p><p>After confirming, you can continue to TILT from the email link.</p><a className="text-emerald-400 hover:text-emerald-300" href={authPath("/login", next)}>Back to sign in</a></div> : <>
      <p className="mt-2 text-sm text-slate-400">Your team access is determined by your team memberships.</p>
      <form onSubmit={handleSignup} className="mt-6 space-y-5">
        <label className="block text-sm font-medium text-slate-200">Full name<input className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-emerald-500" value={fullName} onChange={(event) => setFullName(event.target.value)} required autoComplete="name" /></label>
        <label className="block text-sm font-medium text-slate-200">Email<input className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-emerald-500" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" /></label>
        <label className="block text-sm font-medium text-slate-200">Password<input className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-emerald-500" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="new-password" /></label>
        {error && <p role="alert" className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-300">{error}</p>}
        <button type="submit" disabled={loading} className="w-full rounded-lg bg-emerald-500 px-4 py-3 font-semibold text-slate-950 disabled:opacity-60">{loading ? "Creating account..." : "Create account"}</button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-400">Already have an account? <a className="font-medium text-emerald-400 hover:text-emerald-300" href={authPath("/login", next)}>Sign in</a></p>
    </>}
  </div></main>;
}
