import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import ChildLoginInvitationAcceptanceForm from "@/components/child-login-invitation-acceptance-form";
import RosterActionForm from "@/components/roster-action-form";
import { authPath } from "@/lib/auth-continuation";
import { childLoginInvitationLoginPath, childLoginInvitationPath, childLoginInvitationStatus, isChildLoginInvitationToken, parseChildLoginInvitationSummary, type ChildLoginInvitationSummary } from "@/lib/child-login-invitations";
import { createServiceClient } from "@/lib/supabase/service";
import { getCurrentVerifiedAuthIdentity } from "@/lib/verified-auth-identity";
import { acceptChildLoginInvitation, switchChildLoginInvitationAccount } from "./actions";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = { referrer: "no-referrer" };

function unavailableMessage(status: ReturnType<typeof childLoginInvitationStatus>) {
  if (status === "expired" || status === "revoked") return "This invitation is unavailable.";
  return "This invitation is unavailable.";
}

function InvitationShell({ children }: { children: ReactNode }) {
  return <main className="min-h-screen bg-slate-950 px-6 py-10 text-white"><div className="mx-auto max-w-2xl">{children}</div></main>;
}

function UnavailableInvitation({ message, token }: { message: string; token?: string }) {
  return <InvitationShell><Link href="/" className="text-sm font-medium text-emerald-400 hover:text-emerald-300">← Back to dashboard</Link>
    <section className="my-8 rounded-2xl border border-slate-800 bg-slate-900 p-6"><h1 className="text-3xl font-bold">Child login invitation</h1><p role="alert" className="mt-4 text-slate-300">{message}</p>
      {token && <div className="mt-6"><RosterActionForm action={switchChildLoginInvitationAccount.bind(null, token)} label="Sign in with another account" /></div>}
    </section>
  </InvitationShell>;
}

function SignedOutInvitation({ token }: { token: string }) {
  const path = childLoginInvitationPath(token);
  return <InvitationShell><section className="my-8 rounded-2xl border border-slate-800 bg-slate-900 p-6"><h1 className="text-3xl font-bold">Child login invitation</h1>
    <p className="mt-4 text-slate-300">Sign in or create an account to continue.</p>
    <div className="mt-6 flex gap-3"><Link href={childLoginInvitationLoginPath(token)} className="rounded-xl bg-emerald-500 px-4 py-2 font-semibold text-slate-950">Sign in</Link><Link href={authPath("/signup", path)} className="rounded-xl border border-slate-700 px-4 py-2 font-semibold">Create account</Link></div>
  </section></InvitationShell>;
}

export default async function ChildLoginInvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isChildLoginInvitationToken(token)) return <UnavailableInvitation message="This invitation is unavailable." />;
  const identity = await getCurrentVerifiedAuthIdentity();
  if (!identity) return <SignedOutInvitation token={token} />;

  let summary: ChildLoginInvitationSummary | null = null;
  let uncertain = false;
  try {
    const { data, error } = await createServiceClient().rpc("server_get_child_login_invitation_summary", { p_auth_user_id: identity.authUserId, p_verified_email: identity.verifiedEmail, p_invitation_token: token });
    const parsed = error ? { kind: "malformed" as const } : parseChildLoginInvitationSummary(data);
    if (parsed.kind === "malformed") uncertain = true;
    else if (parsed.kind === "summary") summary = parsed.value;
  } catch { uncertain = true; }

  if (uncertain) return <UnavailableInvitation message="We could not load this invitation right now. Please try again." token={token} />;
  if (!summary) return <UnavailableInvitation message="This invitation is unavailable." token={token} />;
  const status = childLoginInvitationStatus(summary);
  if (status !== "pending" && status !== "accepted") return <UnavailableInvitation message={unavailableMessage(status)} token={token} />;
  const accepted = status === "accepted";

  return <InvitationShell><Link href="/" className="text-sm font-medium text-emerald-400 hover:text-emerald-300">← Back to dashboard</Link>
    <section className="my-8 rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Child login invitation</p>
      <h1 className="mt-3 text-3xl font-bold">{accepted ? "This link has already been used" : `Claim login access for ${summary.athlete_display_name}`}</h1>
      <p className="mt-4 text-slate-400">{accepted ? "Go to your dashboard to see the training currently available to you." : "This gives the child self access to their existing training profile. It does not change family or team permissions."}</p>
      {!accepted && <p className="mt-5 text-sm text-slate-400">Expires {new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" }).format(new Date(summary.expires_at))}</p>}
      {accepted ? <Link href="/" className="mt-6 inline-block rounded-xl bg-emerald-500 px-4 py-2 font-semibold text-slate-950">Continue to dashboard</Link> : <ChildLoginInvitationAcceptanceForm action={acceptChildLoginInvitation.bind(null, token)} label="Claim child login" />}
      <div className="mt-6 border-t border-slate-800 pt-5"><RosterActionForm action={switchChildLoginInvitationAccount.bind(null, token)} label="Sign in with another account" /></div>
    </section>
  </InvitationShell>;
}
