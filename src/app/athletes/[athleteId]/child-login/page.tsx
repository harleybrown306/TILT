import Link from "next/link";
import { redirect } from "next/navigation";
import FamilyInvitationActionForm from "@/components/family-invitation-action-form";
import { parseChildLoginInvitationList, type ChildLoginInvitationListItem } from "@/lib/child-login-invitations";
import { loadMyFamilyAthleteContexts } from "@/lib/my-athlete-contexts-server";
import { createClient } from "@/lib/supabase/server";
import { formatInvitationDate } from "@/lib/team-invitations";
import { isUuid } from "@/lib/training-assignment";
import { createChildLoginInvitation, replaceChildLoginInvitation, revokeChildLoginInvitation } from "./actions";

function childLoginStatusLabel(status: ChildLoginInvitationListItem["invitation_status"]) {
  if (status === "pending") return "Activation link available";
  if (status === "accepted") return "Child login is active";
  if (status === "revoked") return "Activation link was revoked";
  return "Activation link expired";
}

export default async function ChildLoginManagementPage({ params }: { params: Promise<{ athleteId: string }> }) {
  const { athleteId } = await params;
  if (!isUuid(athleteId)) redirect("/");
  const context = (await loadMyFamilyAthleteContexts()).find((candidate) => candidate.athleteId === athleteId && candidate.canManage);
  if (!context) redirect("/?access=family-management-unavailable");

  let invitations: ChildLoginInvitationListItem[] = [];
  let failed = false;
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("list_my_child_login_invitations", { p_athlete_id: athleteId });
    const parsed = error ? null : parseChildLoginInvitationList(data);
    if (!parsed) failed = true;
    else invitations = parsed;
  } catch { failed = true; }

  const path = `/athletes/${encodeURIComponent(athleteId)}/child-login`;
  const hasActiveSelf = context.relationshipRole === "self";
  return <main className="min-h-screen bg-slate-950 px-6 py-10 text-white"><div className="mx-auto max-w-3xl">
    <Link href={`/?athlete=${encodeURIComponent(athleteId)}`} className="text-sm font-medium text-emerald-400 hover:text-emerald-300">← Back to training dashboard</Link>
    <header className="my-8"><p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Child self-login</p><h1 className="mt-2 text-3xl font-bold">Manage child login for {context.displayName}</h1><p className="mt-3 text-slate-400">Create and revoke one-time links for a child to set up their own login.</p></header>
    <section className="mb-8 rounded-2xl border border-slate-800 bg-slate-900 p-6"><h2 className="text-xl font-semibold">Create a child login invitation</h2>
      {hasActiveSelf ? <p className="mt-3 text-slate-400">This athlete already has self-login history. A new login invitation cannot be created.</p> : <div className="mt-5 max-w-xl"><FamilyInvitationActionForm action={createChildLoginInvitation.bind(null, athleteId)} label="Create child login invitation" resetHref={path} resetLabel="Create another invitation →" linkDescription="Copy and save this link now. It cannot be recovered from this page. The child can sign in or create an account with the invited email to set up login for this training profile.">
        <label className="block font-medium">Child email address<input name="email" type="email" required maxLength={254} autoComplete="email" className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-white" /></label>
      </FamilyInvitationActionForm></div>}
    </section>
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6"><h2 className="text-xl font-semibold">Child login invitations</h2>
      {failed ? <p role="alert" className="mt-3 text-rose-300">Unable to load child login invitations. Reload before managing access.</p> : !invitations.length ? <p className="mt-3 text-sm text-slate-400">No child login invitations yet.</p> : <div className="mt-4 space-y-3">{invitations.map((invitation) => <article key={invitation.invitation_id} className="rounded-xl border border-slate-700 bg-slate-950 p-4"><p className="font-medium">{invitation.invited_email}</p><p className="mt-1 text-sm text-slate-400">{childLoginStatusLabel(invitation.invitation_status)} · Created {formatInvitationDate(invitation.created_at)} · Expires {formatInvitationDate(invitation.expires_at)}</p>
        {invitation.invitation_status === "pending" && <div className="mt-3 space-y-4"><FamilyInvitationActionForm action={replaceChildLoginInvitation.bind(null, athleteId, invitation.invitation_id)} label="Replace and attempt delivery" confirmation="Replace this invitation? The old link will stop working and a new one will be created." linkDescription="Copy the new link as a fallback; a delivery request is not inbox confirmation."><label className="block text-sm text-slate-400">Child email<input name="email" type="email" required defaultValue={invitation.invited_email} maxLength={254} autoComplete="email" className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-white" /></label></FamilyInvitationActionForm><FamilyInvitationActionForm action={revokeChildLoginInvitation.bind(null, athleteId, invitation.invitation_id)} label="Revoke invitation" confirmation="Revoke this child login invitation? The link will stop working." /></div>}
      </article>)}</div>}
    </section>
  </div></main>;
}
