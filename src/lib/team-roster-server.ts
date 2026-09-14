import "server-only";
import { createClient } from "@/lib/supabase/server";
import { isUuid, readAllRows } from "@/lib/training-assignment";

export type RosterMember = {
  id: string; user_id: string; role: string;
  profiles: { full_name: string | null } | { full_name: string | null }[] | null;
};
export async function requireRosterManager(teamId: string) {
  if (!isUuid(teamId)) throw new Error("Invalid team.");
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error("Please sign in to manage the roster.");
  const { data: membership, error: membershipError } = await supabase.from("team_memberships")
    .select("role").eq("team_id", teamId).eq("user_id", user.id).single();
  if (membershipError || !membership || !["coach", "assistant_coach"].includes(membership.role)) throw new Error("You do not have permission to manage this roster.");
  const { data: team, error: teamError } = await supabase.from("teams").select("id, name, created_by_user_id").eq("id", teamId).single();
  if (teamError || !team) throw new Error("This team is unavailable.");
  return { supabase, user, managerRole: membership.role as string, team };
}
export async function loadRoster(context: Awaited<ReturnType<typeof requireRosterManager>>) {
  return readAllRows<RosterMember>((from, to) => context.supabase.from("team_memberships")
    .select("id, user_id, role, profiles!team_memberships_user_id_fkey(full_name)")
    .eq("team_id", context.team.id).order("id").range(from, to));
}
