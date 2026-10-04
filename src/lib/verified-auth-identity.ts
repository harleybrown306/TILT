import "server-only";

import { createClient } from "@/lib/supabase/server";

export type VerifiedAuthIdentity = {
  authUserId: string;
  verifiedEmail: string;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Auth is the authority for this assertion.  Call immediately before a
 * service-only invitation RPC; do not cache or send its result to a client.
 */
export async function getCurrentVerifiedAuthIdentity(): Promise<VerifiedAuthIdentity | null> {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user || user.is_anonymous || !user.email_confirmed_at || !user.email) return null;
  const verifiedEmail = user.email.trim().toLowerCase();
  if (!EMAIL.test(verifiedEmail)) return null;
  return { authUserId: user.id, verifiedEmail };
}
