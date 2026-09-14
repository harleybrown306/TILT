import Link from "next/link";
import { redirect } from "next/navigation";
import RosterActionForm from "@/components/roster-action-form";
import { createClient } from "@/lib/supabase/server";
import { canAcceptInvitation, formatInvitationDate, invitationLoginPath, isInvitationToken, type InvitationSummary } from "@/lib/team-invitations";
import { acceptInvitation, switchInvitationAccount } from "./actions";

export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let summary: InvitationSummary | null = null;
  let failed = false;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect(isInvitationToken(token) ? invitationLoginPath(token) : "/login");
  if (isInvitationToken(token)) {
    try {
      const { data, error } = await supabase.rpc("get_team_invitation_summary", { invitation_token: token });
      if (error) failed = true;
      else summary = data?.[0] ?? null;
    } catch { failed = true; }
  }
  return <main className="min-h-screen bg-slate-950 px-6 py-10 text-white"><div className="mx-auto max-w-2xl">
    <Link href="/" className="text-sm text-emerald-400">← Back to dashboard</Link>
    <h1 className="my-8 text-4xl font-bold">Team Invitation</h1>
    <section className="space-y-5 rounded-2xl border border-slate-800 bg-slate-900 p-6">
      {!summary ? <p role="alert" className="text-rose-300">{failed ? "Unable to load this invitation. Reload and try again." : "This invitation is invalid or unavailable."}</p> : <>
        <h2 className="text-2xl font-semibold">{summary.team_name}</h2>
        <p className="capitalize text-emerald-400">{summary.invitation_role.replace("_", " ")} · {canAcceptInvitation(summary) ? "pending" : summary.invitation_status === "pending" ? "expired" : summary.invitation_status}</p>
        <p className="text-slate-400">Expires {formatInvitationDate(summary.expires_at)}</p>
        <p className="text-sm text-slate-400">Accept using the account associated with this invitation. Existing memberships on other teams will stay the same.</p>
        {canAcceptInvitation(summary) ? <RosterActionForm action={acceptInvitation.bind(null, token)} label="Accept Invitation" /> : <p className="text-slate-400">This invitation cannot be accepted. If you already accepted it, open your dashboard. Otherwise, ask the coach for a new link.</p>}
      </>}
      {isInvitationToken(token) && <RosterActionForm action={switchInvitationAccount.bind(null, token)} label="Sign in with another account" />}
    </section>
  </div></main>;
}
