"use server";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { isUuid } from "@/lib/training-assignment";
import { canManageInvitation, canRemoveMember, normalizeInvitationEmail, type InvitationRole, type RosterState } from "@/lib/team-invitations";
import { requireRosterManager } from "@/lib/team-roster-server";

function failure(cause: unknown): RosterState {
  return { status: "error", message: cause instanceof Error ? cause.message : "Unable to manage the roster. Reload and try again." };
}
function invalidate(teamId: string) {
  revalidatePath(`/teams/${teamId}`);
  revalidatePath(`/teams/${teamId}/roster`);
  revalidatePath(`/teams/${teamId}/groups`);
  revalidatePath(`/teams/${teamId}/assign`);
  revalidatePath("/");
}
const uncertain = (): RosterState => ({ status: "review_required", message: "The change could not be confirmed. Reload and review the roster/invitations before trying again; ask an administrator if it is unclear." });
function definiteRejection(status: number) { return status >= 400 && status < 500 && status !== 408; }

export async function createInvitation(teamId: string, role: InvitationRole, state: RosterState, data: FormData): Promise<RosterState> {
  if (state.status === "success" || state.status === "review_required") return state;
  let writing = false;
  try {
    const context = await requireRosterManager(teamId);
    if (!canManageInvitation(context.managerRole, role)) throw new Error("You do not have permission to invite this role.");
    const email = normalizeInvitationEmail(data.get("email"));
    if (email === context.user.email?.toLowerCase()) throw new Error("You are already a member of this team.");
    const { data: pending, error: pendingError } = await context.supabase.from("team_invitations")
      .select("id").eq("team_id", teamId).eq("invited_email", email).eq("role", role).eq("status", "pending");
    if (pendingError) throw new Error("Unable to check pending invitations. Reload before inviting.");
    if (pending?.length) throw new Error("An equivalent pending invitation already exists. Revoke it before creating a replacement, including if its expiration has passed.");
    const token = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
    writing = true;
    const { error, status } = await context.supabase.from("team_invitations").insert({
      id: randomUUID(), team_id: teamId, invited_email: email, role, invited_by_user_id: context.user.id,
      token_hash: tokenHash, status: "pending", expires_at: expiresAt,
    });
    if (error) {
      if (!definiteRejection(status)) return uncertain();
      return failure(new Error(error.code === "23505" ? "An equivalent pending invitation already exists. Reload to review it." : "The invitation was rejected. No invitation was created."));
    }
    invalidate(teamId);
    return { status: "success", message: "Invitation created. Copy the link now; it cannot be reconstructed later.", invitationPath: `/invite/${token}`, email, role, expiresAt };
  } catch (cause) { return writing ? uncertain() : failure(cause); }
}

export async function revokeInvitation(teamId: string, invitationId: string, state: RosterState): Promise<RosterState> {
  if (state.status === "review_required") return state;
  let writing = false;
  try {
    const context = await requireRosterManager(teamId);
    if (!isUuid(invitationId)) throw new Error("Invalid invitation.");
    const { data: invitation, error } = await context.supabase.from("team_invitations")
      .select("id, role, status").eq("id", invitationId).eq("team_id", teamId).single();
    if (error || !invitation || invitation.status !== "pending") throw new Error("Only pending invitations on this team can be revoked.");
    if (!canManageInvitation(context.managerRole, invitation.role)) throw new Error("You do not have permission to revoke this invitation.");
    writing = true;
    const { data: changed, error: updateError, status } = await context.supabase.from("team_invitations")
      .update({ status: "revoked", revoked_at: new Date().toISOString() }).eq("id", invitationId).eq("team_id", teamId).eq("role", invitation.role).eq("status", "pending").select("id");
    if (updateError && !definiteRejection(status)) return uncertain();
    if (updateError || changed?.length !== 1) return failure(new Error("Invitation not revoked. Reload to check its current status."));
    invalidate(teamId);
    return { status: "success", message: "Invitation revoked. Its history is retained." };
  } catch (cause) { return writing ? uncertain() : failure(cause); }
}

export async function removeMember(teamId: string, membershipId: string, state: RosterState): Promise<RosterState> {
  if (state.status === "review_required") return state;
  let writing = false;
  try {
    const context = await requireRosterManager(teamId);
    if (!isUuid(membershipId)) throw new Error("Invalid membership.");
    const { data: target, error } = await context.supabase.from("team_memberships")
      .select("id, user_id, role").eq("id", membershipId).eq("team_id", teamId).single();
    if (error || !target) throw new Error("This membership is unavailable on this team.");
    if (!canRemoveMember(context.managerRole, target, context.user.id, context.team.created_by_user_id)) throw new Error("This member cannot be removed by you. Coaches, the team creator, and your own membership are protected.");
    writing = true;
    const { data: removed, error: deleteError, status } = await context.supabase.from("team_memberships").delete()
      .eq("id", membershipId).eq("team_id", teamId).eq("user_id", target.user_id).eq("role", target.role).select("id");
    if (deleteError && !definiteRejection(status)) return uncertain();
    if (deleteError || removed?.length !== 1) return failure(new Error("Membership not removed. Reload to check the roster."));
    invalidate(teamId);
    return { status: "success", message: "Member removed from this team. Other memberships and training history are unchanged." };
  } catch (cause) { return writing ? uncertain() : failure(cause); }
}
