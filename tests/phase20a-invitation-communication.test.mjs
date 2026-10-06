import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);

function load(path, mocks = {}) {
  const source = ts.transpileModule(readFileSync(new URL(path, root), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const loaded = { exports: {} };
  new vm.Script(`(function(require,module,exports){${source}\n})`).runInThisContext()((name) => name in mocks ? mocks[name] : require(name), loaded, loaded.exports);
  return loaded.exports;
}

const communication = load("src/lib/invitation-communication.ts", { "server-only": {} });
const migration = readFileSync(new URL("supabase/migrations/20261005000000_phase20a_invitation_delivery_foundation.sql", root), "utf8");

test("canonical application URL is explicit, origin-only, and production-safe", () => {
  assert.deepEqual(communication.canonicalApplicationUrl(undefined, false), { ok: false, reason: "missing" });
  for (const value of ["not a url", "https://user:pass@example.com", "https://example.com/path", "https://example.com/?x=1", "https://example.com/#token"]) assert.equal(communication.canonicalApplicationUrl(value, false).ok, false);
  assert.equal(communication.canonicalApplicationUrl("http://localhost:3000", true).ok, false);
  assert.equal(communication.canonicalApplicationUrl("http://127.0.0.1:3000", true).ok, false);
  const config = communication.canonicalApplicationUrl("https://app.tilt.example", true);
  assert.deepEqual(config, { ok: true, value: { origin: "https://app.tilt.example" } });
  assert.equal(communication.canonicalInvitationUrl(`/guardian-invite/${"a".repeat(64)}`, config), `https://app.tilt.example/guardian-invite/${"a".repeat(64)}`);
  assert.equal(communication.canonicalInvitationUrl("https://attacker.example", config), null);
});

test("fake mailer is deterministic and the production mailer fails closed", async () => {
  const fake = new communication.FakeInvitationMailer([{ kind: "rejected" }, { kind: "ambiguous" }]);
  const message = { to: "recipient@example.test", subject: "TILT", text: "bearer-url-in-isolated-test" };
  assert.deepEqual(await fake.send(message), { kind: "rejected" });
  assert.deepEqual(await fake.send(message), { kind: "ambiguous" });
  assert.equal(fake.messages().length, 2);
  assert.deepEqual(await new communication.DisabledInvitationMailer().send(message), { kind: "unavailable" });
});

test("templates are concise, typed, and do not disclose child identity in a subject", () => {
  const url = `https://app.tilt.example/child-login-invite/${"a".repeat(64)}`;
  for (const kind of communication.invitationKinds) {
    const email = communication.renderInvitationEmail({ kind, recipient: "recipient@example.test", invitationUrl: url, expiresAt: "2030-01-01T00:00:00Z", teamName: "Thunder" });
    assert.match(email.subject, /TILT/i);
    assert.match(email.text, /verified email address/i);
    assert.match(email.text, /ignore this email/i);
    assert.match(email.text, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const child = communication.renderInvitationEmail({ kind: "child_self_login", recipient: "recipient@example.test", invitationUrl: url, expiresAt: "2030-01-01T00:00:00Z", teamName: "Avery's team" });
  assert.doesNotMatch(child.subject, /Avery|Thunder|child/i);
});

test("delivery state is protected, durable, and rate limited without token persistence", () => {
  for (const table of ["team_invitations", "family_team_invitations", "guardian_invitations", "child_login_invitations"]) {
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table}[\\s\\S]*delivery_attempt_count[\\s\\S]*last_delivery_attempt_at[\\s\\S]*last_delivery_accepted_at`));
  }
  assert.match(migration, /delivery_attempt_timestamps timestamptz\[\]/);
  assert.match(migration, /invitation_delivery_actor_rate_state/);
  assert.match(migration, /interval '10 minutes'/);
  assert.match(migration, /array_length\(v_recent,1\).*>=5/);
  assert.match(migration, /array_length\(v_actor_recent,1\).*>=20/);
  assert.match(migration, /Invitation delivery state is server controlled/);
  assert.match(migration, /RETURNS trigger LANGUAGE plpgsql SET search_path TO ''/);
  assert.match(migration, /current_user <> 'postgres'/);
  assert.match(migration, /ALTER FUNCTION public\.server_reserve_invitation_delivery_attempt\(uuid,text,text,uuid\) OWNER TO postgres/);
  assert.match(migration, /ALTER FUNCTION public\.server_mark_invitation_delivery_accepted\(uuid,text,text,uuid\) OWNER TO postgres/);
  assert.doesNotMatch(migration, /app\.phase20a_delivery_write|set_config\(/);
  assert.match(migration, /GRANT EXECUTE[\s\S]*TO service_role/);
  assert.match(migration, /RETURNS TABLE\(result text, recipient text\)/);
  assert.doesNotMatch(migration, /token_hash.*delivery|delivery.*token_hash|provider.*message|raw provider/i);
});

test("ordinary invitation reads never receive bearer-token verifiers", () => {
  for (const table of ["team_invitations", "family_team_invitations", "guardian_invitations", "child_login_invitations"]) {
    assert.match(migration, new RegExp(`REVOKE SELECT ON TABLE public\\.${table} FROM PUBLIC, anon, authenticated;`));
  }
  for (const table of ["team_invitations", "family_team_invitations"]) {
    const grant = migration.match(new RegExp(`GRANT SELECT \\(([\\s\\S]*?)\\) ON TABLE public\\.${table} TO authenticated;`));
    assert.ok(grant, `${table} safe-column grant is present`);
    assert.doesNotMatch(grant[1], /token_hash/);
  }
  assert.doesNotMatch(migration, /GRANT SELECT ON TABLE public\.(?:team_invitations|family_team_invitations|guardian_invitations|child_login_invitations) TO authenticated/);
});

test("the internal delivery boundary cannot select a resend recipient", () => {
  const boundary = readFileSync(new URL("src/lib/invitation-delivery-boundary.ts", root), "utf8");
  assert.doesNotMatch(boundary, /recipient:\s*string/);
  assert.match(boundary, /reserved\.data\?\.\[0\]\?\.recipient/);
  assert.match(boundary, /import "server-only"/);
});

test("all bearer invitation routes declare no-referrer metadata and the manual copy-link components remain unchanged", () => {
  for (const route of ["src/app/invite/[token]/page.tsx", "src/app/family-invite/[token]/page.tsx", "src/app/guardian-invite/[token]/page.tsx", "src/app/child-login-invite/[token]/page.tsx"]) {
    assert.match(readFileSync(new URL(route, root), "utf8"), /referrer:\s*"no-referrer"/);
  }
  const copyForm = readFileSync(new URL("src/components/family-invitation-action-form.tsx", root), "utf8");
  assert.match(copyForm, /Copy invitation link/);
  assert.match(copyForm, /window\.location\.origin/);
});
