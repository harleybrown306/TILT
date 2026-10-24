import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);

function source(path) {
  return readFileSync(new URL(path, root), "utf8");
}

function appSourcePaths(directory = "src/app") {
  return readdirSync(new URL(`${directory}/`, root), { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory()
      ? appSourcePaths(`${directory}/${entry.name}`)
      : /\.(?:ts|tsx)$/.test(entry.name) ? [`${directory}/${entry.name}`] : []
  ));
}

function load(path, mocks = {}) {
  const compiled = ts.transpileModule(source(path), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const loaded = { exports: {} };
  new vm.Script(`(function(require,module,exports){${compiled}\n})`).runInThisContext()(
    (name) => name in mocks ? mocks[name] : require(name), loaded, loaded.exports,
  );
  return loaded.exports;
}

test("production configuration requires canonical Supabase and application origins without exposing values", () => {
  const origin = load("src/lib/application-origin.ts");
  const config = load("src/lib/production-config.ts", { "server-only": {}, "@/lib/application-origin": origin });
  const valid = {
    NODE_ENV: "production",
    NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable",
    TILT_APP_URL: "https://app.tilt.example",
    NEXT_PUBLIC_TILT_APP_URL: "https://app.tilt.example",
  };
  assert.deepEqual(config.runtimeConfigurationIssues(valid), []);
  assert.deepEqual(config.runtimeConfigurationIssues({ ...valid, NEXT_PUBLIC_TILT_APP_URL: "https://preview.tilt.example" }), ["canonical_application_origin_mismatch"]);
  assert.ok(config.runtimeConfigurationIssues({ ...valid, TILT_APP_URL: "http://localhost:3000" }).includes("canonical_application_origin"));
  assert.throws(() => config.assertProductionRuntimeConfiguration({ ...valid, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "" }), /supabase_publishable_key/);
});

test("health is dynamic, uncached, and omits readiness internals", () => {
  const route = source("src/app/api/health/route.ts");
  assert.match(route, /dynamic = "force-dynamic"/);
  assert.match(route, /Cache-Control": "no-store"/);
  assert.match(route, /status: "unavailable"/);
  assert.doesNotMatch(route, /SUPABASE_SERVICE_ROLE_KEY|process\.env\./);
});

test("production Auth redirects are configured rather than derived from browser or request hosts", () => {
  const signup = source("src/app/signup/page.tsx");
  const forgot = source("src/app/forgot-password/page.tsx");
  const callbackOrigin = source("src/lib/auth-callback-origin.ts");
  assert.match(signup, /canonicalAuthCallbackUrl/);
  assert.match(forgot, /canonicalAuthCallbackUrl/);
  assert.doesNotMatch(signup, /window\.location\.origin/);
  assert.doesNotMatch(forgot, /window\.location\.origin/);
  assert.match(callbackOrigin, /NEXT_PUBLIC_TILT_APP_URL/);
  assert.match(callbackOrigin, /production \? null : window\.location\.origin/);
  const callback = source("src/app/auth/callback/route.ts");
  assert.match(callback, /configuredApplicationUrl/);
  assert.match(callback, /new URL\(destination, origin\)/);
  assert.doesNotMatch(callback, /new URL\(destination, url\.origin\)/);
});

test("closed-beta team provisioning is enforced in UI, action, and database policy", () => {
  const dashboard = source("src/app/page.tsx");
  const page = source("src/app/teams/new/page.tsx");
  const action = source("src/app/teams/new/actions.ts");
  const migration = source("supabase/migrations/20261006150000_restrict_closed_beta_team_creation.sql");
  assert.match(dashboard, /profile\?\.platform_role === "admin"/);
  assert.match(page, /profile\?\.platform_role !== "admin"/);
  assert.match(action, /profile\?\.platform_role !== "admin"/);
  assert.match(migration, /drop policy if exists teams_insert_self_or_admin/);
  assert.match(migration, /create policy teams_insert_platform_admin_only/);
  assert.match(migration, /private\.is_admin/);
});

test("the disabled invitation transport exits safely before service-role use", () => {
  const boundary = source("src/lib/invitation-delivery-boundary.ts");
  assert.match(boundary, /mailer instanceof DisabledInvitationMailer\) return "unavailable"/);
});

test("service-role documentation covers every app-side invitation consumer", () => {
  const appConsumers = appSourcePaths().filter((path) => source(path).includes("createServiceClient"));
  assert.deepEqual(appConsumers.sort(), [
    "src/app/child-login-invite/[token]/actions.ts",
    "src/app/child-login-invite/[token]/page.tsx",
    "src/app/family-invite/[token]/actions.ts",
    "src/app/family-invite/[token]/page.tsx",
    "src/app/guardian-invite/[token]/actions.ts",
    "src/app/guardian-invite/[token]/page.tsx",
    "src/app/invite/[token]/page.tsx",
  ]);
  for (const path of appConsumers) assert.match(source(path), /createServiceClient\(\)/);
  assert.match(source("src/lib/invitation-delivery-boundary.ts"), /createServiceClient\(\)/);

  const environment = source(".env.example");
  const documentation = environment.replace(/\n#\s*/g, " ");
  assert.match(documentation, /team invitation summary/);
  assert.match(documentation, /guardian invitation summary\/acceptance/);
  assert.match(documentation, /child-login invitation summary\/acceptance/);
  assert.match(documentation, /family-team invitation summary\/acceptance/);
  assert.match(documentation, /enabled invitation-mail delivery/);
  assert.match(documentation, /Never place this value in a NEXT_PUBLIC_ variable/);
});
