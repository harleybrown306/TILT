"use server";

import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

export type ResetPasswordState = { status: "idle" | "error" | "success"; message: string };
export const initialResetPasswordState: ResetPasswordState = { status: "idle", message: "" };

export async function resetPassword(_: ResetPasswordState, formData: FormData): Promise<ResetPasswordState> {
  const cookieStore = await cookies();
  if (cookieStore.get("tilt_password_recovery")?.value !== "1") {
    return { status: "error", message: "Your reset link is expired or invalid. Request a new link to continue." };
  }
  const password = formData.get("password");
  const confirmation = formData.get("confirmation");
  if (typeof password !== "string" || !password || password !== confirmation) {
    return { status: "error", message: "Enter matching passwords." };
  }
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return { status: "error", message: "Your reset link is expired or invalid. Request a new link to continue." };
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { status: "error", message: "We could not update your password. Request a new reset link and try again." };
  cookieStore.delete("tilt_password_recovery");
  return { status: "success", message: "Your password has been updated." };
}
