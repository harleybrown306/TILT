import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import FamilyInvitationAcceptanceForm from "@/components/family-invitation-acceptance-form";
import RosterActionForm from "@/components/roster-action-form";
import { loadMyFamilyAthleteContexts } from "@/lib/my-athlete-contexts-server";
import { createClient } from "@/lib/supabase/server";
import {
  familyInvitationLoginPath,
  familyInvitationStatus,
  isFamilyInvitationToken,
  type FamilyInvitationSummary,
} from "@/lib/family-team-invitations";
import { acceptFamilyTeamInvitation, switchFamilyInvitationAccount } from "./actions";

export const metadata: Metadata = { referrer: "no-referrer" };

function unavailableMessage(status: ReturnType<typeof familyInvitationStatus>) {
  if (status === "expired") return "This invitation has expired. Ask the team for a new invitation.";
  if (status === "revoked") return "This invitation is no longer available.";
  if (status === "accepted") return "This invitation has already been used.";
  return "This invitation is invalid or unavailable.";
}

export default async function FamilyInvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isFamilyInvitationToken(token)) return <UnavailableInvitation message="This invitation is invalid or unavailable." />;

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect(familyInvitationLoginPath(token));

  let summary: FamilyInvitationSummary | null = null;
  let uncertain = false;
  try {
    const { data, error } = await supabase.rpc("get_family_team_invitation_summary", { p_invitation_token: token });
    if (error) uncertain = true;
    else summary = (data?.[0] as FamilyInvitationSummary | undefined) ?? null;
  } catch {
    uncertain = true;
  }

  if (uncertain) return <UnavailableInvitation message="We could not load this invitation right now. Please try again." token={token} />;
  if (!summary) return <UnavailableInvitation message="This invitation is invalid or unavailable." token={token} />;
  const status = familyInvitationStatus(summary);
  if (status !== "pending") return <UnavailableInvitation message={unavailableMessage(status)} token={token} />;

  let contexts;
  try {
    contexts = (await loadMyFamilyAthleteContexts()).filter((context) => context.canManage);
  } catch {
    return <UnavailableInvitation message="We could not load your family athletes right now. Please try again." token={token} />;
  }

  return <main className="min-h-screen bg-slate-950 px-6 py-10 text-white"><div className="mx-auto max-w-2xl">
    <Link href="/" className="text-sm font-medium text-emerald-400 hover:text-emerald-300">← Back to dashboard</Link>
    <section className="my-8 rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Team invitation</p>
      <h1 className="mt-3 text-3xl font-bold">You&apos;ve been invited to add an athlete to {summary.team_name}.</h1>
      <p className="mt-4 text-slate-400">Choose an athlete you manage, or add a child for this team.</p>
      <p className="mt-5 text-sm text-slate-400">Expires {new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" }).format(new Date(summary.expires_at))}</p>
      <FamilyInvitationAcceptanceForm action={acceptFamilyTeamInvitation.bind(null, token)} contexts={contexts} />
      <div className="mt-6 border-t border-slate-800 pt-5"><RosterActionForm action={switchFamilyInvitationAccount.bind(null, token)} label="Sign in with another account" /></div>
    </section>
  </div></main>;
}

function UnavailableInvitation({ message, token }: { message: string; token?: string }) {
  return <main className="min-h-screen bg-slate-950 px-6 py-10 text-white"><div className="mx-auto max-w-2xl">
    <Link href="/" className="text-sm font-medium text-emerald-400 hover:text-emerald-300">← Back to dashboard</Link>
    <section className="my-8 rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <h1 className="text-3xl font-bold">Family team invitation</h1>
      <p role="alert" className="mt-4 text-slate-300">{message}</p>
      {token && <div className="mt-6"><RosterActionForm action={switchFamilyInvitationAccount.bind(null, token)} label="Sign in with another account" /></div>}
    </section>
  </div></main>;
}
