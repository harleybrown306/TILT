import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
function load(path) {
  const source = ts.transpileModule(readFileSync(root + path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS } }).outputText;
  const loaded = { exports: {} };
  new vm.Script(`(function(require, module, exports) {${source}\n})`).runInThisContext()((name) => require(name), loaded, loaded.exports);
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
