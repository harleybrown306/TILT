"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

async function requireCoachAccess(teamId: string) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: membership, error: membershipError } = await supabase
    .from("team_memberships")
    .select("role")
    .eq("team_id", teamId)
    .eq("user_id", user.id)
    .single();

  if (
    membershipError ||
    !membership ||
    !["coach", "assistant_coach"].includes(membership.role)
  ) {
    throw new Error("You do not have permission to manage this group.");
  }

  return {
    supabase,
    user,
  };
}

export async function addAthleteToGroup(formData: FormData) {
  const teamId = String(formData.get("teamId") ?? "");
  const groupId = String(formData.get("groupId") ?? "");
  const athleteUserId = String(
    formData.get("athleteUserId") ?? ""
  );

  if (!teamId || !groupId || !athleteUserId) {
    throw new Error("Missing required group membership information.");
  }

  const { supabase, user } = await requireCoachAccess(teamId);

  const { data: athleteMembership, error: athleteError } =
    await supabase
      .from("team_memberships")
      .select("id")
      .eq("team_id", teamId)
      .eq("user_id", athleteUserId)
      .eq("role", "athlete")
      .single();

  if (athleteError || !athleteMembership) {
    throw new Error("This user is not an athlete on this team.");
  }

  const { data: group, error: groupError } = await supabase
    .from("team_groups")
    .select("id")
    .eq("id", groupId)
    .eq("team_id", teamId)
    .single();

  if (groupError || !group) {
    throw new Error("This group does not belong to this team.");
  }

  const { error } = await supabase
    .from("team_group_memberships")
    .insert({
      team_group_id: groupId,
      athlete_user_id: athleteUserId,
      created_by_user_id: user.id,
    });

  if (error && error.code !== "23505") {
    throw new Error(error.message);
  }

  revalidatePath(`/teams/${teamId}/groups/${groupId}`);
  revalidatePath(`/teams/${teamId}/groups`);
}

export async function removeAthleteFromGroup(formData: FormData) {
  const teamId = String(formData.get("teamId") ?? "");
  const groupId = String(formData.get("groupId") ?? "");
  const athleteUserId = String(
    formData.get("athleteUserId") ?? ""
  );

  if (!teamId || !groupId || !athleteUserId) {
    throw new Error("Missing required group membership information.");
  }

  const { supabase } = await requireCoachAccess(teamId);

  const { data: group, error: groupError } = await supabase
    .from("team_groups")
    .select("id")
    .eq("id", groupId)
    .eq("team_id", teamId)
    .single();

  if (groupError || !group) {
    throw new Error("This group does not belong to this team.");
  }

  const { error } = await supabase
    .from("team_group_memberships")
    .delete()
    .eq("team_group_id", groupId)
    .eq("athlete_user_id", athleteUserId);

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath(`/teams/${teamId}/groups/${groupId}`);
  revalidatePath(`/teams/${teamId}/groups`);
}