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

const boundary = load("src/lib/invitation-delivery-boundary.ts", {
  "server-only": {},
  "@/lib/invitation-communication": {},
  "@/lib/operational-log": { createOperationalReference: () => "reference", logOperationalFailure: () => {} },
  "@/lib/supabase/service": {},
  "@/lib/verified-auth-identity": {},
});
const migration = readFileSync(new URL("supabase/migrations/20261006132705_phase20b_invitation_delivery_wiring.sql", root), "utf8");

test("delivery status copy is truthful and safe delivery does not undo a created invitation", async () => {
  assert.match(boundary.deliveryRequestMessage("accepted"), /does not confirm inbox delivery/i);
  assert.match(boundary.deliveryRequestMessage("rejected"), /copy-link fallback/i);
  assert.match(boundary.deliveryRequestMessage("unavailable"), /not configured|could not be confirmed/i);
  assert.equal(await boundary.attemptCreatedInvitationDelivery({ kind: "guardian", invitationId: "id", invitationPath: "/guardian-invite/x", expiresAt: "2030-01-01T00:00:00Z" }), "ambiguous");
});

test("reservation failures remain truthful rather than claiming a rate limit", async () => {
  const delivery = load("src/lib/invitation-delivery-boundary.ts", {
    "server-only": {},
    "@/lib/invitation-communication": {
      canonicalInvitationUrl: () => "https://app.example.test/invite/token",
      DisabledInvitationMailer: class {},
      renderInvitationEmail: () => ({ to: "recipient@example.test", subject: "TILT", text: "link" }),
    },
    "@/lib/operational-log": { createOperationalReference: () => "reference", logOperationalFailure: () => {} },
    "@/lib/supabase/service": { createServiceClient: () => ({ rpc: async () => ({ data: null, error: { message: "connection lost" } }) }) },
    "@/lib/verified-auth-identity": { getCurrentVerifiedAuthIdentity: async () => ({ authUserId: "actor", verifiedEmail: "actor@example.test" }) },
  });
  const request = { kind: "assistant_coach", invitationId: "id", invitationPath: "/invite/token", expiresAt: "2030-01-01T00:00:00Z" };
  assert.equal(await delivery.deliverCreatedInvitation(request), "ambiguous");
});

test("replacement RPCs atomically revoke the old link before minting a new record", () => {
  for (const name of ["replace_assistant_coach_invitation", "replace_family_team_invitation", "replace_guardian_invitation", "replace_child_login_invitation"]) {
    assert.match(migration, new RegExp(`CREATE FUNCTION public\\.${name}`));
    assert.match(migration, new RegExp(`ALTER FUNCTION public\\.${name}[\\s\\S]*OWNER TO postgres`));
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}[\\s\\S]*FROM PUBLIC, anon, authenticated`));
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}[\\s\\S]*TO authenticated`));
  }
  assert.match(migration, /PERFORM public\.revoke_family_team_invitation\(p_invitation_id\);[\s\S]*RETURN QUERY SELECT \* FROM public\.create_family_team_invitation/);
  assert.match(migration, /PERFORM public\.revoke_guardian_invitation\(p_invitation_id\);[\s\S]*RETURN QUERY SELECT \* FROM public\.create_guardian_invitation/);
  assert.match(migration, /PERFORM public\.revoke_child_login_invitation\(p_invitation_id\);[\s\S]*RETURN QUERY SELECT \* FROM public\.create_child_login_invitation/);
  assert.match(migration, /UPDATE public\.team_invitations SET status = 'revoked'[\s\S]*INSERT INTO public\.team_invitations/);
  assert.doesNotMatch(migration, /token_hash[^\n]*RETURN|RETURN[^\n]*token_hash/i);
});

test("all supported creation surfaces use the post-commit boundary and replacement mints a new link", () => {
  for (const path of [
    "src/app/teams/[teamId]/roster/actions.ts",
    "src/app/athletes/[athleteId]/guardians/actions.ts",
    "src/app/athletes/[athleteId]/child-login/actions.ts",
  ]) {
    const source = readFileSync(new URL(path, root), "utf8");
    assert.match(source, /attemptCreatedInvitationDelivery/);
    assert.match(source, /deliveryRequestMessage/);
  }
  for (const path of [
    "src/app/teams/[teamId]/roster/page.tsx",
    "src/app/athletes/[athleteId]/guardians/page.tsx",
    "src/app/athletes/[athleteId]/child-login/page.tsx",
  ]) assert.match(readFileSync(new URL(path, root), "utf8"), /Replace and attempt delivery/);
});
