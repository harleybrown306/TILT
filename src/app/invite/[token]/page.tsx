import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import RosterActionForm from "@/components/roster-action-form";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { canAcceptInvitation, formatInvitationDate, invitationLoginPath, isInvitationToken, type InvitationSummary } from "@/lib/team-invitations";
import { getCurrentVerifiedAuthIdentity } from "@/lib/verified-auth-identity";
import { acceptInvitation, switchInvitationAccount } from "./actions";

export const metadata: Metadata = { referrer: "no-referrer" };

export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isInvitationToken(token)) return <UnavailableInvitation />;

  let summary: InvitationSummary | null = null;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect(invitationLoginPath(token));
  const identity = await getCurrentVerifiedAuthIdentity();
  if (!identity) return <UnavailableInvitation token={token} />;

  try {
    const { data, error } = await createServiceClient().rpc("server_get_team_invitation_summary", {
      p_auth_user_id: identity.authUserId,
      p_verified_email: identity.verifiedEmail,
      p_invitation_token: token,
    });
    if (!error) summary = (data?.[0] as InvitationSummary | undefined) ?? null;
  } catch {
    summary = null;
  }

  if (!summary) return <UnavailableInvitation token={token} />;
  return <main className="min-h-screen bg-slate-950 px-6 py-10 text-white"><div className="mx-auto max-w-2xl">
    <Link href="/" className="text-sm text-emerald-400">← Back to dashboard</Link>
    <h1 className="my-8 text-4xl font-bold">Team Invitation</h1>
    <section className="space-y-5 rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <h2 className="text-2xl font-semibold">{summary.team_name}</h2>
      <p className="capitalize text-emerald-400">{summary.invitation_role.replace("_", " ")} · {canAcceptInvitation(summary) ? "pending" : summary.invitation_status === "pending" ? "expired" : summary.invitation_status}</p>
      <p className="text-slate-400">Expires {formatInvitationDate(summary.expires_at)}</p>
      <p className="text-sm text-slate-400">Accept using the account associated with this invitation. Existing memberships on other teams will stay the same.</p>
      {summary.invitation_role === "athlete" && <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100">This legacy athlete invitation adds team membership only. It does not create a training profile; ask the coach for a family invitation to set up training.</p>}
      {canAcceptInvitation(summary) ? <RosterActionForm action={acceptInvitation.bind(null, token)} label="Accept Invitation" /> : <p className="text-slate-400">This invitation cannot be accepted. If you already accepted it, open your dashboard. Otherwise, ask the coach for a new link.</p>}
      <RosterActionForm action={switchInvitationAccount.bind(null, token)} label="Sign in with another account" />
    </section>
  </div></main>;
}

function UnavailableInvitation({ token }: { token?: string }) {
  return <main className="min-h-screen bg-slate-950 px-6 py-10 text-white"><div className="mx-auto max-w-2xl">
    <Link href="/" className="text-sm text-emerald-400">← Back to dashboard</Link>
    <h1 className="my-8 text-4xl font-bold">Team Invitation</h1>
    <section className="space-y-5 rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <p role="alert" className="text-rose-300">This invitation is unavailable.</p>
      {token && <RosterActionForm action={switchInvitationAccount.bind(null, token)} label="Sign in with another account" />}
    </section>
  </div></main>;
}
