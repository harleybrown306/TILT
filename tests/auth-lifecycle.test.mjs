import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
function load(path, mocks = {}) {
  const source = ts.transpileModule(readFileSync(root + path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS } }).outputText;
  const loaded = { exports: {} };
  new vm.Script(`(function(require, module, exports) {${source}\n})`).runInThisContext()((name) => name in mocks ? mocks[name] : require(name), loaded, loaded.exports);
  return loaded.exports;
}
const auth = load("src/lib/auth-continuation.ts");
const token = "a".repeat(64);

test("auth continuation accepts only invitations, recovery, and root", () => {
  assert.equal(auth.safeAuthContinuation(`/invite/${token}`), `/invite/${token}`);
  assert.equal(auth.safeAuthContinuation("/reset-password"), "/reset-password");
  for (const value of [null, "https://evil.test", "//evil.test", "/teams/new", `/invite/${token}?next=https://evil.test`, "/invite/short", "/invite/%2f%2fevil.test"]) assert.equal(auth.safeAuthContinuation(value), "/");
});

test("login and signup preserve only validated invitation continuation", () => {
  assert.equal(auth.authPath("/signup", `/invite/${token}`), `/signup?next=${encodeURIComponent(`/invite/${token}`)}`);
  assert.equal(auth.authPath("/login", "https://evil.test"), "/login");
});

test("account lifecycle source keeps profile, role, and summaries out of browser input", () => {
  const signup = readFileSync(root + "src/app/signup/page.tsx", "utf8");
  assert.match(signup, /data: \{ full_name: fullName\.trim\(\) \}/);
  assert.doesNotMatch(signup, /platform_role|team_memberships|service_role/);
  assert.match(signup, /auth\.signUp/);
  assert.match(signup, /auth\/callback/);
  const callback = readFileSync(root + "src/app/auth/callback/route.ts", "utf8");
  assert.match(callback, /exchangeCodeForSession\(code\)/);
  assert.doesNotMatch(callback, /console\./);
});

test("recovery uses callback reset destination and neutral success language", () => {
  const forgot = readFileSync(root + "src/app/forgot-password/page.tsx", "utf8");
  assert.match(forgot, /resetPasswordForEmail/);
  assert.match(forgot, /auth\/callback\?next=/);
  assert.match(forgot, /If an account exists for that email/);
  const callback = readFileSync(root + "src/app/auth/callback/route.ts", "utf8");
  assert.match(callback, /redirectType !== "recovery"/);
  assert.match(callback, /httpOnly: true/);
  const reset = readFileSync(root + "src/app/reset-password/actions.ts", "utf8");
  assert.match(reset, /tilt_password_recovery/);
  assert.match(reset, /auth\.updateUser\(\{ password \}\)/);
  assert.match(reset, /password !== confirmation/);
});

test("server action modules export only async functions", () => {
  const actions = readFileSync(root + "src/app/reset-password/actions.ts", "utf8");
  assert.match(actions, /^"use server";/);
  assert.match(actions, /export async function resetPassword/);
  assert.doesNotMatch(actions, /^export\s+(?:const|let|type|class|interface)\b/m);
});

function loadCallback({ redirectType, exchangedCookies = [] }) {
  const setCookies = [];
  const callback = load("src/app/auth/callback/route.ts", {
    "next/headers": { cookies: async () => ({ getAll: () => [{ name: "pkce", value: "verifier" }] }) },
    "@supabase/ssr": { createServerClient: (_url, _key, options) => ({ auth: { exchangeCodeForSession: async () => {
      options.cookies.setAll(exchangedCookies);
      return { data: { user: {}, session: {}, redirectType }, error: null };
    } } }) },
    "next/server": {
      NextResponse: {
        redirect: (url) => ({
          url: String(url),
          cookies: { set: (name, value, options) => setCookies.push({ name, value, options }) },
        }),
      },
    },
    "@/lib/auth-continuation": auth,
  });
  return { callback, setCookies };
}

test("recovery callback returns Supabase session cookies and recovery intent together", async () => {
  const { callback, setCookies } = loadCallback({ redirectType: "recovery", exchangedCookies: [{ name: "sb-session", value: "session", options: { httpOnly: true } }] });
  const response = await callback.GET(new Request("https://tilt.test/auth/callback?code=fresh&next=/reset-password"));
  assert.equal(response.url, "https://tilt.test/reset-password");
  assert.deepEqual(setCookies.map(({ name }) => name), ["sb-session", "tilt_password_recovery"]);
});

test("non-recovery callback cannot reach reset-password or set recovery intent", async () => {
  const { callback, setCookies } = loadCallback({ redirectType: null });
  const response = await callback.GET(new Request("https://tilt.test/auth/callback?code=confirmation&next=/reset-password"));
  assert.equal(response.url, "https://tilt.test/login?auth=error");
  assert.equal(setCookies.some(({ name }) => name === "tilt_password_recovery"), false);
});

test("reset page keeps recovery intent insufficient without an authenticated user", () => {
  const page = readFileSync(root + "src/app/reset-password/page.tsx", "utf8");
  assert.match(page, /if \(!user \|\| cookieStore\.get\("tilt_password_recovery"\)/);
});

function loadResetAction({ recoveryIntent = true, user = { id: "user" } } = {}) {
  const deleted = [];
  const updates = [];
  const action = load("src/app/reset-password/actions.ts", {
    "next/headers": { cookies: async () => ({ get: () => recoveryIntent ? { value: "1" } : undefined, delete: (name) => deleted.push(name) }) },
    "next/navigation": { redirect: (destination) => { throw Error(`REDIRECT:${destination}`); } },
    "@/lib/supabase/server": { createClient: async () => ({ auth: { getUser: async () => ({ data: { user }, error: null }), updateUser: async (attributes) => { updates.push(attributes); return { error: null }; } } }) },
  }).resetPassword;
  return { action, deleted, updates };
}

test("successful password reset clears recovery intent and redirects to its success route", async () => {
  const { action, deleted, updates } = loadResetAction();
  const form = new FormData(); form.set("password", "new-password"); form.set("confirmation", "new-password");
  await assert.rejects(action({ status: "idle", message: "" }, form), /REDIRECT:\/reset-password\/success/);
  assert.deepEqual(updates, [{ password: "new-password" }]);
  assert.deepEqual(deleted, ["tilt_password_recovery"]);
});

test("reset action still rejects missing recovery intent and missing authenticated user", async () => {
  const form = new FormData(); form.set("password", "new-password"); form.set("confirmation", "new-password");
  for (const options of [{ recoveryIntent: false }, { user: null }]) {
    const { action, deleted, updates } = loadResetAction(options);
    const result = await action({ status: "idle", message: "" }, form);
    assert.equal(result.status, "error"); assert.equal(updates.length, 0); assert.equal(deleted.length, 0);
  }
});

test("password-reset success route is independent of recovery intent", () => {
  const success = readFileSync(root + "src/app/reset-password/success/page.tsx", "utf8");
  assert.match(success, /Password updated successfully/);
  assert.match(success, /href="\/"/);
  assert.doesNotMatch(success, /tilt_password_recovery|createClient|cookies/);
});
