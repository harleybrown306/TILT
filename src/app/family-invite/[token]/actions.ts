"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { familyInvitationLoginPath, isFamilyInvitationToken } from "@/lib/family-team-invitations";
import { isUuid } from "@/lib/training-assignment";
import type { RosterState } from "@/lib/team-invitations";

export type FamilyInvitationAcceptanceState = {
  status: "idle" | "error" | "review_required";
  message: string;
};

type AcceptanceInput = {
  athleteId: string | null;
  firstName: string | null;
  lastName: string | null;
  graduationYear: number | null;
};

function athleteName(value: FormDataEntryValue | null, field: "first" | "last") {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Enter the child’s ${field} name.`);
  return value.trim();
}

function graduationYear(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !/^\d{4}$/.test(value)) throw new Error("Graduation year must be between 2000 and 2100.");
  const year = Number(value);
  if (year < 2000 || year > 2100) throw new Error("Graduation year must be between 2000 and 2100.");
  return year;
}

function acceptanceInput(data: FormData): AcceptanceInput {
  const athleteId = data.get("athleteId");
  const first = data.get("firstName");
  const last = data.get("lastName");
  const year = data.get("graduationYear");
  const hasAthlete = typeof athleteId === "string" && athleteId.trim() !== "";
  const hasChildDetail = [first, last, year].some((value) => typeof value === "string" && value.trim() !== "");
  if (hasAthlete && hasChildDetail) throw new Error("Choose an existing athlete or add a child, not both.");
  if (hasAthlete) {
    if (!isUuid(athleteId)) throw new Error("Choose an athlete from the list.");
    return { athleteId, firstName: null, lastName: null, graduationYear: null };
  }
  if (!hasChildDetail) throw new Error("Choose an existing athlete or add a child.");
  const firstName = athleteName(first, "first");
  const lastName = athleteName(last, "last");
  if (`${firstName} ${lastName}`.length > 200) throw new Error("Child name must be at most 200 characters.");
  return { athleteId: null, firstName, lastName, graduationYear: graduationYear(year) };
}

function reviewRequired(): FamilyInvitationAcceptanceState {
  return { status: "review_required", message: "We could not confirm whether the athlete was added. Refresh this invitation and review the team before trying again." };
}

function acceptanceError(message: string | undefined, status: number | undefined): FamilyInvitationAcceptanceState {
  switch (message) {
    case "Authentication required":
    case "Authenticated account must have a verified email":
    case "Invitation email does not match the signed-in account":
      return { status: "error", message: "Sign in with the email address that received this invitation." };
    case "Family invitation is invalid or unavailable":
    case "Family invitation is no longer pending":
      return { status: "error", message: "This invitation is invalid or unavailable." };
    case "Inviter no longer has permission to enroll families":
      return { status: "error", message: "This invitation can no longer add an athlete. Ask the team for a new invitation." };
    case "Selected athlete is not manageable by this account":
    case "Selected athlete is unavailable":
      return { status: "error", message: "That athlete is no longer available to add. Choose another athlete." };
    case "Choose an existing athlete or provide new child details":
      return { status: "error", message: "Choose an existing athlete or provide the child’s details." };
    default:
      return status !== undefined && status >= 400 && status < 500 && status !== 408
        ? { status: "error", message: "This invitation cannot add that athlete. Refresh and review it before trying again." }
        : reviewRequired();
  }
}

export async function switchFamilyInvitationAccount(token: string, state: RosterState): Promise<RosterState> {
  void state;
  if (!isFamilyInvitationToken(token)) return { status: "error", message: "This invitation is invalid or unavailable." };
  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signOut();
    if (error) return { status: "error", message: "Unable to sign out. Reload and try again." };
  } catch {
    return { status: "error", message: "Unable to sign out. Reload and try again." };
  }
  redirect(familyInvitationLoginPath(token));
}

export async function acceptFamilyTeamInvitation(token: string, state: FamilyInvitationAcceptanceState, data: FormData): Promise<FamilyInvitationAcceptanceState> {
  if (state.status === "review_required") return state;
  if (!isFamilyInvitationToken(token)) return { status: "error", message: "This invitation is invalid or unavailable." };

  let input: AcceptanceInput;
  try {
    input = acceptanceInput(data);
  } catch (cause) {
    return { status: "error", message: cause instanceof Error ? cause.message : "Choose an athlete or enter the child’s details." };
  }

  let invoked = false;
  let acceptedAthleteId: string | null = null;
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return { status: "error", message: "Sign in with the email address that received this invitation." };
    invoked = true;
    const { data: accepted, error, status } = await supabase.rpc("accept_family_team_invitation", {
      p_invitation_token: token,
      p_existing_athlete_id: input.athleteId,
      p_first_name: input.firstName,
      p_last_name: input.lastName,
      p_graduation_year: input.graduationYear,
    });
    const result = accepted?.[0];
    if (error || accepted?.length !== 1 || !result || !isUuid(result.team_id) || !isUuid(result.athlete_id)) {
      return error ? acceptanceError(error.message, status) : reviewRequired();
    }
    acceptedAthleteId = result.athlete_id;
  } catch {
    return invoked ? reviewRequired() : { status: "error", message: "Sign in with the email address that received this invitation." };
  }
  if (!acceptedAthleteId) return reviewRequired();
  redirect(`/?athlete=${encodeURIComponent(acceptedAthleteId)}`);
}
