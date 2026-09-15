import Link from "next/link";

export default function ResetPasswordSuccessPage() {
  return <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-white"><div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-xl"><p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">TILT</p><h1 className="mt-2 text-3xl font-bold">Password updated successfully</h1><p className="mt-3 text-sm text-slate-400">Your password has been changed.</p><Link href="/" className="mt-6 inline-block rounded-lg bg-emerald-500 px-4 py-3 font-semibold text-slate-950 transition hover:bg-emerald-400">Continue to TILT</Link></div></main>;
}
