"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isUuid } from "@/lib/training-assignment";
import { createClient } from "@/lib/supabase/server";

export type AddAthleteState = {
  status: "idle" | "error" | "review_required";
  message: string;
};

function name(value: FormDataEntryValue | null, field: "first" | "last") {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Enter an athlete ${field} name.`);
  return value.trim();
}

function graduationYear(value: FormDataEntryValue | null) {
  if (value === null || value === "") throw new Error("Graduation year is required.");
  if (typeof value !== "string" || !/^\d{4}$/.test(value)) throw new Error("Graduation year must be between 2000 and 2100.");
  const year = Number(value);
  if (year < 2000 || year > 2100) throw new Error("Graduation year must be between 2000 and 2100.");
  return year;
}

export async function addAthlete(state: AddAthleteState, formData: FormData): Promise<AddAthleteState> {
  if (state.status === "review_required") return state;

  let firstName: string;
  let lastName: string;
  let year: number;
  let createdAthleteId: string;
  try {
    firstName = name(formData.get("firstName"), "first");
    lastName = name(formData.get("lastName"), "last");
    if (`${firstName} ${lastName}`.length > 200) throw new Error("Athlete name must be at most 200 characters.");
    year = graduationYear(formData.get("graduationYear"));
  } catch (cause) {
    return { status: "error", message: cause instanceof Error ? cause.message : "Enter the athlete details." };
  }

  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return { status: "error", message: "Please sign in before adding an athlete." };

    const { data, error, status } = await supabase.rpc("create_my_athlete", {
      p_first_name: firstName,
      p_last_name: lastName,
      p_graduation_year: year,
    });
    if (error || typeof data !== "string" || !isUuid(data)) {
      if (status === undefined || status === 408 || status >= 500) {
        return { status: "review_required", message: "We could not confirm whether the athlete was added. Return to your dashboard and check before trying again." };
      }
      return { status: "error", message: "Unable to add this athlete. Review the details and try again." };
    }

    createdAthleteId = data;
  } catch {
    return { status: "review_required", message: "We could not confirm whether the athlete was added. Return to your dashboard and check before trying again." };
  }

  revalidatePath("/");
  redirect(`/?athlete=${encodeURIComponent(createdAthleteId)}`);
}
