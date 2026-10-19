"use client";

import { FormEvent, Suspense, useState } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { authPath, safeAuthContinuation } from "@/lib/auth-continuation";

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-[var(--tilt-paper)]" />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();
  const next = searchParams.get("next");
  const reference = searchParams.get("reference");
  const safeReference = reference && /^[0-9a-f-]{36}$/i.test(reference) ? reference : null;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(() =>
    searchParams.get("auth") === "error"
      ? "We could not complete authentication. Try again or request a new link."
      : ""
  );
  const [loading, setLoading] = useState(false);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    router.push(safeAuthContinuation(next));
    router.refresh();
  }

  return (
    <main className="tilt-sign-in flex min-h-screen items-center px-5 py-5 sm:px-8 sm:py-8 lg:px-12">
      <div className="tilt-sign-in__shell mx-auto grid w-full max-w-6xl overflow-hidden rounded-[1.75rem] border border-[var(--tilt-line)] bg-[var(--tilt-surface)] lg:grid-cols-[minmax(0,0.94fr)_minmax(25rem,0.86fr)]">
        <section className="flex min-h-[19rem] flex-col justify-between bg-[var(--tilt-ink)] px-7 py-8 text-white sm:min-h-[23rem] sm:px-10 sm:py-10 lg:min-h-[40rem] lg:px-12 lg:py-12">
          <Image
            src="/brand/tilt-dark-full.svg"
            alt="TILT"
            width={1633}
            height={677}
            priority
            className="h-auto w-32 sm:w-40"
          />

          <div className="max-w-sm py-12 lg:py-0">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/55">
              Training intelligence
            </p>
            <h2 className="mt-5 text-4xl font-semibold tracking-[-0.06em] sm:text-5xl lg:text-6xl">
              Train with intent.
            </h2>
            <p className="mt-5 max-w-xs text-sm leading-6 text-white/65 sm:text-base">
              Your work, progress, and team context—kept in one focused place.
            </p>
          </div>

          <p className="text-xs font-medium uppercase tracking-[0.16em] text-white/45">
            Built for the work
          </p>
        </section>

        <section className="px-7 py-9 sm:px-10 sm:py-12 lg:flex lg:flex-col lg:justify-center lg:px-14">
          <div className="mx-auto w-full max-w-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--tilt-muted)]">
              Welcome back
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-[-0.045em] text-[var(--tilt-ink)]">
              Sign in to TILT
            </h1>
            <p className="mt-3 text-sm leading-6 text-[var(--tilt-muted)]">
              Invitation recipients must use the account associated with their invitation.
            </p>

            <form onSubmit={handleLogin} className="mt-8 space-y-5">
              <div>
                <label htmlFor="email" className="mb-2 block text-sm font-medium text-[var(--tilt-ink)]">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  autoComplete="email"
                  className="tilt-sign-in__field w-full rounded-xl px-4 py-3 text-base outline-none transition"
                  placeholder="you@example.com"
                />
              </div>

              <div>
                <div className="mb-2 flex items-baseline justify-between gap-4">
                  <label htmlFor="password" className="text-sm font-medium text-[var(--tilt-ink)]">
                    Password
                  </label>
                  <a
                    href={authPath("/forgot-password", next)}
                    className="text-sm font-medium text-[var(--tilt-ink)] underline decoration-[var(--tilt-line)] underline-offset-4 transition hover:decoration-[var(--tilt-ink)]"
                  >
                    Forgot password?
                  </a>
                </div>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  autoComplete="current-password"
                  className="tilt-sign-in__field w-full rounded-xl px-4 py-3 text-base outline-none transition"
                  placeholder="Enter your password"
                />
              </div>

              {error && (
                <div role="alert" className="rounded-xl border border-[#eac8c4] bg-[#fdf4f2] p-3 text-sm text-[var(--tilt-alert)]">
                  <p>{error}</p>
                  {safeReference && <p className="mt-2 text-xs text-[var(--tilt-alert)]">Support reference: {safeReference}</p>}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-xl bg-[var(--tilt-ink)] px-4 py-3.5 text-sm font-semibold text-white transition hover:bg-black focus:outline-none focus:ring-3 focus:ring-[rgb(17_17_16_/_18%)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? "Signing in..." : "Sign in"}
              </button>
            </form>

            <p className="mt-7 text-center text-sm text-[var(--tilt-muted)]">
              Need an account?{" "}
              <a
                href={authPath("/signup", next)}
                className="font-semibold text-[var(--tilt-ink)] underline decoration-[var(--tilt-line)] underline-offset-4 transition hover:decoration-[var(--tilt-ink)]"
              >
                Create account
              </a>
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
