"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isUuid } from "@/lib/training-assignment";
import { readSchedule, readText, scheduleVersion, type PlanActionState } from "@/lib/training-plans";
import { loadPlanItems, withPlanLock } from "@/lib/training-plans-server";
import { loadAdminTemplateWorkouts, requireAdminTemplate, requirePlatformAdmin } from "@/lib/admin-training-templates-server";

function failure(cause: unknown): PlanActionState {
  return { status: "error", message: cause instanceof Error ? cause.message : "Unable to manage this template. Reload and try again." };
}
function invalidate() {
  revalidatePath("/admin", "layout");
  revalidatePath("/teams/[teamId]/plans", "layout");
}
export async function createTemplate(state: PlanActionState, data: FormData): Promise<PlanActionState> {
  if (state.status === "review_required") return state;
  const templateId = randomUUID();
  let writing = false;
  try {
    const context = await requirePlatformAdmin();
    const name = readText(data, "name", true), description = readText(data, "description");
    writing = true;
    const { error, status } = await context.supabase.from("training_plans").insert({
      id: templateId, name, description, kind: "template", visibility: "public", status: "draft",
      team_id: null, owner_user_id: context.user.id, source_template_id: null,
    });
    if (error) {
      if (!(status >= 400 && status < 500 && status !== 408)) return { status: "review_required", message: "Creation could not be confirmed. Review the template list before creating another master.", recoveryUrl: `/admin/training-templates/${templateId}` };
      return failure(new Error("Template creation was rejected. No master was created."));
    }
  } catch (cause) {
    return writing ? { status: "review_required", message: "Creation could not be confirmed. Review the template list before trying again.", recoveryUrl: `/admin/training-templates/${templateId}` } : failure(cause);
  }
  invalidate();
  redirect(`/admin/training-templates/${templateId}`);
}
export async function mutateTemplate(templateId: string, state: PlanActionState, data: FormData): Promise<PlanActionState> {
  if (state.status === "review_required") return state;
  return withPlanLock(templateId, async () => {
    try {
      const context = await requirePlatformAdmin();
      const template = await requireAdminTemplate(context, templateId);
      if (data.get("planVersion") !== template.updated_at) throw new Error("This template changed. Reload before making changes.");
      const operation = data.get("operation");
      let message: string;
      if (["publish", "unpublish", "archive", "edit-archived"].includes(String(operation))) {
        const expected = operation === "publish" ? "draft" : operation === "edit-archived" ? "archived" : "active";
        if (template.status !== expected) throw new Error("This lifecycle action is unavailable for the current status.");
        if (operation === "publish") {
          const items = await loadPlanItems(context, templateId);
          if (!items.length) throw new Error("Add at least one workout before publishing.");
          if (data.get("scheduleVersion") !== scheduleVersion(items)) throw new Error("The schedule changed. Reload and review it before publishing.");
          const workouts = await loadAdminTemplateWorkouts(context);
          const available = new Set(workouts.map((workout) => workout.id));
          if (items.some((item) => !available.has(item.workout_id))) throw new Error("Every scheduled workout must still be public and accessible before publishing.");
          for (const item of items) {
            const schedule = new FormData();
            schedule.set("dayNumber", String(item.day_offset + 1)); schedule.set("orderNumber", String(item.position + 1));
            if (item.scheduled_time) schedule.set("scheduledTime", item.scheduled_time);
            readSchedule(schedule);
          }
        }
        const status = operation === "publish" ? "active" : operation === "archive" ? "archived" : "draft";
        const { data: changed, error } = await context.supabase.from("training_plans").update({ status })
          .eq("id", templateId).eq("kind", "template").eq("status", expected).eq("updated_at", template.updated_at).select("id");
        if (error || changed?.length !== 1) throw new Error("Status change could not be confirmed. Reload to review the template.");
        message = operation === "publish" ? "Template published. Coaches can now view and copy it." : status === "archived" ? "Template archived. Existing coach copies are unchanged." : "Template returned to draft and hidden from the coach library. Existing copies are unchanged.";
      } else {
        if (template.status !== "draft") throw new Error("Only draft masters can be edited. Unpublish before changing a published template.");
        if (operation === "save-plan") {
          const { data: changed, error } = await context.supabase.from("training_plans")
            .update({ name: readText(data, "name", true), description: readText(data, "description") })
            .eq("id", templateId).eq("kind", "template").eq("status", "draft").eq("updated_at", template.updated_at).select("id");
          if (error || changed?.length !== 1) throw new Error("Template save could not be confirmed. Reload before retrying.");
          message = "Template details saved.";
        } else if (["add-item", "save-item", "remove-item"].includes(String(operation))) {
          const items = await loadPlanItems(context, templateId);
          const existing = operation === "add-item" ? undefined : items.find((item) => item.id === data.get("itemId"));
          if (operation !== "add-item" && (!existing || !isUuid(existing.id))) throw new Error("This item does not belong to this master template.");
          if (existing && data.get("itemVersion") !== existing.updated_at) throw new Error("This item changed. Reload before editing.");
          if (operation === "remove-item") {
            const { data: removed, error } = await context.supabase.from("training_plan_items").delete().eq("id", existing!.id).eq("training_plan_id", templateId).eq("updated_at", existing!.updated_at).select("id");
            if (error || removed?.length !== 1) throw new Error("Item removal could not be confirmed. Reload to check the schedule.");
            message = "Workout removed from draft master.";
          } else {
            const schedule = readSchedule(data);
            if (items.some((item) => item.id !== existing?.id && item.position === schedule.position)) throw new Error("That order number is already used. Choose an unused number; gaps are allowed.");
            const workoutId = operation === "add-item" ? data.get("workoutId") : existing!.workout_id;
            const workouts = await loadAdminTemplateWorkouts(context);
            if (typeof workoutId !== "string" || !isUuid(workoutId) || !workouts.some((workout) => workout.id === workoutId)) throw new Error("Choose an accessible public workout for this master.");
            const query = operation === "add-item" ? context.supabase.from("training_plan_items").insert({ training_plan_id: templateId, workout_id: workoutId, ...schedule })
              : context.supabase.from("training_plan_items").update(schedule).eq("id", existing!.id).eq("training_plan_id", templateId).eq("updated_at", existing!.updated_at);
            const { data: changed, error } = await query.select("id");
            if (error || changed?.length !== 1) throw new Error("Item save could not be confirmed. Reload to check the schedule before retrying.");
            message = "Master schedule saved.";
          }
        } else throw new Error("Unknown template action.");
      }
      invalidate();
      return { status: "success", message };
    } catch (cause) { return failure(cause); }
  });
}
