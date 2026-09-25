"use server";

import { redirect } from "next/navigation";
import { childLoginInvitationLoginPath, isChildLoginInvitationToken, parseChildLoginInvitationAcceptance } from "@/lib/child-login-invitations";
import { createClient } from "@/lib/supabase/server";
import type { RosterState } from "@/lib/team-invitations";

export type ChildLoginInvitationAcceptanceState = {
  status: "idle" | "error" | "review_required";
  message: string;
};

function reviewRequired(): ChildLoginInvitationAcceptanceState {
  return { status: "review_required", message: "We could not confirm this child login invitation. Refresh and review your dashboard before trying again." };
}

export async function switchChildLoginInvitationAccount(token: string, state: RosterState): Promise<RosterState> {
  void state;
  if (!isChildLoginInvitationToken(token)) return { status: "error", message: "This invitation is unavailable." };
  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signOut();
    if (error) return { status: "error", message: "Unable to sign out. Reload and try again." };
  } catch { return { status: "error", message: "Unable to sign out. Reload and try again." }; }
  redirect(childLoginInvitationLoginPath(token));
}

export async function acceptChildLoginInvitation(token: string, state: ChildLoginInvitationAcceptanceState, formData: FormData): Promise<ChildLoginInvitationAcceptanceState> {
  void formData;
  if (state.status === "review_required") return state;
  if (!isChildLoginInvitationToken(token)) return { status: "error", message: "This invitation is unavailable." };
  let invoked = false;
  let acceptedAthleteId: string | null = null;
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return { status: "error", message: "Sign in with the invited account." };
    invoked = true;
    const { data, error } = await supabase.rpc("accept_child_login_invitation", { p_invitation_token: token });
    if (error) return { status: "error", message: "This invitation is unavailable." };
    const result = parseChildLoginInvitationAcceptance(data);
    if (!result) return reviewRequired();
    acceptedAthleteId = result.athlete_id;
  } catch {
    return invoked ? reviewRequired() : { status: "error", message: "Sign in with the invited account." };
  }
  if (!acceptedAthleteId) return reviewRequired();
  redirect(`/?athlete=${encodeURIComponent(acceptedAthleteId)}`);
}
