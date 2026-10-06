import Link from "next/link";
import { redirect } from "next/navigation";
import FamilyInvitationActionForm from "@/components/family-invitation-action-form";
import { guardianInvitationStatus, parseGuardianInvitationList, type GuardianInvitationListItem } from "@/lib/guardian-invitations";
import { loadMyFamilyAthleteContexts } from "@/lib/my-athlete-contexts-server";
import { createClient } from "@/lib/supabase/server";
import { formatInvitationDate } from "@/lib/team-invitations";
import { isUuid } from "@/lib/training-assignment";
import { createGuardianInvitation, replaceGuardianInvitation, revokeGuardianInvitation } from "./actions";

function guardianInvitationStatusLabel(status: GuardianInvitationListItem["invitation_status"]) {
  if (status === "pending") return "Invitation is ready to use";
  if (status === "accepted") return "Guardian access is active";
  if (status === "revoked") return "Invitation was revoked";
  return "Invitation expired";
}

export default async function GuardianManagementPage({ params }: { params: Promise<{ athleteId: string }> }) {
  const { athleteId } = await params;
  if (!isUuid(athleteId)) redirect("/");
  const context = (await loadMyFamilyAthleteContexts()).find((candidate) => candidate.athleteId === athleteId && candidate.relationshipRole === "guardian" && candidate.canManage);
  if (!context) redirect("/?access=family-management-unavailable");

  let invitations: GuardianInvitationListItem[] = [];
  let failed = false;
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("list_my_guardian_invitations", { p_athlete_id: athleteId });
    const parsed = error ? null : parseGuardianInvitationList(data);
    if (!parsed) failed = true;
    else invitations = parsed;
  } catch { failed = true; }

  const path = `/athletes/${encodeURIComponent(athleteId)}/guardians`;
  return <main className="min-h-screen bg-slate-950 px-6 py-10 text-white"><div className="mx-auto max-w-3xl">
    <Link href={`/?athlete=${encodeURIComponent(athleteId)}`} className="text-sm font-medium text-emerald-400 hover:text-emerald-300">← Back to training dashboard</Link>
    <header className="my-8"><p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Guardian access</p><h1 className="mt-2 text-3xl font-bold">Manage guardians for {context.displayName}</h1><p className="mt-3 text-slate-400">Invited guardians receive view-only access. They cannot manage access or start training.</p></header>
    <section className="mb-8 rounded-2xl border border-slate-800 bg-slate-900 p-6"><h2 className="text-xl font-semibold">Invite an additional guardian</h2><div className="mt-5 max-w-xl"><FamilyInvitationActionForm action={createGuardianInvitation.bind(null, athleteId)} label="Create guardian invitation" resetHref={path} resetLabel="Invite another guardian →" linkDescription="Send this link to the invited adult. They will receive view-only guardian access after signing in with this email.">
      <label className="block font-medium">Adult email address<input name="email" type="email" required maxLength={254} autoComplete="email" className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-white" /></label>
    </FamilyInvitationActionForm></div></section>
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6"><h2 className="text-xl font-semibold">Guardian invitations</h2>
      {failed ? <p role="alert" className="mt-3 text-rose-300">Unable to load guardian invitations. Reload before managing access.</p> : !invitations.length ? <p className="mt-3 text-sm text-slate-400">No guardian invitations yet.</p> : <div className="mt-4 space-y-3">{invitations.map((invitation) => {
        const status = guardianInvitationStatus(invitation);
        return <article key={invitation.invitation_id} className="rounded-xl border border-slate-700 bg-slate-950 p-4"><p className="font-medium">{invitation.invited_email}</p><p className="mt-1 text-sm text-slate-400">{guardianInvitationStatusLabel(status)} · Expires {formatInvitationDate(invitation.expires_at)}</p>
          {status === "pending" && <div className="mt-3 space-y-4"><FamilyInvitationActionForm action={replaceGuardianInvitation.bind(null, athleteId, invitation.invitation_id)} label="Replace and attempt delivery" confirmation="Replace this invitation? The old link will stop working and a new one will be created." linkDescription="Copy the new link as a fallback; a delivery request is not inbox confirmation."><label className="block text-sm text-slate-400">Recipient email<input name="email" type="email" required defaultValue={invitation.invited_email} maxLength={254} autoComplete="email" className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-white" /></label></FamilyInvitationActionForm><FamilyInvitationActionForm action={revokeGuardianInvitation.bind(null, athleteId, invitation.invitation_id)} label="Revoke invitation" confirmation="Revoke this guardian invitation? The link will stop working." /></div>}
        </article>;
      })}</div>}
    </section>
  </div></main>;
}
