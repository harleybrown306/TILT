import "server-only";

import { canonicalApplicationUrl } from "@/lib/application-origin";

export type RuntimeConfigurationIssue =
  | "supabase_url"
  | "supabase_publishable_key"
  | "canonical_application_origin"
  | "public_canonical_application_origin"
  | "canonical_application_origin_mismatch";

const releaseIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{6,63}$/;

export function releaseIdentity(value = process.env.TILT_RELEASE_ID) {
  return value && releaseIdPattern.test(value) ? value : null;
}

/**
 * Inspects names and shapes only. It never returns or logs configuration
 * values, including the service-role secret.
 */
export function runtimeConfigurationIssues(environment = process.env): RuntimeConfigurationIssue[] {
  const issues: RuntimeConfigurationIssue[] = [];
  const production = environment.NODE_ENV === "production";
  const supabase = canonicalApplicationUrl(environment.NEXT_PUBLIC_SUPABASE_URL, production);
  if (!supabase.ok) issues.push("supabase_url");
  if (!environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) issues.push("supabase_publishable_key");

  const serverOrigin = canonicalApplicationUrl(environment.TILT_APP_URL, production);
  if (!serverOrigin.ok) issues.push("canonical_application_origin");
  const publicOrigin = canonicalApplicationUrl(environment.NEXT_PUBLIC_TILT_APP_URL, production);
  if (!publicOrigin.ok) issues.push("public_canonical_application_origin");
  if (serverOrigin.ok && publicOrigin.ok && serverOrigin.value.origin !== publicOrigin.value.origin) {
    issues.push("canonical_application_origin_mismatch");
  }
  return issues;
}

/** Fails a production server before it accepts traffic with unsafe core config. */
export function assertProductionRuntimeConfiguration(environment = process.env) {
  if (environment.NODE_ENV !== "production") return;
  const issues = runtimeConfigurationIssues(environment);
  if (issues.length) throw new Error(`TILT production configuration is invalid: ${issues.join(", ")}`);
}
