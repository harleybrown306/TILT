import "server-only";
import { createClient } from "@/lib/supabase/server";
import { isUuid, readAllRows } from "@/lib/training-assignment";
import { isOwnedCoachPlan, isPublishedTemplate, isWorkoutUsable, type Plan, type PlanItem, type PlanWorkout } from "@/lib/training-plans";

export const PLAN_COLUMNS = "id, team_id, owner_user_id, name, description, status, kind, visibility, source_template_id, archived_at, created_at, updated_at";

export async function requirePlanCoach(teamId: string) {
  if (!isUuid(teamId)) throw new Error("Invalid team.");
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error("Please sign in to manage training plans.");
  const { data: membership, error: membershipError } = await supabase.from("team_memberships")
    .select("role").eq("team_id", teamId).eq("user_id", user.id).single();
  if (membershipError || !membership || !["coach", "assistant_coach"].includes(membership.role)) {
    throw new Error("You do not have coaching permission for this team context.");
  }
  return { supabase, user };
}

export type PlanContext = Awaited<ReturnType<typeof requirePlanCoach>>;
export async function requireReadablePlan(context: PlanContext, planId: string): Promise<Plan> {
  if (!isUuid(planId)) throw new Error("Invalid training plan.");
  const { data, error } = await context.supabase.from("training_plans")
    .select(PLAN_COLUMNS).eq("id", planId).single();
  if (error || !data || (!isOwnedCoachPlan(data, context.user.id) && !isPublishedTemplate(data))) throw new Error("This training plan is unavailable in your library.");
  return data as Plan;
}

export async function requireCoachPlan(context: PlanContext, planId: string): Promise<Plan> {
  const plan = await requireReadablePlan(context, planId);
  if (!isOwnedCoachPlan(plan, context.user.id)) throw new Error("Only your own coach plans can be changed. Templates are read-only.");
  return plan;
}

export async function loadPlanItems(context: PlanContext, planId: string) {
  return readAllRows<PlanItem>((from, to) => context.supabase.from("training_plan_items")
    .select("id, training_plan_id, workout_id, day_offset, position, scheduled_time, notes, updated_at")
    .eq("training_plan_id", planId).order("id").range(from, to));
}

export async function loadPlanWorkouts(context: PlanContext) {
  const memberships = await readAllRows<{ team_id: string }>((from, to) => context.supabase.from("team_memberships")
    .select("team_id").eq("user_id", context.user.id).in("role", ["coach", "assistant_coach"]).order("id").range(from, to));
  const workouts = await readAllRows<PlanWorkout>((from, to) => context.supabase.from("workouts")
    .select("id, name, description, difficulty, visibility, owner_user_id, team_id, requires_entitlement")
    .order("name").order("id").range(from, to));
  const enabledFeatures = new Set<string>();
  if (workouts.some((workout) => workout.requires_entitlement)) {
    const now = Date.now();
    const entitlements = await readAllRows<{ plan_id: string; starts_at: string; ends_at: string | null }>((from, to) => context.supabase
      .from("user_entitlements").select("plan_id, starts_at, ends_at")
      .eq("user_id", context.user.id).eq("status", "active").order("id").range(from, to));
    const planIds = [...new Set(entitlements.filter((item) => new Date(item.starts_at).getTime() <= now && (!item.ends_at || new Date(item.ends_at).getTime() > now)).map((item) => item.plan_id))];
    if (planIds.length) {
      const features = await readAllRows<{ feature_key: string }>((from, to) => context.supabase.from("entitlement_plan_features")
        .select("feature_key").in("plan_id", planIds).eq("enabled", true).order("id").range(from, to));
      features.forEach((feature) => enabledFeatures.add(feature.feature_key));
    }
  }
  return workouts.filter((workout) => isWorkoutUsable(workout, memberships.map((membership) => membership.team_id), context.user.id, enabledFeatures));
}

// Serialize this app's mutations within a server process, including activation.
// This is not a cross-instance database lock; RLS and conditional writes still apply.
const planLocks = new Map<string, Promise<void>>();
export async function withPlanLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = planLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  planLocks.set(key, current);
  await previous;
  try { return await work(); }
  finally {
    release();
    if (planLocks.get(key) === current) planLocks.delete(key);
  }
}
