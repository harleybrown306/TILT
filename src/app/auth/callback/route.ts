import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { safeAuthContinuation } from "@/lib/auth-continuation";
import { configuredApplicationUrl } from "@/lib/invitation-communication";
import { createOperationalReference, logOperationalFailure } from "@/lib/operational-log";

function sensitiveAuthResponse(response: NextResponse) {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

function failureRedirect(origin: string, reference?: string) {
  const destination = new URL("/login?auth=error", origin);
  if (reference) destination.searchParams.set("reference", reference);
  return sensitiveAuthResponse(NextResponse.redirect(destination));
}

function isExpectedExchangeRejection(error: unknown) {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408;
}

function callbackOrigin(requestOrigin: string) {
  const configured = configuredApplicationUrl();
  return configured.ok ? configured.value.origin : requestOrigin;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = callbackOrigin(url.origin);
  const code = url.searchParams.get("code");
  const flowId = url.searchParams.get("sb_flow_id");
  const destination = safeAuthContinuation(url.searchParams.get("next"));
  const reference = createOperationalReference();
  if (!code) return failureRedirect(origin);

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
  let data;
  let error;
  try {
    ({ data, error } = await supabase.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined));
  } catch {
    logOperationalFailure({ reference, surface: "auth_callback", code: "auth_exchange_failed" });
    return failureRedirect(origin, reference);
  }
  if (error) {
    if (isExpectedExchangeRejection(error)) return failureRedirect(origin);
    logOperationalFailure({ reference, surface: "auth_callback", code: "auth_exchange_failed" });
    return failureRedirect(origin, reference);
  }
  // auth-js preserves the recovery redirect type in the PKCE verifier and returns it
  // at runtime, although the current public result type omits this field.
  const redirectType = (data as typeof data & { redirectType?: string }).redirectType;
  if (destination === "/reset-password" && redirectType !== "recovery") {
    return failureRedirect(origin);
  }
  const response = NextResponse.redirect(new URL(destination, origin));
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
  return sensitiveAuthResponse(response);
}
