import "server-only";
import { createClient } from "@/lib/supabase/server";
import { isUuid, readAllRows } from "@/lib/training-assignment";
import { PLAN_COLUMNS } from "@/lib/training-plans-server";
import { isPublicTemplate, type Plan, type PlanWorkout } from "@/lib/training-plans";

export async function requirePlatformAdmin() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error("Please sign in as a platform admin.");
  const { data: profile, error: profileError } = await supabase.from("profiles").select("platform_role").eq("id", user.id).single();
  if (profileError || profile?.platform_role !== "admin") throw new Error("Platform admin access is required.");
  return { supabase, user };
}
export async function requireAdminTemplate(context: Awaited<ReturnType<typeof requirePlatformAdmin>>, templateId: string): Promise<Plan> {
  if (!isUuid(templateId)) throw new Error("Invalid template.");
  const { data, error } = await context.supabase.from("training_plans").select(PLAN_COLUMNS).eq("id", templateId).eq("kind", "template").single();
  if (error || !data || !isPublicTemplate(data) || data.team_id !== null) throw new Error("This master template is unavailable.");
  return data as Plan;
}
export async function loadAdminTemplateWorkouts(context: Awaited<ReturnType<typeof requirePlatformAdmin>>) {
  // Public visibility is required for reusable master content. Entitlement gates
  // remain on each workout; authoring does not remove or assume free access.
  return readAllRows<PlanWorkout>((from, to) => context.supabase.from("workouts")
    .select("id, name, description, difficulty, visibility, owner_user_id, team_id, requires_entitlement")
    .eq("visibility", "public").order("name").order("id").range(from, to));
}
