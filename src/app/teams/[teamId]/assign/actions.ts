"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isAssignablePlan } from "@/lib/training-plans";
import {
  isDate,
  isUuid,
  readAllRows,
  resolveRecipientIds,
  type AssignmentState,
} from "@/lib/training-assignment";

function error(message: string): AssignmentState {
  return { status: "error", message };
}

function readIds(formData: FormData, name: string): string[] | null {
  const values = formData.getAll(name);
  if (values.some((value) => typeof value !== "string" || !isUuid(value))) return null;
  return [...new Set(values as string[])];
}

// Only a definite rejection is safe to compensate. A lost response may follow a commit.
function wasRejected(status: number) {
  return status >= 400 && status < 500 && status !== 408;
}

export async function assignTraining(
  teamId: string,
  previousState: AssignmentState,
  formData: FormData,
): Promise<AssignmentState> {
  if (previousState.status === "success" || previousState.status === "review_required") {
    return previousState;
  }

  const planId = formData.get("trainingPlanId");
  const startDate = formData.get("startDate");
  const rawNotes = formData.get("notes");
  const individualIds = readIds(formData, "athleteIds");
  const groupIds = readIds(formData, "groupIds");

  if (!isUuid(teamId) || typeof planId !== "string" || !isUuid(planId) ||
      typeof startDate !== "string" || !isDate(startDate) ||
      (rawNotes !== null && typeof rawNotes !== "string") || !individualIds || !groupIds) {
    return error("Choose a training plan, a valid start date, and valid recipients.");
  }
  if (!individualIds.length && !groupIds.length) {
    return error("Select at least one athlete or group.");
  }
  const notes = typeof rawNotes === "string" ? rawNotes.trim() || null : null;

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return error("Please sign in before assigning training.");

  let recipientIds: string[];
  try {
    const { data: membership, error: membershipError } = await supabase
      .from("team_memberships")
      .select("role")
      .eq("team_id", teamId)
      .eq("user_id", user.id)
      .single();
    if (membershipError || !membership ||
        !["coach", "assistant_coach"].includes(membership.role)) {
      return error("You do not have permission to assign training for this team.");
    }

    const { data: plan, error: planError } = await supabase
      .from("training_plans")
      .select("id, owner_user_id, kind, visibility, status")
      .eq("id", planId)
      .single();
    if (planError || !plan || !isAssignablePlan(plan, user.id)) {
      return error("Choose an active coach plan from your own library. Templates must be copied first.");
    }

    const athletes = await readAllRows<{ user_id: string }>((from, to) => supabase
      .from("team_memberships")
      .select("user_id")
      .eq("team_id", teamId)
      .eq("role", "athlete")
      .order("id")
      .range(from, to));
    const teamAthleteIds = athletes.map((athlete) => athlete.user_id);
    const eligible = new Set(teamAthleteIds);
    if (individualIds.some((id) => !eligible.has(id))) {
      return error("Every selected individual must be an athlete on this team. Reload the roster and try again.");
    }

    let groupAthleteIds: string[] = [];
    if (groupIds.length) {
      const groups = await readAllRows<{ id: string }>((from, to) => supabase
        .from("team_groups")
        .select("id")
        .eq("team_id", teamId)
        .in("id", groupIds)
        .order("id")
        .range(from, to));
      const validGroupIds = new Set(groups.map((group) => group.id));
      if (groupIds.some((id) => !validGroupIds.has(id))) {
        return error("Every selected group must belong to this team. Reload the groups and try again.");
      }

      const members = await readAllRows<{ athlete_user_id: string }>((from, to) => supabase
        .from("team_group_memberships")
        .select("athlete_user_id")
        .in("team_group_id", groupIds)
        .order("id")
        .range(from, to));
      groupAthleteIds = members.map((member) => member.athlete_user_id);
    }
    // Stale group memberships never grant eligibility outside the team's current roster.
    recipientIds = resolveRecipientIds(individualIds, groupAthleteIds, teamAthleteIds);
    if (!recipientIds.length) return error("The selection contains no current team athletes.");
  } catch {
    return error("Unable to validate recipients. No training was assigned. Please reload and try again.");
  }

  const batchId = randomUUID();
  const batch = {
    id: batchId,
    team_id: teamId,
    training_plan_id: planId,
    assigned_by_user_id: user.id,
    start_date: startDate,
    notes,
    selection_snapshot: {
      selected_individual_athlete_ids: individualIds,
      selected_group_ids: groupIds,
      resolved_unique_athlete_ids: recipientIds,
    },
  };
  const reviewRequired = (): AssignmentState => {
    // Keep the batch reference available to server operators without exposing UUIDs in the UI.
    console.error("Training assignment needs review", { batchId, teamId });
    return {
      status: "review_required",
      message: "The assignment could not be confirmed. Ask an administrator to review this attempt before assigning again; retrying could duplicate training.",
    };
  };

  try {
    // Supply the known id so a successful insert does not require a separate SELECT permission.
    const { error: batchError, status: batchStatus } = await supabase
      .from("training_assignment_batches")
      .insert(batch);
    if (batchError) {
      return wasRejected(batchStatus)
        ? error("Unable to create the assignment batch. No training was assigned.")
        : reviewRequired();
    }

    // One request: all per-athlete rows and their session triggers commit or roll back together.
    const { error: assignmentError, status: assignmentStatus } = await supabase
      .from("training_plan_assignments")
      .insert(recipientIds.map((athleteId) => ({
        training_plan_id: planId,
        team_id: teamId,
        athlete_user_id: athleteId,
        assigned_by_user_id: user.id,
        start_date: startDate,
        status: "active",
        notes,
        assignment_batch_id: batchId,
      })));

    if (assignmentError) {
      if (!wasRejected(assignmentStatus)) return reviewRequired();
      const { data: deleted, error: cleanupError } = await supabase
        .from("training_assignment_batches")
        .delete()
        .eq("id", batchId)
        .eq("team_id", teamId)
        .eq("assigned_by_user_id", user.id)
        .select("id");
      if (cleanupError || deleted?.length !== 1) return reviewRequired();
      return error("Assignments were rejected and the empty batch was removed. No training was assigned. Please check the plan and recipients before trying again.");
    }
  } catch {
    // Never delete a batch after an uncertain write: assignments may already reference it.
    return reviewRequired();
  }

  revalidatePath(`/teams/${teamId}`);
  revalidatePath(`/teams/${teamId}/assign`);
  revalidatePath("/");
  return {
    status: "success",
    recipientCount: recipientIds.length,
    message: `Training assigned to ${recipientIds.length} ${recipientIds.length === 1 ? "athlete" : "athletes"}.`,
  };
}
