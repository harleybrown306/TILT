import { canonicalApplicationUrl } from "@/lib/application-origin";

/**
 * Browser-side Auth links use the build-time public canonical origin in
 * production, never the browser's current (possibly preview) hostname.
 */
export function authCallbackOrigin(value = process.env.NEXT_PUBLIC_TILT_APP_URL, production = process.env.NODE_ENV === "production") {
  const configured = canonicalApplicationUrl(value, production);
  if (configured.ok) return configured.value.origin;
  return production ? null : window.location.origin;
}
