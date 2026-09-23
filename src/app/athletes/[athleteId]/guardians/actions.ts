"use server";

import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import type { FamilyInvitationActionState } from "@/components/family-invitation-action-form";
import { guardianInvitationError, guardianInvitationPath, normalizeGuardianInvitationEmail, parseGuardianInvitationCreate } from "@/lib/guardian-invitations";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/training-assignment";

function reviewRequired(): FamilyInvitationActionState {
  return { status: "review_required", message: guardianInvitationError() };
}

function definitelyRejected(status: number | undefined) {
  return status !== undefined && status >= 400 && status < 500 && status !== 408;
}

function guardianPath(athleteId: string) {
  return `/athletes/${encodeURIComponent(athleteId)}/guardians`;
}

export async function createGuardianInvitation(athleteId: string, state: FamilyInvitationActionState, data: FormData): Promise<FamilyInvitationActionState> {
  if (state.status === "success" || state.status === "review_required") return state;
  let writing = false;
  try {
    if (!isUuid(athleteId)) return { status: "error", message: "This athlete is unavailable." };
    const email = normalizeGuardianInvitationEmail(data.get("email"));
    const token = randomBytes(48).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return { status: "error", message: "Sign in before managing guardians." };
    writing = true;
    const { data: created, error, status } = await supabase.rpc("create_guardian_invitation", {
      p_athlete_id: athleteId,
      p_invited_email: email,
      p_token_hash: tokenHash,
      p_expires_at: expiresAt,
    });
    const result = error ? null : parseGuardianInvitationCreate(created);
    if (!result) {
      return error && definitelyRejected(status)
        ? { status: "error", message: guardianInvitationError() }
        : reviewRequired();
    }
    revalidatePath(guardianPath(athleteId));
    return { status: "success", message: "Guardian invitation created. Copy the link now; it cannot be reconstructed later.", invitationPath: guardianInvitationPath(token), email, expiresAt: result.expires_at };
  } catch (cause) {
    if (writing) return reviewRequired();
    return { status: "error", message: cause instanceof Error && cause.message === "Enter a valid email address." ? cause.message : guardianInvitationError() };
  }
}

export async function revokeGuardianInvitation(athleteId: string, invitationId: string, state: FamilyInvitationActionState): Promise<FamilyInvitationActionState> {
  if (state.status === "success" || state.status === "review_required") return state;
  let writing = false;
  try {
    if (!isUuid(athleteId) || !isUuid(invitationId)) return { status: "error", message: "This invitation is unavailable." };
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return { status: "error", message: "Sign in before managing guardians." };
    writing = true;
    const { error, status } = await supabase.rpc("revoke_guardian_invitation", { p_invitation_id: invitationId });
    if (error) return definitelyRejected(status)
      ? { status: "error", message: "This guardian invitation could not be revoked. Reload and review the invitation list." }
      : reviewRequired();
    revalidatePath(guardianPath(athleteId));
    return { status: "success", message: "Guardian invitation revoked." };
  } catch {
    return writing ? reviewRequired() : { status: "error", message: "This guardian invitation could not be revoked. Reload and review the invitation list." };
  }
}
