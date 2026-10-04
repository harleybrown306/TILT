import Link from "next/link";
import { redirect } from "next/navigation";
import FamilyInvitationActionForm from "@/components/family-invitation-action-form";
import RosterActionForm from "@/components/roster-action-form";
import { readAllRows } from "@/lib/training-assignment";
import { familyInvitationStatus, type FamilyInvitationSummary } from "@/lib/family-team-invitations";
import { canManageInvitation, effectiveInvitationStatus, formatInvitationDate } from "@/lib/team-invitations";
import { loadDurableRoster, loadManagedAthletes, loadRoster, requireRosterManager, type DurableAthlete, type RosterMember } from "@/lib/team-roster-server";
import { addManagedAthleteToTeam, createFamilyInvitation, createInvitation, createManagedAthlete, revokeFamilyInvitation, revokeInvitation } from "./actions";

type PendingInvitation = { id: string; invited_email: string; role: string; status: string; created_at: string; expires_at: string };
type FamilyInvitation = { id: string; invited_email: string; status: FamilyInvitationSummary["invitation_status"]; created_at: string; expires_at: string };
function nameOf(member: RosterMember) {
  const profile = Array.isArray(member.profiles) ? member.profiles[0] : member.profiles;
  return profile?.full_name || "Unnamed member";
}
export default async function RosterPage({ params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  const context = await requireRosterManager(teamId).catch(() => null);
  if (!context) redirect("/");
  let members: RosterMember[] = [], invitations: PendingInvitation[] = [], familyInvitations: FamilyInvitation[] = [], durableAthletes: DurableAthlete[] = [], managedAthletes: DurableAthlete[] = [];
  let failed = false;
  try {
    [members, invitations, familyInvitations, durableAthletes, managedAthletes] = await Promise.all([
      loadRoster(context),
      readAllRows<PendingInvitation>((from, to) => context.supabase.from("team_invitations")
        .select("id, invited_email, role, status, created_at, expires_at").eq("team_id", teamId).eq("status", "pending").order("created_at").order("id").range(from, to)),
      readAllRows<FamilyInvitation>((from, to) => context.supabase.from("family_team_invitations")
        .select("id, invited_email, status, created_at, expires_at").eq("team_id", teamId).order("created_at").order("id").range(from, to)),
      loadDurableRoster(context),
      loadManagedAthletes(context),
    ]);
  } catch { failed = true; }
  return <main className="min-h-screen bg-slate-950 px-6 py-10 text-white"><div className="mx-auto max-w-5xl">
    <Link href={`/teams/${teamId}`} className="text-sm text-emerald-400">← Back to team dashboard</Link>
    <header className="my-8"><p className="text-sm font-semibold text-emerald-400">{context.team.name}</p><h1 className="mt-2 text-4xl font-bold">Roster</h1><p className="mt-3 text-slate-400">Manage members and share invitation links. No invitation emails are sent automatically.</p></header>
    <section className="mb-8 grid gap-4 md:grid-cols-2">
      {(["assistant_coach"] as const).filter((role) => canManageInvitation(context.managerRole, role)).map((role) => <div key={role} className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <h2 className="mb-4 text-xl font-semibold">Invite Assistant Coach</h2>
        <RosterActionForm action={createInvitation.bind(null, teamId, role)} label="Invite Assistant Coach" resetHref={`/teams/${teamId}/roster`}>
          <label className="block font-medium">Email address<input name="email" type="email" required maxLength={254} autoComplete="email" className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-white" /></label>
        </RosterActionForm>
      </div>)}
    </section>
    {failed ? <p role="alert" className="text-rose-300">Unable to load roster or invitations. Reload before managing this team.</p> : <>
      <section className="mb-8 rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <h2 className="text-2xl font-semibold">Invite a family</h2>
        <p className="mt-2 text-sm text-slate-400">Send a parent or guardian a link so they can choose the athlete joining this team. Use this for a new or family-managed athlete.</p>
        <p className="mt-2 text-sm text-slate-400">Direct athlete invitations are unavailable because team membership alone does not set up a training profile.</p>
        <div className="mt-5 max-w-xl"><FamilyInvitationActionForm action={createFamilyInvitation.bind(null, teamId)} label="Create family invitation" resetHref={`/teams/${teamId}/roster`}>
          <label className="block font-medium">Parent or guardian email<input name="email" type="email" required maxLength={254} autoComplete="email" className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-white" /></label>
        </FamilyInvitationActionForm></div>
        <div className="mt-8 border-t border-slate-800 pt-6"><h3 className="text-lg font-semibold">Family invitations</h3>
          {!familyInvitations.length ? <p className="mt-3 text-sm text-slate-400">No family invitations yet.</p> : <div className="mt-4 space-y-3">{familyInvitations.map((invitation) => {
            const status = familyInvitationStatus({ invitation_status: invitation.status, expires_at: invitation.expires_at });
            return <article key={invitation.id} className="rounded-xl border border-slate-700 bg-slate-950 p-4"><p className="font-medium">{invitation.invited_email}</p><p className="mt-1 text-sm capitalize text-slate-400">{status} · Expires {formatInvitationDate(invitation.expires_at)}</p>
              {status === "pending" && <div className="mt-3"><FamilyInvitationActionForm action={revokeFamilyInvitation.bind(null, teamId, invitation.id)} label="Revoke invitation" confirmation="Revoke this family invitation? The link will stop working." /></div>}
            </article>;
          })}</div>}
        </div>
      </section>
      <section className="mb-8 rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <h2 className="text-2xl font-semibold">Managed athletes</h2>
        <p className="mt-2 text-sm text-slate-400">Create an athlete without creating an account, then add them to a team you manage.</p>
        <div className="mt-5 grid gap-6 md:grid-cols-2">
          <RosterActionForm action={createManagedAthlete.bind(null, teamId)} label="Add athlete">
            <label className="block font-medium">First name<input name="firstName" required maxLength={199} autoComplete="given-name" className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-white" /></label>
            <label className="block font-medium">Last name<input name="lastName" required maxLength={199} autoComplete="family-name" className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-white" /></label>
            <label className="block font-medium">Graduation year<input name="graduationYear" required type="number" min="2000" max="2100" inputMode="numeric" className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-white" /></label>
          </RosterActionForm>
          <div>
            {!managedAthletes.length ? <p className="text-slate-400">No managed athletes yet.</p> : <div className="space-y-3">{managedAthletes.map((athlete) => {
              const onTeam = durableAthletes.some((rosterAthlete) => rosterAthlete.athleteId === athlete.athleteId);
              return <article key={athlete.athleteId} className="rounded-xl border border-slate-700 bg-slate-950 p-4"><p className="font-semibold">{athlete.displayName}</p>{athlete.graduationYear && <p className="mt-1 text-sm text-slate-400">Class of {athlete.graduationYear}</p>}{onTeam ? <p className="mt-3 text-sm text-slate-400">Already on this team</p> : <RosterActionForm action={addManagedAthleteToTeam.bind(null, teamId)} label="Add to team"><input type="hidden" name="athleteId" value={athlete.athleteId} /></RosterActionForm>}</article>;
            })}</div>}
          </div>
        </div>
      </section>
      <section className="mb-8"><h2 className="mb-4 text-2xl font-semibold">Athletes</h2>
        {!durableAthletes.length ? <p className="text-slate-400">No athletes on this team.</p> : <div className="space-y-4">{durableAthletes.map((athlete) => <article key={athlete.athleteId} className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-6"><div><h3 className="text-xl font-semibold">{athlete.displayName}</h3>{athlete.graduationYear && <p className="mt-2 text-sm text-slate-400">Class of {athlete.graduationYear}</p>}</div></article>)}</div>}
      </section>
      {[["assistant_coach", "Assistant Coaches"], ["coach", "Coaches"]].map(([role, title]) => {
        const group = members.filter((member) => member.role === role).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
        return <section key={role} className="mb-8"><h2 className="mb-4 text-2xl font-semibold">{title}</h2>
          {!group.length ? <p className="text-slate-400">No {title.toLowerCase()} on this team.</p> : <div className="space-y-4">{group.map((member) => <article key={member.id} className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <div><h3 className="text-xl font-semibold">{nameOf(member)}</h3><p className="mt-2 text-sm capitalize text-slate-400">{role.replace("_", " ")}</p></div>
          </article>)}</div>}
        </section>;
      })}
      <section><h2 className="mb-4 text-2xl font-semibold">Pending Invitations</h2>
        <p className="mb-4 text-sm text-slate-400">Old invitation URLs cannot be reconstructed. Revoke a pending or expired link before creating a replacement.</p>
        {!invitations.length ? <p className="text-slate-400">No pending invitations.</p> : <div className="space-y-4">{invitations.map((invitation) => <article key={invitation.id} className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <h3 className="font-semibold">{invitation.invited_email}</h3><p className="mt-2 capitalize text-slate-400">{invitation.role.replace("_", " ")} · {effectiveInvitationStatus(invitation.status, invitation.expires_at)}</p>
          <p className="my-3 text-sm text-slate-400">Invited {formatInvitationDate(invitation.created_at)} · Expires {formatInvitationDate(invitation.expires_at)}</p>
          {invitation.role === "athlete" && <p className="my-3 text-sm text-slate-400">This legacy invitation adds team membership only; it does not set up training.</p>}
          {canManageInvitation(context.managerRole, invitation.role) && <RosterActionForm action={revokeInvitation.bind(null, teamId, invitation.id)} label="Revoke Invitation" confirmation="Revoke this invitation? The link will stop working." />}
        </article>)}</div>}
      </section>
    </>}
  </div></main>;
}
