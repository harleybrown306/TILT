"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isUuid } from "@/lib/training-assignment";
import { isDraft, readSchedule, readText, scheduleVersion, type PlanActionState } from "@/lib/training-plans";
import { loadPlanItems, loadPlanWorkouts, requirePlanCoach, requireTeamPlan, withPlanLock } from "@/lib/training-plans-server";

function failure(cause: unknown): PlanActionState {
  return { status: "error", message: cause instanceof Error ? cause.message : "Unable to manage this plan. Reload and try again." };
}
function invalidate(teamId: string, planId: string) {
  revalidatePath(`/teams/${teamId}/plans`);
  revalidatePath(`/teams/${teamId}/plans/${planId}`);
  revalidatePath(`/teams/${teamId}/assign`);
}

export async function createPlan(teamId: string, _state: PlanActionState, data: FormData): Promise<PlanActionState> {
  const planId = randomUUID();
  try {
    const { supabase, user } = await requirePlanCoach(teamId);
    const name = readText(data, "name", true);
    const description = readText(data, "description");
    const { error } = await supabase.from("training_plans").insert({
      id: planId, team_id: teamId, owner_user_id: user.id, name, description, status: "draft",
    });
    if (error) throw new Error("The plan could not be created. Reload the plan list before trying again.");
  } catch (cause) { return failure(cause); }
  invalidate(teamId, planId);
  redirect(`/teams/${teamId}/plans/${planId}`);
}

export async function mutatePlan(teamId: string, planId: string, _state: PlanActionState, data: FormData): Promise<PlanActionState> {
  return withPlanLock(`${teamId}:${planId}`, async () => {
    try {
      const context = await requirePlanCoach(teamId);
      const plan = await requireTeamPlan(context, teamId, planId);
      const operation = data.get("operation");
      const expectedVersion = data.get("planVersion");
      if (expectedVersion !== plan.updated_at) throw new Error("This plan changed since you opened it. Reload before making changes.");
      const { supabase } = context;
      let message: string;

      if (operation === "archive" || operation === "activate") {
        const expectedStatus = operation === "activate" ? "draft" : "active";
        if (plan.status !== expectedStatus) throw new Error("This lifecycle action is not available for the plan's current status.");
        if (operation === "activate") {
          const items = await loadPlanItems(context, planId);
          if (!items.length) throw new Error("Add at least one workout before activating this plan.");
          if (data.get("scheduleVersion") !== scheduleVersion(items)) throw new Error("The schedule changed since you opened it. Reload and review it before activating.");
          const workouts = await loadPlanWorkouts(context, teamId);
          const usableIds = new Set(workouts.map((workout) => workout.id));
          if (items.some((item) => !usableIds.has(item.workout_id))) throw new Error("Some workouts are no longer available or entitled. Replace them before activating.");
          for (const item of items) {
            const schedule = new FormData();
            schedule.set("dayNumber", String(item.day_offset + 1));
            schedule.set("orderNumber", String(item.position + 1));
            if (item.scheduled_time) schedule.set("scheduledTime", item.scheduled_time);
            readSchedule(schedule);
          }
        }
        const { data: changed, error } = await supabase.from("training_plans")
          .update({ status: operation === "activate" ? "active" : "archived" })
          .eq("id", planId).eq("team_id", teamId).eq("status", expectedStatus).eq("updated_at", plan.updated_at).select("id");
        if (error || changed?.length !== 1) throw new Error("The plan status could not be changed. Reload to check its current state.");
        message = operation === "activate" ? "Plan activated. Its structure is now locked and it is available in Assign Training." : "Plan archived. Existing assignments and sessions are unchanged.";
      } else {
        if (!isDraft(plan.status)) throw new Error("Only draft plans can be edited. Active and archived plans are read-only.");
        if (operation === "save-plan") {
          const { data: changed, error } = await supabase.from("training_plans")
            .update({ name: readText(data, "name", true), description: readText(data, "description") })
            .eq("id", planId).eq("team_id", teamId).eq("status", "draft").eq("updated_at", plan.updated_at).select("id");
          if (error || changed?.length !== 1) throw new Error("The plan could not be saved. Reload to check its current state.");
          message = "Plan details saved.";
        } else if (["add-item", "save-item", "remove-item"].includes(String(operation))) {
          const items = await loadPlanItems(context, planId);
          const itemId = data.get("itemId");
          const existing = operation === "add-item" ? undefined : items.find((item) => item.id === itemId);
          if (operation !== "add-item" && (!existing || typeof itemId !== "string" || !isUuid(itemId))) throw new Error("This workout item does not belong to this plan.");
          if (existing && data.get("itemVersion") !== existing.updated_at) throw new Error("This workout item changed. Reload before editing it.");

          if (operation === "remove-item") {
            const { data: changed, error } = await supabase.from("training_plan_items").delete()
              .eq("id", existing!.id).eq("training_plan_id", planId).eq("updated_at", existing!.updated_at).select("id");
            if (error || changed?.length !== 1) throw new Error("The workout could not be removed. Reload to check the schedule.");
            message = "Workout removed from the draft plan.";
          } else {
            const schedule = readSchedule(data);
            if (items.some((item) => item.id !== existing?.id && item.position === schedule.position)) throw new Error("That order number is already used. Choose an unused number; gaps are allowed.");
            const workoutId = operation === "add-item" ? data.get("workoutId") : existing!.workout_id;
            if (typeof workoutId !== "string" || !isUuid(workoutId)) throw new Error("Choose a valid workout.");
            const workouts = await loadPlanWorkouts(context, teamId);
            if (!workouts.some((workout) => workout.id === workoutId)) throw new Error("This workout is not available or entitled for you and this team.");
            const query = operation === "add-item"
              ? supabase.from("training_plan_items").insert({ training_plan_id: planId, workout_id: workoutId, ...schedule })
              : supabase.from("training_plan_items").update(schedule).eq("id", existing!.id).eq("training_plan_id", planId).eq("updated_at", existing!.updated_at);
            const { data: changed, error } = await query.select("id");
            if (error || changed?.length !== 1) throw new Error("The workout could not be saved. Reload to check the schedule before retrying.");
            message = operation === "add-item" ? "Workout added." : "Workout schedule saved.";
          }
        } else { throw new Error("Unknown plan action."); }
      }
      invalidate(teamId, planId);
      return { status: "success", message };
    } catch (cause) { return failure(cause); }
  });
}
