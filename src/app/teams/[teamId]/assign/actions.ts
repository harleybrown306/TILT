"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
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

function rpcError(message: string): AssignmentState {
  if (message.includes("Assignment idempotency integrity failure")) {
    return {
      status: "review_required",
      message: "This assignment needs review before it can be retried. No new training was created by this request.",
    };
  }
  if (message.includes("Assignment idempotency conflict")) {
    return error("This assignment request conflicts with an earlier request. Reload the page before assigning training again.");
  }
  if (message.includes("Recipient is not authorized")) {
    return error("One or more selected athletes are no longer authorized for this team. Reload the roster and try again.");
  }
  if (message.includes("Assignable coach plan unavailable")) {
    return error("Choose an active coach plan from your own library. Templates must be copied first.");
  }
  return error("Unable to confirm the assignment. You can retry this same request; it will not create a second assignment.");
}

export async function assignTraining(
  teamId: string,
  previousState: AssignmentState,
  formData: FormData,
): Promise<AssignmentState> {
  if (previousState.status === "success" || previousState.status === "review_required") {
    return previousState;
  }

  const requestId = formData.get("assignmentRequestId");
  const planId = formData.get("trainingPlanId");
  const startDate = formData.get("startDate");
  const rawNotes = formData.get("notes");
  const individualAthleteIds = readIds(formData, "athleteIds");
  const groupIds = readIds(formData, "groupIds");

  if (!isUuid(teamId) || typeof requestId !== "string" || !isUuid(requestId) ||
      typeof planId !== "string" || !isUuid(planId) ||
      typeof startDate !== "string" || !isDate(startDate) ||
      (rawNotes !== null && typeof rawNotes !== "string") || !individualAthleteIds || !groupIds) {
    return error("Choose a training plan, a valid start date, and valid recipients.");
  }
  if (!individualAthleteIds.length && !groupIds.length) {
    return error("Select at least one athlete or group.");
  }
  const notes = typeof rawNotes === "string" ? rawNotes.trim() || null : null;

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return error("Please sign in before assigning training.");

  let athleteIds: string[];
  try {
    const roster = await readAllRows<{ athlete_id: string }>((from, to) => supabase
      .from("team_athlete_memberships")
      .select("athlete_id")
      .eq("team_id", teamId)
      .order("id")
      .range(from, to));
    const rosterAthleteIds = roster.map((membership) => membership.athlete_id);
    const eligible = new Set(rosterAthleteIds);
    if (individualAthleteIds.some((id) => !eligible.has(id))) {
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
      // Groups still store legacy athlete-user IDs. During this transition, a
      // group member maps only when that same UUID is a current durable roster
      // athlete; no guardian/coach identity can become an athlete recipient.
      groupAthleteIds = members
        .map((member) => member.athlete_user_id)
        .filter((legacyAthleteUserId) => eligible.has(legacyAthleteUserId));
    }
    athleteIds = resolveRecipientIds(individualAthleteIds, groupAthleteIds, rosterAthleteIds);
    if (!athleteIds.length) return error("The selection contains no current team athletes.");
  } catch {
    return error("Unable to validate recipients. No training was assigned. Please reload and try again.");
  }

  try {
    const { data, error: assignmentError } = await supabase.rpc("assign_my_team_training", {
      p_batch_id: requestId,
      p_team_id: teamId,
      p_training_plan_id: planId,
      p_start_date: startDate,
      p_notes: notes,
      p_athlete_ids: athleteIds,
    });
    if (assignmentError) {
      console.error("Training assignment RPC failed", {
        requestId,
        teamId,
        code: assignmentError.code,
      });
      return rpcError(assignmentError.message);
    }

    const recipientCount = data?.[0]?.recipient_count;
    if (typeof recipientCount !== "number" || recipientCount !== athleteIds.length) {
      console.error("Training assignment RPC returned an unexpected result", { requestId, teamId });
      return error("Unable to confirm the assignment. You can retry this same request; it will not create a second assignment.");
    }

    revalidatePath(`/teams/${teamId}`);
    revalidatePath(`/teams/${teamId}/assign`);
    revalidatePath("/");
    return {
      status: "success",
      recipientCount,
      message: `Training assigned to ${recipientCount} ${recipientCount === 1 ? "athlete" : "athletes"}.`,
    };
  } catch {
    // The client keeps the same request UUID, so a manual retry is safe.
    return error("Unable to confirm the assignment. You can retry this same request; it will not create a second assignment.");
  }
}
