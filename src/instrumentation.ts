import { assertProductionRuntimeConfiguration } from "@/lib/production-config";

/** Runs once per Next.js server instance, before it begins handling requests. */
export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") assertProductionRuntimeConfiguration();
}
