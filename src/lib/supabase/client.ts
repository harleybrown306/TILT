import { createBrowserClient } from "@supabase/ssr";
import { authCallbackOrigin } from "@/lib/auth-callback-origin";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      auth: {
        experimental: {
          appendPkceFlowIdToRedirects: true,
        },
      },
    }
  );
}

export function canonicalAuthCallbackUrl(destination: string) {
  const origin = authCallbackOrigin();
  return origin ? `${origin}/auth/callback?next=${encodeURIComponent(destination)}` : null;
}
