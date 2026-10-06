export type CanonicalApplicationUrl = { origin: string };
export type CanonicalApplicationUrlResult =
  | { ok: true; value: CanonicalApplicationUrl }
  | { ok: false; reason: "missing" | "malformed" | "unsafe" };

const loopbackHosts = new Set(["localhost", "::1", "0.0.0.0", "127.0.0.1"]);

function isLoopback(hostname: string) {
  return loopbackHosts.has(hostname) || /^127\./.test(hostname) || /^::ffff:127\./i.test(hostname);
}

/**
 * Validates an explicitly configured origin. It never derives an origin from a
 * request, Host, or forwarded header.
 */
export function canonicalApplicationUrl(value: string | undefined, production = process.env.NODE_ENV === "production"): CanonicalApplicationUrlResult {
  if (!value) return { ok: false, reason: "missing" };
  let url: URL;
  try { url = new URL(value); } catch { return { ok: false, reason: "malformed" }; }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return { ok: false, reason: "unsafe" };
  if (!["http:", "https:"].includes(url.protocol)) return { ok: false, reason: "unsafe" };
  if (production && (url.protocol !== "https:" || isLoopback(url.hostname.toLowerCase()))) return { ok: false, reason: "unsafe" };
  return { ok: true, value: { origin: url.origin } };
}
