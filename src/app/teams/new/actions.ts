"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { readTeamName, type TeamCreationState } from "@/lib/team-creation";

export async function createTeam(state: TeamCreationState, formData: FormData): Promise<TeamCreationState> {
  if (state.status === "review_required") return state;
  const teamId = randomUUID();
  let writeStarted = false;
  const review = (): TeamCreationState => {
    revalidatePath("/");
    return {
      status: "review_required",
      teamUrl: `/teams/${teamId}`,
      message: "Team creation could not be confirmed. Check your dashboard and this team before trying again. If the team is unavailable, ask an administrator to review this attempt; retrying could create another team.",
    };
  };

  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return { status: "error", message: "Please sign in before creating a team." };
    let name: string;
    try { name = readTeamName(formData.get("name")); }
    catch (cause) { return { status: "error", message: cause instanceof Error ? cause.message : "Enter a valid team name." }; }

    // The existing on_team_created trigger creates the coach membership atomically.
    // If that trigger fails, this entire insert rolls back. Do not insert it again.
    writeStarted = true;
    const { error, status } = await supabase.from("teams").insert({
      id: teamId, name, created_by_user_id: user.id,
    });
    if (error) {
      if (status >= 400 && status < 500 && status !== 408) return {
        status: "error", message: "Team creation was rejected. No team or coach membership was created. Reload before trying again.",
      };
      return review();
    }

    const [teamResult, membershipResult] = await Promise.all([
      supabase.from("teams").select("id, created_by_user_id").eq("id", teamId).eq("created_by_user_id", user.id).single(),
      supabase.from("team_memberships").select("role, created_by_user_id")
        .eq("team_id", teamId).eq("user_id", user.id).single(),
    ]);
    if (teamResult.error || !teamResult.data || teamResult.data.id !== teamId || teamResult.data.created_by_user_id !== user.id ||
        membershipResult.error || !membershipResult.data || membershipResult.data.role !== "coach" || membershipResult.data.created_by_user_id !== user.id) {
      // The write committed, or may have committed. Never delete or retry blindly.
      return review();
    }
  } catch {
    if (writeStarted) return review();
    return { status: "error", message: "Unable to create a team. Please reload and try again." };
  }

  revalidatePath("/");
  revalidatePath(`/teams/${teamId}`);
  redirect(`/teams/${teamId}`);
}
