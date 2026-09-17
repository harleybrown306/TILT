import "server-only";
import { createClient } from "@/lib/supabase/server";
import { isUuid, readAllRows } from "@/lib/training-assignment";

export type RosterMember = {
  id: string; profile_id: string; role: string;
  profiles: { full_name: string | null } | { full_name: string | null }[] | null;
};
export type DurableAthlete = {
  athleteId: string;
  displayName: string;
  graduationYear: number | null;
  status: string;
};

type AthleteRow = { id: string; display_name: string; graduation_year: number | null; status: string };
type RosterIdentityRow = { athlete_id: string; display_name: string; graduation_year: number | null; status: string };
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
  return readAllRows<RosterMember>((from, to) => context.supabase.from("team_staff_memberships")
    .select("id, profile_id, role, profiles!team_staff_memberships_profile_id_fkey(full_name)")
    .eq("team_id", context.team.id).order("id").range(from, to));
}

function normalizeAthletes(rows: AthleteRow[]): DurableAthlete[] {
  return rows.map((athlete) => ({
    athleteId: athlete.id,
    displayName: athlete.display_name,
    graduationYear: athlete.graduation_year,
    status: athlete.status,
  })).sort((a, b) => a.displayName.localeCompare(b.displayName) || a.athleteId.localeCompare(b.athleteId));
}

export async function loadDurableRoster(context: Awaited<ReturnType<typeof requireRosterManager>>) {
  const { data, error } = await context.supabase.rpc("list_my_team_rostered_athlete_identities", {
    p_team_id: context.team.id,
  });
  if (error) throw new Error("Unable to load the durable team roster.");
  const identities = (data ?? []) as RosterIdentityRow[];
  return identities.map((athlete) => ({
    athleteId: athlete.athlete_id,
    displayName: athlete.display_name,
    graduationYear: athlete.graduation_year,
    status: athlete.status,
  })).sort((a, b) => a.displayName.localeCompare(b.displayName) || a.athleteId.localeCompare(b.athleteId));
}

export async function loadManagedAthletes(context: Awaited<ReturnType<typeof requireRosterManager>>) {
  const relationships = await readAllRows<{ athlete_id: string }>((from, to) => context.supabase
    .from("athlete_profile_relationships")
    .select("athlete_id")
    .eq("profile_id", context.user.id)
    .eq("manage_permission", true)
    .is("revoked_at", null)
    .order("athlete_id")
    .range(from, to));
  const athleteIds = [...new Set(relationships.map((relationship) => relationship.athlete_id))];
  if (!athleteIds.length) return [];
  const athletes = await readAllRows<AthleteRow>((from, to) => context.supabase
    .from("athletes")
    .select("id, display_name, graduation_year, status")
    .in("id", athleteIds)
    .eq("status", "active")
    .order("display_name")
    .order("id")
    .range(from, to));
  return normalizeAthletes(athletes);
}
