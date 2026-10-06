import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import GuardianInvitationAcceptanceForm from "@/components/guardian-invitation-acceptance-form";
import RosterActionForm from "@/components/roster-action-form";
import { guardianInvitationLoginPath, guardianInvitationStatus, isGuardianInvitationToken, parseGuardianInvitationSummary, type GuardianInvitationSummary } from "@/lib/guardian-invitations";
import { createServiceClient } from "@/lib/supabase/service";
import { getCurrentVerifiedAuthIdentity } from "@/lib/verified-auth-identity";
import { acceptGuardianInvitation, switchGuardianInvitationAccount } from "./actions";

export const metadata: Metadata = { referrer: "no-referrer" };

function unavailableMessage(status: ReturnType<typeof guardianInvitationStatus>) {
  if (status === "expired") return "This invitation has expired. Ask the guardian who invited you for a new link.";
  if (status === "revoked") return "This invitation is no longer available.";
  if (status === "accepted") return "This invitation has already been used.";
  return "This invitation is unavailable.";
}

export default async function GuardianInvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isGuardianInvitationToken(token)) return <UnavailableInvitation message="This invitation is unavailable." />;
  const identity = await getCurrentVerifiedAuthIdentity();
  if (!identity) redirect(guardianInvitationLoginPath(token));

  let summary: GuardianInvitationSummary | null = null;
  let uncertain = false;
  try {
    const { data, error } = await createServiceClient().rpc("server_get_guardian_invitation_summary", { p_auth_user_id: identity.authUserId, p_verified_email: identity.verifiedEmail, p_invitation_token: token });
    const parsed = error ? { kind: "malformed" as const } : parseGuardianInvitationSummary(data);
    if (parsed.kind === "malformed") uncertain = true;
    else if (parsed.kind === "summary") summary = parsed.value;
  } catch { uncertain = true; }

  if (uncertain) return <UnavailableInvitation message="We could not load this invitation right now. Please try again." token={token} />;
  // A no-row result deliberately remains indistinguishable from invalid/mismatched pre-disclosure states.
  if (!summary) return <UnavailableInvitation message="This invitation is unavailable." token={token} />;
  const status = guardianInvitationStatus(summary);
  if (status === "accepted") return <AcceptedInvitation />;
  if (status !== "pending") return <UnavailableInvitation message={unavailableMessage(status)} token={token} />;

  return <main className="min-h-screen bg-slate-950 px-6 py-10 text-white"><div className="mx-auto max-w-2xl">
    <Link href="/" className="text-sm font-medium text-emerald-400 hover:text-emerald-300">← Back to dashboard</Link>
    <section className="my-8 rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Guardian invitation</p>
      <h1 className="mt-3 text-3xl font-bold">You&apos;ve been invited to view {summary.athlete_display_name}&apos;s training.</h1>
      <p className="mt-4 text-slate-400">This gives view-only guardian access. You cannot manage access or start training.</p>
      <p className="mt-5 text-sm text-slate-400">Expires {new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" }).format(new Date(summary.expires_at))}</p>
      <GuardianInvitationAcceptanceForm action={acceptGuardianInvitation.bind(null, token)} />
      <div className="mt-6 border-t border-slate-800 pt-5"><RosterActionForm action={switchGuardianInvitationAccount.bind(null, token)} label="Sign in with another account" /></div>
    </section>
  </div></main>;
}

function AcceptedInvitation() {
  return <main className="min-h-screen bg-slate-950 px-6 py-10 text-white"><div className="mx-auto max-w-2xl">
    <Link href="/" className="text-sm font-medium text-emerald-400 hover:text-emerald-300">← Back to dashboard</Link>
    <section className="my-8 rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Guardian invitation</p>
      <h1 className="mt-3 text-3xl font-bold">This link has already been used</h1>
      <p className="mt-4 text-slate-400">Go to your dashboard to see the training currently available to you.</p>
      <Link href="/" className="mt-6 inline-block rounded-xl bg-emerald-500 px-4 py-2 font-semibold text-slate-950">Continue to dashboard</Link>
    </section>
  </div></main>;
}

function UnavailableInvitation({ message, token }: { message: string; token?: string }) {
  return <main className="min-h-screen bg-slate-950 px-6 py-10 text-white"><div className="mx-auto max-w-2xl">
    <Link href="/" className="text-sm font-medium text-emerald-400 hover:text-emerald-300">← Back to dashboard</Link>
    <section className="my-8 rounded-2xl border border-slate-800 bg-slate-900 p-6"><h1 className="text-3xl font-bold">Guardian invitation</h1><p role="alert" className="mt-4 text-slate-300">{message}</p>
      {token && <div className="mt-6"><RosterActionForm action={switchGuardianInvitationAccount.bind(null, token)} label="Sign in with another account" /></div>}
    </section>
  </div></main>;
}
