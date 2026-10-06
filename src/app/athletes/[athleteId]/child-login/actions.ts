"use server";

import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import type { FamilyInvitationActionState } from "@/components/family-invitation-action-form";
import {
  childLoginInvitationError,
  childLoginInvitationPath,
  normalizeChildLoginInvitationEmail,
  parseChildLoginInvitationCreate,
} from "@/lib/child-login-invitations";
import { attemptCreatedInvitationDelivery, deliveryRequestMessage } from "@/lib/invitation-delivery-boundary";
import { loadMyFamilyAthleteContexts } from "@/lib/my-athlete-contexts-server";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/training-assignment";

function childLoginPath(athleteId: string) {
  return `/athletes/${encodeURIComponent(athleteId)}/child-login`;
}

function reviewRequired(): FamilyInvitationActionState {
  return { status: "review_required", message: childLoginInvitationError() };
}

function definitelyRejected(status: number | undefined) {
  return status !== undefined && status >= 400 && status < 500 && status !== 408;
}

function rejectedMessage(message: string | undefined) {
  if (message === "Athlete self claim is unavailable") return "This athlete already has self-login history and cannot receive a new login invitation.";
  if (message === "A pending child login invitation already exists") return "There is already an active child login invitation. Review or revoke it before creating another.";
  if (message === "Child login invitation is invalid") return "Enter a valid email address.";
  return "You no longer have permission to manage login invitations for this athlete.";
}

async function requireChildLoginManager(athleteId: string) {
  if (!isUuid(athleteId)) throw new Error("This athlete is unavailable.");
  const context = (await loadMyFamilyAthleteContexts()).find((candidate) => candidate.athleteId === athleteId && candidate.canManage);
  if (!context) throw new Error("You no longer have permission to manage login invitations for this athlete.");
  return context;
}

export async function createChildLoginInvitation(athleteId: string, state: FamilyInvitationActionState, data: FormData): Promise<FamilyInvitationActionState> {
  if (state.status === "success" || state.status === "review_required") return state;
  let writing = false;
  try {
    await requireChildLoginManager(athleteId);
    const email = normalizeChildLoginInvitationEmail(data.get("email"));
    const token = randomBytes(48).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const supabase = await createClient();
    writing = true;
    const { data: created, error, status } = await supabase.rpc("create_child_login_invitation", {
      p_athlete_id: athleteId,
      p_invited_email: email,
      p_token_hash: tokenHash,
    });
    const result = error ? null : parseChildLoginInvitationCreate(created);
    if (!result) {
      return error && definitelyRejected(status)
        ? { status: "error", message: rejectedMessage(error.message) }
        : reviewRequired();
    }
    const invitationPath = childLoginInvitationPath(token);
    const delivery = await attemptCreatedInvitationDelivery({ kind: "child_self_login", invitationId: result.invitation_id, invitationPath, expiresAt: result.expires_at });
    revalidatePath(childLoginPath(athleteId));
    return {
      status: "success",
      message: `Child self-login invitation created. ${deliveryRequestMessage(delivery)}`,
      invitationPath,
      email,
      expiresAt: result.expires_at,
    };
  } catch (cause) {
    if (writing) return reviewRequired();
    return {
      status: "error",
      message: cause instanceof Error && ["Enter a valid email address.", "This athlete is unavailable."].includes(cause.message)
        ? cause.message
        : "You no longer have permission to manage login invitations for this athlete.",
    };
  }
}

export async function replaceChildLoginInvitation(athleteId: string, invitationId: string, state: FamilyInvitationActionState, data: FormData): Promise<FamilyInvitationActionState> {
  if (state.status === "success" || state.status === "review_required") return state;
  let writing = false;
  try {
    await requireChildLoginManager(athleteId);
    if (!isUuid(invitationId)) return { status: "error", message: "This invitation is unavailable." };
    const email = normalizeChildLoginInvitationEmail(data.get("email"));
    const token = randomBytes(48).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const supabase = await createClient();
    writing = true;
    const { data: created, error, status } = await supabase.rpc("replace_child_login_invitation", {
      p_invitation_id: invitationId, p_invited_email: email, p_token_hash: tokenHash,
    });
    const result = error ? null : parseChildLoginInvitationCreate(created);
    if (!result) return error && definitelyRejected(status)
      ? { status: "error", message: rejectedMessage(error.message) }
      : reviewRequired();
    const invitationPath = childLoginInvitationPath(token);
    const delivery = await attemptCreatedInvitationDelivery({ kind: "child_self_login", invitationId: result.invitation_id, invitationPath, expiresAt: result.expires_at });
    revalidatePath(childLoginPath(athleteId));
    return { status: "success", message: `The old invitation was revoked and a new link was created. ${deliveryRequestMessage(delivery)}`, invitationPath, email, expiresAt: result.expires_at };
  } catch (cause) {
    if (writing) return reviewRequired();
    return { status: "error", message: cause instanceof Error && cause.message === "Enter a valid email address." ? cause.message : "You no longer have permission to manage login invitations for this athlete." };
  }
}

export async function revokeChildLoginInvitation(athleteId: string, invitationId: string, state: FamilyInvitationActionState): Promise<FamilyInvitationActionState> {
  if (state.status === "success" || state.status === "review_required") return state;
  let writing = false;
  try {
    await requireChildLoginManager(athleteId);
    if (!isUuid(invitationId)) return { status: "error", message: "This invitation is unavailable." };
    const supabase = await createClient();
    writing = true;
    const { error, status } = await supabase.rpc("revoke_child_login_invitation", { p_invitation_id: invitationId });
    if (error) return definitelyRejected(status)
      ? { status: "error", message: rejectedMessage(error.message) }
      : reviewRequired();
    revalidatePath(childLoginPath(athleteId));
    return { status: "success", message: "Child login invitation revoked." };
  } catch {
    return writing ? reviewRequired() : { status: "error", message: "You no longer have permission to manage login invitations for this athlete." };
  }
}
