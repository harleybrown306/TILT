import { NextResponse } from "next/server";
import { safeAuthContinuation } from "@/lib/auth-continuation";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const destination = safeAuthContinuation(url.searchParams.get("next"));
  if (!code) return NextResponse.redirect(new URL("/login?auth=error", url.origin));

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(new URL("/login?auth=error", url.origin));
  // auth-js preserves the recovery redirect type in the PKCE verifier and returns it
  // at runtime, although the current public result type omits this field.
  const redirectType = (data as typeof data & { redirectType?: string }).redirectType;
  if (destination === "/reset-password" && redirectType !== "recovery") {
    return NextResponse.redirect(new URL("/login?auth=error", url.origin));
  }
  const response = NextResponse.redirect(new URL(destination, url.origin));
  if (redirectType === "recovery") {
    response.cookies.set("tilt_password_recovery", "1", {
      httpOnly: true,
      maxAge: 10 * 60,
      path: "/reset-password",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
  }
  return response;
}
