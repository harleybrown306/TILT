import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

const historicalSql = readFileSync(new URL("../supabase/migrations/20260922024628_create_family_team_invitation_foundation.sql", import.meta.url), "utf8");
const intendedSql = readFileSync(new URL("../docs/database/create_family_team_invitation_foundation.intended.sql", import.meta.url), "utf8");
const forwardGrantSql = readFileSync(new URL("../supabase/migrations/20260922024629_grant_family_team_invitation_acceptance.sql", import.meta.url), "utf8");
const forwardEmailValidationSql = readFileSync(new URL("../supabase/migrations/20260922024630_fix_family_team_invitation_email_validation.sql", import.meta.url), "utf8");
const forwardEmailConstraintSql = readFileSync(new URL("../supabase/migrations/20260922024631_fix_family_team_invitation_email_constraint.sql", import.meta.url), "utf8");
const forwardTokenValidationSql = readFileSync(new URL("../supabase/migrations/20260922024632_fix_family_team_invitation_token_validation.sql", import.meta.url), "utf8");
const validator = readFileSync(new URL("database/validate_family_team_invitation_foundation.sql", import.meta.url), "utf8");
const sql = `${historicalSql}\n${forwardGrantSql}`;

test("migration provenance matches the remote payload and isolates the omitted grant", () => {
  assert.equal(
    createHash("sha256").update(historicalSql).digest("hex"),
    "0bffa69963b8686a3468ac96afafdd7f2dd3a877ab6b136a397875cf4b0148ed",
  );
  assert.ok(intendedSql.startsWith(historicalSql));
  assert.match(intendedSql, /GRANT EXECUTE ON FUNCTION public\.accept_family_team_invitation\(text, uuid, text, text, integer\) TO authenticated;/);
  assert.equal(forwardGrantSql.trim(), "GRANT EXECUTE ON FUNCTION public.accept_family_team_invitation(text, uuid, text, text, integer) TO authenticated;");
});

test("forward email-validation repair changes only the creator regex semantics", () => {
  const defectiveRegex = "'^[^[:space:]@]+@[^[:space:]@]+\\\\.[^[:space:]@]+$'";
  const correctedRegex = "E'^[^[:space:]@]+@[^[:space:]@]+\\\\.[^[:space:]@]+$'";
  assert.match(forwardEmailValidationSql, /CREATE OR REPLACE FUNCTION public\.create_family_team_invitation\(\s+p_team_id uuid,\s+p_invited_email text,\s+p_token_hash text,\s+p_expires_at timestamptz DEFAULT \(clock_timestamp\(\) \+ interval '7 days'\)\s+\)/);
  assert.ok(forwardEmailValidationSql.includes(correctedRegex));
  assert.ok(!forwardEmailValidationSql.includes("v_email !~ " + defectiveRegex));
  assert.match(forwardEmailValidationSql, /RETURNS TABLE\(invitation_id uuid, expires_at timestamptz\)\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path TO ''/);
  assert.doesNotMatch(forwardEmailValidationSql, /\b(?:GRANT|REVOKE)\b/);
  assert.equal((forwardEmailValidationSql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 1);
  assert.equal(createHash("sha256").update(historicalSql).digest("hex"), "0bffa69963b8686a3468ac96afafdd7f2dd3a877ab6b136a397875cf4b0148ed");
  assert.equal(forwardGrantSql.trim(), "GRANT EXECUTE ON FUNCTION public.accept_family_team_invitation(text, uuid, text, text, integer) TO authenticated;");
});

test("forward email-constraint repair changes only the normalized-email check", () => {
  const defectiveRegex = "'^[^[:space:]@]+@[^[:space:]@]+\\\\.[^[:space:]@]+$'";
  const correctedRegex = "E'^[^[:space:]@]+@[^[:space:]@]+\\\\.[^[:space:]@]+$'";
  assert.match(forwardEmailConstraintSql, /ALTER TABLE public\.family_team_invitations\s+DROP CONSTRAINT family_team_invitations_email_normalized;/);
  assert.match(forwardEmailConstraintSql, /ALTER TABLE public\.family_team_invitations\s+ADD CONSTRAINT family_team_invitations_email_normalized\s+CHECK/);
  assert.ok(forwardEmailConstraintSql.includes(correctedRegex));
  assert.ok(!forwardEmailConstraintSql.includes("invited_email ~ " + defectiveRegex));
  assert.match(forwardEmailConstraintSql, /invited_email = lower\(btrim\(invited_email\)\)/);
  assert.doesNotMatch(forwardEmailConstraintSql, /\b(?:CREATE|REPLACE|FUNCTION|GRANT|REVOKE|POLICY|ROW LEVEL SECURITY|team_invitations|accept_team_invitation)\b/);
  assert.equal(createHash("sha256").update(historicalSql).digest("hex"), "0bffa69963b8686a3468ac96afafdd7f2dd3a877ab6b136a397875cf4b0148ed");
  assert.equal(createHash("sha256").update(forwardEmailValidationSql).digest("hex"), "ae7ada749b4f7264f0ded8ac1f8943d90029cbeeebd61b0e2de782aaf298a1fd");
  assert.equal(forwardGrantSql.trim(), "GRANT EXECUTE ON FUNCTION public.accept_family_team_invitation(text, uuid, text, text, integer) TO authenticated;");
});

test("forward token-validation repair changes only the two family invitation token predicates", () => {
  const defectivePredicate = "p_invitation_token IS NULL OR p_invitation_token !~ '^[A-Za-z0-9_-]{32,256}$'";
  const correctedPredicate = "p_invitation_token IS NULL\n     OR char_length(p_invitation_token) NOT BETWEEN 32 AND 256\n     OR p_invitation_token !~ '^[A-Za-z0-9_-]+$'";
  const historicalFunctions = historicalSql.slice(
    historicalSql.indexOf("CREATE OR REPLACE FUNCTION public.get_family_team_invitation_summary"),
    historicalSql.indexOf("ALTER FUNCTION public.create_family_team_invitation"),
  );
  assert.equal(
    forwardTokenValidationSql.trim(),
    historicalFunctions.replaceAll(defectivePredicate, () => correctedPredicate).trim(),
  );
  assert.equal((forwardTokenValidationSql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 2);
  assert.match(forwardTokenValidationSql, /CREATE OR REPLACE FUNCTION public\.get_family_team_invitation_summary\(p_invitation_token text\)/);
  assert.match(forwardTokenValidationSql, /CREATE OR REPLACE FUNCTION public\.accept_family_team_invitation\(\s+p_invitation_token text,\s+p_existing_athlete_id uuid DEFAULT NULL,\s+p_first_name text DEFAULT NULL,\s+p_last_name text DEFAULT NULL,\s+p_graduation_year integer DEFAULT NULL\s+\)/);
  assert.equal((forwardTokenValidationSql.match(/char_length\(p_invitation_token\) NOT BETWEEN 32 AND 256/g) ?? []).length, 2);
  assert.equal((forwardTokenValidationSql.match(/p_invitation_token !~ '\^\[A-Za-z0-9_-\]\+\$'/g) ?? []).length, 2);
  assert.doesNotMatch(forwardTokenValidationSql, /\{32,256\}/);
  assert.match(forwardTokenValidationSql, /RETURNS TABLE\(team_name text, expires_at timestamptz, invitation_status public\.team_invitation_status\)\s+LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER\s+SET search_path TO ''/);
  assert.match(forwardTokenValidationSql, /RETURNS TABLE\(team_id uuid, athlete_id uuid\)\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path TO ''/);
  assert.doesNotMatch(forwardTokenValidationSql, /\b(?:GRANT|REVOKE|ALTER TABLE|CREATE TABLE|POLICY|ROW LEVEL SECURITY|team_invitations|accept_team_invitation)\b/);
  assert.match(historicalSql, /token_hash ~ '\^\[a-f0-9\]\{64\}\$'/);
  assert.equal(createHash("sha256").update(historicalSql).digest("hex"), "0bffa69963b8686a3468ac96afafdd7f2dd3a877ab6b136a397875cf4b0148ed");
  assert.equal(createHash("sha256").update(forwardGrantSql).digest("hex"), "9a54d340906b45cd0eba46ada8b3662042a7239753d8c38196171127d7bc01d6");
  assert.equal(createHash("sha256").update(forwardEmailValidationSql).digest("hex"), "ae7ada749b4f7264f0ded8ac1f8943d90029cbeeebd61b0e2de782aaf298a1fd");
  assert.equal(createHash("sha256").update(forwardEmailConstraintSql).digest("hex"), "44e41aa4919872dcb1f3445f502e13c052c4e780dd73e91387ff23d381996270");
  const familyInvitationMigrations = readdirSync(new URL("../supabase/migrations/", import.meta.url))
    .filter((name) => /^202609220246(?:28|29|30|31|32)_/.test(name))
    .sort();
  assert.deepEqual(familyInvitationMigrations, [
    "20260922024628_create_family_team_invitation_foundation.sql",
    "20260922024629_grant_family_team_invitation_acceptance.sql",
    "20260922024630_fix_family_team_invitation_email_validation.sql",
    "20260922024631_fix_family_team_invitation_email_constraint.sql",
    "20260922024632_fix_family_team_invitation_token_validation.sql",
  ]);
});

test("family invitations are additive, durable-roster based, and do not repurpose legacy invitations", () => {
  assert.match(sql, /CREATE TABLE public\.family_team_invitations/);
  assert.match(sql, /team_id uuid NOT NULL REFERENCES public\.teams/);
  assert.match(sql, /accepted_athlete_id uuid REFERENCES public\.athletes/);
  assert.match(sql, /CREATE UNIQUE INDEX family_team_invitations_one_pending_per_email/);
  assert.match(sql, /ON public\.family_team_invitations \(team_id, invited_email\)\s+WHERE status = 'pending';/);
  assert.doesNotMatch(sql, /ALTER TABLE public\.team_invitations/);
  assert.doesNotMatch(sql, /DROP TABLE public\.team_invitations/);
  assert.doesNotMatch(sql, /INSERT INTO public\.team_memberships/);
  assert.doesNotMatch(sql, /CREATE TABLE public\.profiles/);
});

test("all invitation lifecycle mutations are narrow current-actor SECURITY DEFINER RPCs", () => {
  for (const signature of [
    "create_family_team_invitation(uuid, text, text, timestamptz)",
    "revoke_family_team_invitation(uuid)",
    "get_family_team_invitation_summary(text)",
    "accept_family_team_invitation(text, uuid, text, text, integer)",
  ]) {
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature.replace(/[()]/g, "\\$&").replace(/ /g, "\\s+")}`));
  }
  assert.match(sql, /SECURITY DEFINER\s+SET search_path TO ''/);
  assert.match(sql, /v_actor uuid := \(SELECT auth\.uid\(\)\)/);
  assert.match(sql, /private\.can_manage_roster\(p_team_id, v_actor\)/);
  assert.match(sql, /private\.can_manage_roster\(v_invitation\.team_id, v_invitation\.invited_by_profile_id\)/);
  const acceptance = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.accept_family_team_invitation"));
  assert.doesNotMatch(acceptance, /p_(?:actor|profile|guardian|coach|permission)_id/);
});

test("tokens are hash-only and summaries are authenticated minimal projections", () => {
  assert.match(sql, /token_hash text NOT NULL UNIQUE/);
  assert.match(sql, /token_hash ~ '\^\[a-f0-9\]\{64\}\$'/);
  assert.match(sql, /extensions\.digest\(p_invitation_token, 'sha256'\)/);
  assert.match(sql, /IF \(SELECT auth\.uid\(\)\) IS NULL/);
  const summary = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.get_family_team_invitation_summary"), sql.indexOf("CREATE OR REPLACE FUNCTION public.accept_family_team_invitation"));
  assert.match(summary, /RETURNS TABLE\(team_name text, expires_at timestamptz, invitation_status/);
  assert.doesNotMatch(summary.slice(0, summary.indexOf("LANGUAGE plpgsql")), /invited_email|token_hash/);
  assert.match(sql, /GRANT SELECT \([\s\S]*invited_email[\s\S]*\) ON public\.family_team_invitations TO authenticated/);
  assert.doesNotMatch(sql, /GRANT SELECT ON public\.family_team_invitations TO authenticated/);
});

test("acceptance verifies email, authority, athlete management, and preserves actor-subject separation", () => {
  const acceptance = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.accept_family_team_invitation"));
  assert.match(acceptance, /user_record\.email_confirmed_at/);
  assert.match(acceptance, /lower\(v_email\) <> v_invitation\.invited_email/);
  assert.match(acceptance, /FOR UPDATE/);
  assert.match(acceptance, /private\.can_manage_athlete\(p_existing_athlete_id\)/);
  assert.match(acceptance, /athlete\.status = 'active'/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION private\.create_guardian_managed_athlete/);
  assert.match(sql, /RETURN private\.create_guardian_managed_athlete\([\s\S]*v_profile_id, p_first_name, p_last_name, p_graduation_year/);
  assert.match(acceptance, /private\.create_guardian_managed_athlete\([\s\S]*v_actor, p_first_name, p_last_name, p_graduation_year/);
  assert.match(sql, /REVOKE ALL ON FUNCTION private\.create_guardian_managed_athlete/);
  assert.match(acceptance, /INSERT INTO public\.team_athlete_memberships/);
  assert.doesNotMatch(acceptance, /public\.team_memberships|auth\.users\s*\(|INSERT INTO public\.profiles|role, 'self'/);
});

test("acceptance serializes durable roster enrollment and validator covers rollback-only security cases", () => {
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /accepted_by_profile_id = v_actor, accepted_athlete_id = v_athlete_id/);
  for (const phrase of [
    "wrong email accepted invitation", "inviter authority loss did not block acceptance", "View-only athlete",
    "archived athlete", "accepted invitation replay succeeded", "direct invitation write was not denied",
    "new child violated family-first invariants", "failed acceptance did not roll back",
  ]) assert.match(validator, new RegExp(phrase));
  assert.doesNotMatch(validator, /INSERT INTO public\.team_memberships\(team_id, user_id, role, created_by_user_id\) VALUES \(team_id, manager_id, 'coach', manager_id\);/);
  assert.match(validator, /on_team_created already creates the manager's coach membership/);
  assert.match(validator, /validator_team_id uuid/);
  assert.match(validator, /membership\.team_id = validator_team_id/);
  assert.doesNotMatch(validator, /membership\.team_id = team_id/);
  assert.match(validator, /validator_token_hash text/);
  assert.match(validator, /i\.token_hash=validator_token_hash/);
  assert.doesNotMatch(validator, /i\.token_hash=token_hash/);
  assert.match(validator, /SELECT p\.id, u\.email INTO recipient_id, recipient_email/);
  assert.match(validator, /u\.email_confirmed_at IS NOT NULL/);
  assert.match(validator, /AND NOT private\.is_admin\(p\.id\)/);
  assert.match(validator, /Validator fixture error: requires a non-admin unrelated auth-backed profile/);
  assert.match(validator, /private\.can_manage_roster\(validator_team_id, unrelated_id\)/);
  assert.match(validator, /Validator fixture error: unrelated profile has roster-management authority/);
  const productionEquivalentEmailRegex = "'^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'";
  const incorrectTwoBackslashEmailRegex = "'^[^[:space:]@]+@[^[:space:]@]+\\\\.[^[:space:]@]+$'";
  assert.ok(validator.includes(`lower(btrim(u.email)) ~ ${productionEquivalentEmailRegex}`));
  assert.ok(!validator.includes(`lower(btrim(u.email)) ~ ${incorrectTwoBackslashEmailRegex}`));
  assert.match(validator, /Validator fixture error: requires a manager and confirmed production-valid recipient email/);
  const failedAcceptanceAssertion = validator.indexOf("failed acceptance did not roll back");
  const authorityLossMembershipDeletion = validator.lastIndexOf("DELETE FROM public.team_memberships AS m WHERE m.team_id=validator_team_id AND m.user_id=manager_id");
  const authorityLossAssertion = validator.indexOf("inviter authority loss did not block acceptance");
  assert.ok(failedAcceptanceAssertion >= 0 && failedAcceptanceAssertion < authorityLossMembershipDeletion);
  assert.ok(authorityLossMembershipDeletion < authorityLossAssertion);
  assert.match(validator, /same pending rollback fixture independently proves that later inviter-authority loss blocks acceptance/);
  assert.doesNotMatch(validator, /token := repeat\('d',64\)/);
  assert.ok(validator.lastIndexOf("auth.users") < validator.indexOf("SET LOCAL ROLE authenticated"));
  assert.match(validator, /BEGIN;/);
  assert.match(validator, /ROLLBACK;\s*$/);
});
