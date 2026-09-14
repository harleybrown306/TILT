"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function createGroup(formData: FormData) {
  const teamId = String(formData.get("teamId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const category = String(formData.get("category") ?? "custom").trim();
  const description = String(formData.get("description") ?? "").trim();

  if (!teamId || !name) {
    throw new Error("Team and group name are required.");
  }

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

  if (membershipError || !membership) {
    throw new Error("You are not a member of this team.");
  }

  if (!["coach", "assistant_coach"].includes(membership.role)) {
    throw new Error("You do not have permission to create groups.");
  }

  const { error } = await supabase.from("team_groups").insert({
    team_id: teamId,
    name,
    category,
    description: description || null,
    created_by_user_id: user.id,
  });

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath(`/teams/${teamId}/groups`);
}