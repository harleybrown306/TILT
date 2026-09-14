"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/training-assignment";
import { invitationError, invitationLoginPath, isInvitationToken, type RosterState } from "@/lib/team-invitations";

export async function acceptInvitation(token: string, state: RosterState): Promise<RosterState> {
  if (state.status === "review_required") return state;
  if (!isInvitationToken(token)) return { status: "error", message: "This invitation is invalid or unavailable." };
  let destination = "/";
  let writing = false;
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return { status: "error", message: "Please sign in with the account associated with this invitation." };
    writing = true;
    // The existing authenticated RPC owns validation and atomic membership creation.
    const { data, error, status } = await supabase.rpc("accept_team_invitation", { invitation_token: token });
    if (error) {
      if (status >= 400 && status < 500 && status !== 408) return { status: "error", message: invitationError(error.message) };
      return { status: "review_required", message: "Acceptance could not be confirmed. Check your dashboard before trying again; ask the coach to review the invitation if it is unclear." };
    }
    const result = data?.[0];
    if (!result || !isUuid(result.team_id) || !isUuid(result.membership_id) || !["athlete", "assistant_coach"].includes(result.membership_role)) return { status: "review_required", message: "Acceptance could not be confirmed. Check your dashboard and ask the coach to review this invitation." };
    revalidatePath(`/teams/${result.team_id}`);
    revalidatePath(`/teams/${result.team_id}/roster`);
    revalidatePath(`/teams/${result.team_id}/groups`);
    revalidatePath(`/teams/${result.team_id}/assign`);
    destination = result.membership_role === "assistant_coach" ? `/teams/${result.team_id}` : "/";
  } catch {
    return { status: writing ? "review_required" : "error", message: "Acceptance could not be confirmed. Check your dashboard and the invitation status before trying again." };
  }
  revalidatePath("/");
  redirect(destination);
}

export async function switchInvitationAccount(token: string, state: RosterState): Promise<RosterState> {
  void state;
  if (!isInvitationToken(token)) redirect("/login");
  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signOut();
    if (error) return { status: "error", message: "Unable to sign out. Reload and try again." };
  } catch { return { status: "error", message: "Unable to sign out. Reload and try again." }; }
  redirect(invitationLoginPath(token));
}
