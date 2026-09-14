import Link from "next/link";
import { redirect } from "next/navigation";
import RosterActionForm from "@/components/roster-action-form";
import { readAllRows } from "@/lib/training-assignment";
import { canManageInvitation, canRemoveMember, effectiveInvitationStatus, formatInvitationDate } from "@/lib/team-invitations";
import { loadRoster, requireRosterManager, type RosterMember } from "@/lib/team-roster-server";
import { createInvitation, removeMember, revokeInvitation } from "./actions";

type PendingInvitation = { id: string; invited_email: string; role: string; status: string; created_at: string; expires_at: string };
function nameOf(member: RosterMember) {
  const profile = Array.isArray(member.profiles) ? member.profiles[0] : member.profiles;
  return profile?.full_name || "Unnamed member";
}
export default async function RosterPage({ params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  const context = await requireRosterManager(teamId).catch(() => null);
  if (!context) redirect("/");
  let members: RosterMember[] = [], invitations: PendingInvitation[] = [];
  let failed = false;
  try {
    [members, invitations] = await Promise.all([
      loadRoster(context),
      readAllRows<PendingInvitation>((from, to) => context.supabase.from("team_invitations")
        .select("id, invited_email, role, status, created_at, expires_at").eq("team_id", teamId).eq("status", "pending").order("created_at").order("id").range(from, to)),
    ]);
  } catch { failed = true; }
  return <main className="min-h-screen bg-slate-950 px-6 py-10 text-white"><div className="mx-auto max-w-5xl">
    <Link href={`/teams/${teamId}`} className="text-sm text-emerald-400">← Back to team dashboard</Link>
    <header className="my-8"><p className="text-sm font-semibold text-emerald-400">{context.team.name}</p><h1 className="mt-2 text-4xl font-bold">Roster</h1><p className="mt-3 text-slate-400">Manage members and share invitation links. No invitation emails are sent automatically.</p></header>
    <section className="mb-8 grid gap-4 md:grid-cols-2">
      {(["athlete", "assistant_coach"] as const).filter((role) => canManageInvitation(context.managerRole, role)).map((role) => <div key={role} className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <h2 className="mb-4 text-xl font-semibold">Invite {role === "athlete" ? "Athlete" : "Assistant Coach"}</h2>
        <RosterActionForm action={createInvitation.bind(null, teamId, role)} label={`Invite ${role === "athlete" ? "Athlete" : "Assistant Coach"}`} resetHref={`/teams/${teamId}/roster`}>
          <label className="block font-medium">Email address<input name="email" type="email" required maxLength={254} autoComplete="email" className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-white" /></label>
        </RosterActionForm>
      </div>)}
    </section>
    {failed ? <p role="alert" className="text-rose-300">Unable to load roster or invitations. Reload before managing this team.</p> : <>
      {[["athlete", "Athletes"], ["assistant_coach", "Assistant Coaches"], ["coach", "Coaches"]].map(([role, title]) => {
        const group = members.filter((member) => member.role === role).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
        return <section key={role} className="mb-8"><h2 className="mb-4 text-2xl font-semibold">{title}</h2>
          {!group.length ? <p className="text-slate-400">No {title.toLowerCase()} on this team.</p> : <div className="space-y-4">{group.map((member) => <article key={member.id} className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <div><h3 className="text-xl font-semibold">{role === "athlete" ? <Link href={`/teams/${teamId}/athletes/${member.user_id}`} className="text-emerald-400">{nameOf(member)}</Link> : nameOf(member)}</h3><p className="mt-2 text-sm capitalize text-slate-400">{role.replace("_", " ")}</p></div>
            {canRemoveMember(context.managerRole, member, context.user.id, context.team.created_by_user_id) && <RosterActionForm action={removeMember.bind(null, teamId, member.id)} label="Remove member" confirmation={`Remove ${nameOf(member)} from this team? Other memberships and training history will be retained.`} />}
          </article>)}</div>}
        </section>;
      })}
      <section><h2 className="mb-4 text-2xl font-semibold">Pending Invitations</h2>
        <p className="mb-4 text-sm text-slate-400">Old invitation URLs cannot be reconstructed. Revoke a pending or expired link before creating a replacement.</p>
        {!invitations.length ? <p className="text-slate-400">No pending invitations.</p> : <div className="space-y-4">{invitations.map((invitation) => <article key={invitation.id} className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <h3 className="font-semibold">{invitation.invited_email}</h3><p className="mt-2 capitalize text-slate-400">{invitation.role.replace("_", " ")} · {effectiveInvitationStatus(invitation.status, invitation.expires_at)}</p>
          <p className="my-3 text-sm text-slate-400">Invited {formatInvitationDate(invitation.created_at)} · Expires {formatInvitationDate(invitation.expires_at)}</p>
          {canManageInvitation(context.managerRole, invitation.role) && <RosterActionForm action={revokeInvitation.bind(null, teamId, invitation.id)} label="Revoke Invitation" confirmation="Revoke this invitation? The link will stop working." />}
        </article>)}</div>}
      </section>
    </>}
  </div></main>;
}
