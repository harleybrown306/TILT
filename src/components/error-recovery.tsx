"use client";

type ErrorRecoveryProps = {
  error: Error & { digest?: string };
  retry: () => void;
};

export default function ErrorRecovery({ error, retry }: ErrorRecoveryProps) {
  // Next.js supplies an opaque digest for server errors. Never render the
  // error message: it can contain sensitive server-side detail in development.
  const reference = typeof error.digest === "string" && error.digest ? error.digest : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-white">
      <section className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center shadow-xl">
        <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">TILT</p>
        <h1 className="mt-3 text-2xl font-bold">Something went wrong</h1>
        <p className="mt-3 text-sm text-slate-300">Your information was not shown. You can try again safely.</p>
        {reference && <p className="mt-4 text-xs text-slate-400">Support reference: {reference}</p>}
        <button type="button" onClick={retry} className="mt-6 rounded-lg bg-emerald-500 px-4 py-3 font-semibold text-slate-950 transition hover:bg-emerald-400">
          Try again
        </button>
      </section>
    </main>
  );
}
