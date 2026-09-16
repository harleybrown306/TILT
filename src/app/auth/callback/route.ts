import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { safeAuthContinuation } from "@/lib/auth-continuation";

function continuationCategory(destination: string) {
  if (destination.startsWith("/invite/")) return "invite";
  if (destination === "/reset-password") return "reset";
  return "root";
}

function logExchangeError(error: unknown) {
  const authError = error as { name?: unknown; code?: unknown; message?: unknown };
  console.error("[TILT auth callback diagnostic]", {
    errorName: typeof authError?.name === "string" ? authError.name : "UnknownError",
    errorCode: typeof authError?.code === "string" ? authError.code : undefined,
    errorMessage: typeof authError?.message === "string" ? authError.message : "Unknown error",
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const flowId = url.searchParams.get("sb_flow_id");
  const destination = safeAuthContinuation(url.searchParams.get("next"));
  console.info("[TILT auth callback diagnostic]", {
    codePresent: Boolean(code),
    flowIdPresent: Boolean(flowId),
    continuation: continuationCategory(destination),
  });
  if (!code) return NextResponse.redirect(new URL("/login?auth=error", url.origin));

  const cookieStore = await cookies();
  const exchangedCookies: Array<{ name: string; value: string; options: Parameters<typeof cookieStore.set>[2] }> = [];
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          exchangedCookies.push(...cookiesToSet);
        },
      },
    }
  );
  console.info("[TILT auth callback diagnostic]", { exchangeAttempted: true });
  let data;
  let error;
  try {
    ({ data, error } = await supabase.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined));
  } catch (exchangeError) {
    logExchangeError(exchangeError);
    throw exchangeError;
  }
  if (error) {
    logExchangeError(error);
    return NextResponse.redirect(new URL("/login?auth=error", url.origin));
  }
  // auth-js preserves the recovery redirect type in the PKCE verifier and returns it
  // at runtime, although the current public result type omits this field.
  const redirectType = (data as typeof data & { redirectType?: string }).redirectType;
  console.info("[TILT auth callback diagnostic]", { exchangeSucceeded: true, redirectType: redirectType ?? null });
  if (destination === "/reset-password" && redirectType !== "recovery") {
    return NextResponse.redirect(new URL("/login?auth=error", url.origin));
  }
  const response = NextResponse.redirect(new URL(destination, url.origin));
  exchangedCookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
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
