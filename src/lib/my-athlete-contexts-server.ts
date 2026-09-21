import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type FamilyAthleteContext = {
  athleteId: string;
  displayName: string;
  graduationYear: number | null;
  relationshipRole: "self" | "guardian";
  canManage: boolean;
  canAct: boolean;
};

export type AthleteContextResolution =
  | { status: "selected"; context: FamilyAthleteContext }
  | { status: "none" }
  | { status: "unauthorized_request"; requestedAthleteId: string }
  | { status: "ambiguous_context"; athleteId: string };

type RelationshipRow = {
  athlete_id: string;
  role: "self" | "guardian";
  training_permission: boolean;
  manage_permission: boolean;
  athletes: { id: string; display_name: string; graduation_year: number | null }
    | { id: string; display_name: string; graduation_year: number | null }[]
    | null;
};

function one<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function compareContexts(first: FamilyAthleteContext, second: FamilyAthleteContext) {
  const roleOrder = (role: FamilyAthleteContext["relationshipRole"]) => role === "self" ? 0 : 1;
  return roleOrder(first.relationshipRole) - roleOrder(second.relationshipRole)
    || first.displayName.localeCompare(second.displayName)
    || first.athleteId.localeCompare(second.athleteId);
}

function duplicateAthleteId(contexts: readonly FamilyAthleteContext[]) {
  const seen = new Set<string>();
  for (const context of contexts) {
    if (seen.has(context.athleteId)) return context.athleteId;
    seen.add(context.athleteId);
  }
  return null;
}

/**
 * Resolves only an already-authorized family context. With no explicit request,
 * the sole self context wins; otherwise contexts sort self-before-guardian,
 * then by display name and durable athlete ID. Duplicate durable identities and
 * explicit unknown IDs fail closed rather than falling back.
 */
export function resolveActiveAthleteContext(
  contexts: readonly FamilyAthleteContext[],
  requestedAthleteId?: string,
): AthleteContextResolution {
  const ordered = [...contexts].sort(compareContexts);
  const duplicate = duplicateAthleteId(ordered);
  if (duplicate) return { status: "ambiguous_context", athleteId: duplicate };
  if (requestedAthleteId !== undefined) {
    const context = ordered.find((candidate) => candidate.athleteId === requestedAthleteId);
    return context
      ? { status: "selected", context }
      : { status: "unauthorized_request", requestedAthleteId };
  }

  const selves = ordered.filter((context) => context.relationshipRole === "self");
  if (selves.length === 1) return { status: "selected", context: selves[0] };
  return ordered[0] ? { status: "selected", context: ordered[0] } : { status: "none" };
}

/**
 * Lists only the authenticated profile's active self/guardian relationships.
 * Coach, staff, and platform-admin authority is deliberately not a family
 * athlete context and this function accepts no caller identity parameter.
 */
export async function loadMyFamilyAthleteContexts(): Promise<FamilyAthleteContext[]> {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) redirect("/login");

  const { data, error } = await supabase
    .from("athlete_profile_relationships")
    .select("athlete_id,role,training_permission,manage_permission,athletes!inner(id,display_name,graduation_year)")
    .eq("profile_id", user.id)
    .in("role", ["self", "guardian"])
    .is("revoked_at", null);
  if (error) throw new Error("Unable to load family athlete contexts.");

  return ((data ?? []) as RelationshipRow[])
    .flatMap((relationship) => {
      const athlete = one(relationship.athletes);
      return athlete ? [{
      athleteId: relationship.athlete_id,
      displayName: athlete.display_name,
      graduationYear: athlete.graduation_year,
      relationshipRole: relationship.role,
      canManage: relationship.manage_permission,
      canAct: relationship.training_permission,
      }] : [];
    })
    .sort(compareContexts);
}
