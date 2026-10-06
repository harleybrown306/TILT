import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);

function source(path) {
  return readFileSync(new URL(path, root), "utf8");
}

test("every bearer invitation route has HTTP no-referrer and no-store protections", () => {
  const config = source("next.config.ts");
  for (const route of ["/invite/:path*", "/family-invite/:path*", "/guardian-invite/:path*", "/child-login-invite/:path*"]) {
    assert.match(config, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(config, /Referrer-Policy", value: "no-referrer"/);
  assert.match(config, /Cache-Control", value: "private, no-store, max-age=0"/);
});

test("the authorization-code callback does not cache or refer the callback URL", () => {
  const callback = source("src/app/auth/callback/route.ts");
  assert.match(callback, /response\.headers\.set\("Cache-Control", "private, no-store, max-age=0"\)/);
  assert.match(callback, /response\.headers\.set\("Referrer-Policy", "no-referrer"\)/);
  assert.match(callback, /return sensitiveAuthResponse\(NextResponse\.redirect\(destination\)\)/);
  assert.match(callback, /return sensitiveAuthResponse\(response\)/);
});

test("application diagnostics use only the privacy-safe operational logger", () => {
  const appSources = [
    "src/app/page.tsx",
    "src/app/training/[sessionId]/page.tsx",
    "src/app/teams/[teamId]/groups/page.tsx",
    "src/app/teams/[teamId]/groups/[groupId]/page.tsx",
    "src/app/teams/[teamId]/assign/actions.ts",
    "src/app/teams/[teamId]/athletes/[athleteId]/page.tsx",
  ];
  for (const path of appSources) {
    const contents = source(path);
    assert.match(contents, /logOperationalFailure/);
    assert.doesNotMatch(contents, /console\.(?:log|info|warn|error)/);
  }
  const logger = source("src/lib/operational-log.ts");
  assert.match(logger, /Deliberately records only allowlisted operational facts/);
  assert.doesNotMatch(logger, /error\.(?:message|stack)/);
});
