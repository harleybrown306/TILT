import { releaseIdentity, runtimeConfigurationIssues } from "@/lib/production-config";

export const dynamic = "force-dynamic";

/**
 * Public, dependency-free liveness/readiness surface. Configuration details,
 * database state, users, and secrets are intentionally not disclosed.
 */
export function GET() {
  const ready = runtimeConfigurationIssues().length === 0;
  const release = releaseIdentity();
  return Response.json(
    ready ? { status: "ok", ...(release ? { release } : {}) } : { status: "unavailable" },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
