import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";

const migrationName = "20260922194927_create_guardian_invitation_foundation.sql";
const sql = readFileSync(new URL(`../supabase/migrations/${migrationName}`, import.meta.url), "utf8");
const validator = readFileSync(new URL("database/validate_guardian_invitation_foundation.sql", import.meta.url), "utf8");
const provenance = readFileSync(new URL("../docs/database/create_guardian_invitation_foundation.md", import.meta.url), "utf8");

test("guardian invitation migration is the unique next canonical forward artifact", () => {
  const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter((name) => /guardian_invitation/.test(name));
  assert.deepEqual(migrations, [migrationName]);
  assert.match(provenance, new RegExp(migrationName));
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\s*$/);
});

test("guardian invitation lifecycle is independent, hash-only, immutable, and non-destructive", () => {
  assert.match(sql, /CREATE TABLE public\.guardian_invitations/);
  assert.match(sql, /athlete_id uuid NOT NULL REFERENCES public\.athletes\(id\) ON DELETE RESTRICT/);
  assert.match(sql, /inviter_profile_id uuid NOT NULL REFERENCES public\.profiles\(id\) ON DELETE RESTRICT/);
  assert.match(sql, /token_hash text NOT NULL CONSTRAINT guardian_invitations_token_hash_unique UNIQUE/);
  assert.match(sql, /token_hash ~ '\^\[a-f0-9\]\{64\}\$'/);
  assert.match(sql, /CREATE UNIQUE INDEX guardian_invitations_one_pending_per_email[\s\S]*\(athlete_id, invited_email\)[\s\S]*status = 'pending'/);
  assert.match(sql, /Guardian invitation identity fields cannot be changed/);
  assert.match(sql, /Accepted guardian invitation audit fields cannot be changed/);
  assert.match(sql, /Revoked guardian invitation audit fields cannot be changed/);
  assert.doesNotMatch(sql, /family_team_invitations/);
  assert.doesNotMatch(sql, /ON DELETE CASCADE/);
});

test("guardian-only MANAGE authority governs creation, revocation, and manager reads", () => {
  const create = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.create_guardian_invitation"), sql.indexOf("CREATE OR REPLACE FUNCTION public.get_guardian_invitation_summary"));
  const revoke = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.revoke_guardian_invitation"), sql.indexOf("CREATE OR REPLACE FUNCTION public.list_my_guardian_invitations"));
  const guardianAuthority = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION private.can_manage_guardian_invitation"), sql.indexOf("CREATE OR REPLACE FUNCTION private.validate_guardian_invitation_update"));
  assert.match(guardianAuthority, /relationship\.profile_id = \(SELECT auth\.uid\(\)\)/);
  assert.match(guardianAuthority, /relationship\.role = 'guardian'/);
  assert.match(guardianAuthority, /relationship\.revoked_at IS NULL/);
  assert.match(guardianAuthority, /relationship\.manage_permission/);
  assert.doesNotMatch(guardianAuthority, /is_admin|team_staff_memberships|role = 'self'/);
  assert.match(create, /private\.can_manage_guardian_invitation\(p_athlete_id\)/);
  assert.match(create, /athlete\.status = 'active'/);
  assert.match(create, /p_expires_at > CURRENT_TIMESTAMP \+ interval '7 days'/);
  assert.match(create, /Cannot invite your own email/);
  assert.match(create, /lower\(btrim\(v_actor_email\)\) = v_email/);
  assert.match(create, /pg_advisory_xact_lock/);
  assert.match(create, /SET status = 'expired'/);
  assert.match(create, /Guardian invitation token is unavailable/);
  assert.match(create, /v_constraint_name = 'guardian_invitations_token_hash_unique'/);
  assert.match(revoke, /private\.can_manage_guardian_invitation\(v_invitation\.athlete_id\)/);
  assert.doesNotMatch(`${create}\n${revoke}`, /team_staff_memberships|is_admin/);
});

test("summary protects minor identity and acceptance grants only fixed VIEW guardian access", () => {
  const summary = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.get_guardian_invitation_summary"), sql.indexOf("CREATE OR REPLACE FUNCTION public.accept_guardian_invitation"));
  const acceptance = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.accept_guardian_invitation"), sql.indexOf("CREATE OR REPLACE FUNCTION public.revoke_guardian_invitation"));
  assert.match(summary, /user_record\.email_confirmed_at/);
  assert.match(summary, /lower\(btrim\(v_email\)\) = invitation\.invited_email/);
  assert.match(summary, /RETURNS TABLE\(athlete_display_name text, expires_at timestamptz, invitation_status/);
  assert.doesNotMatch(summary.slice(0, summary.indexOf("LANGUAGE plpgsql")), /athlete_id|token_hash|inviter_profile_id/);
  assert.match(acceptance, /invitation\.token_hash[\s\S]*FOR UPDATE/);
  assert.match(acceptance, /athlete\.status = 'active'/);
  assert.match(acceptance, /SELECT athlete\.\* INTO v_athlete[\s\S]*FOR UPDATE/);
  assert.match(acceptance, /SELECT relationship\.\* INTO v_inviter_relationship[\s\S]*relationship\.role = 'guardian'[\s\S]*relationship\.manage_permission[\s\S]*FOR UPDATE/);
  assert.match(acceptance, /pg_advisory_xact_lock[\s\S]*SELECT relationship\.\* INTO v_recipient_relationship[\s\S]*FOR UPDATE/);
  assert.match(acceptance, /pg_advisory_xact_lock/);
  assert.match(acceptance, /role = 'self'/);
  assert.match(acceptance, /'guardian', false, false, v_invitation\.inviter_profile_id/);
  assert.match(acceptance, /relationship\.revoked_at IS NULL/);
  assert.doesNotMatch(acceptance, /UPDATE public\.athlete_profile_relationships/);
  assert.doesNotMatch(acceptance, /p_(?:athlete|profile|permission|actor)_id/);
});

test("guardian invitations expose no direct table access and only authenticated hardened RPCs", () => {
  assert.match(sql, /ALTER TABLE public\.guardian_invitations ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON public\.guardian_invitations FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(sql, /GRANT SELECT(?: \([^)]*\))? ON public\.guardian_invitations/);
  for (const signature of [
    "create_guardian_invitation(uuid, text, text, timestamptz)",
    "get_guardian_invitation_summary(text)",
    "accept_guardian_invitation(text)",
    "revoke_guardian_invitation(uuid)",
    "list_my_guardian_invitations(uuid)",
  ]) {
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature.replace(/[()]/g, "\\$&").replace(/ /g, "\\s+")} FROM PUBLIC, anon, authenticated;`));
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature.replace(/[()]/g, "\\$&").replace(/ /g, "\\s+")} TO authenticated;`));
  }
  assert.match(sql, /SECURITY DEFINER\s+SET search_path TO ''/);
  assert.match(sql, /list_my_guardian_invitations[\s\S]*private\.can_manage_guardian_invitation\(p_athlete_id\)/);
});

test("rollback validator covers fixed permissions, privacy, lifecycle, authority, and historical invariants", () => {
  for (const phrase of [
    "MANAGE guardian could not create invitation", "VIEW-only, ACT-only, staff-only, or unrelated actor created guardian invitation",
    "guardian invitation table/RLS is missing", "guardian invitation function signatures are incomplete",
    "guardian invitation function grants are incorrect", "wrong account learned minor identity", "unverified account learned minor identity",
    "unverified account accepted guardian invitation", "fixed VIEW-only guardian grant was not created",
    "stronger guardian was downgraded or changed", "revoked guardian history was not preserved",
    "self relationship was converted to guardian", "accepted guardian invitation replay succeeded", "existing VIEW guardian acceptance was not idempotent", "revoking guardian invitation changed existing guardian access",
    "self MANAGE relationship created guardian invitation", "self MANAGE relationship listed guardian invitations", "self MANAGE relationship revoked guardian invitation", "self-based inviter authority accepted guardian invitation",
    "inactive athlete guardian invitation accepted", "revoked guardian invitation accepted", "duplicate live guardian invitation was accepted", "duplicate guardian token hash was not a controlled domain failure",
    "exact seven-day guardian invitation expiry was rejected", "over-seven-day guardian invitation expiry was accepted",
    "expired guardian invitation accepted", "stale guardian invitation was not expired before replacement", "inviter authority loss did not block guardian acceptance",
    "guardian invitation token hash was readable to authenticated manager", "direct guardian invitation write was not denied",
    "direct guardian relationship write was not denied", "ROLLBACK;",
  ]) assert.match(validator, new RegExp(phrase));
  assert.match(validator, /BEGIN;/);
  assert.match(validator, /DO \$validation\$\n#variable_conflict error\nDECLARE/);
  assert.match(validator, /NOT \(coalesce\(procedure\.proconfig, ARRAY\[\]::text\[\]\) @> ARRAY\['search_path=""'\]::text\[\]\)/);
  assert.doesNotMatch(validator, /!@>/);
  assert.match(validator, /manager_email text; recipient_email text; view_email text;/);
  assert.match(validator, /SELECT lower\(btrim\(email\)\) INTO manager_email FROM auth\.users WHERE id=manager_id;/);
  assert.match(validator, /SELECT lower\(btrim\(email\)\) INTO recipient_email FROM auth\.users WHERE id=recipient_id;/);
  assert.match(validator, /SELECT lower\(btrim\(email\)\) INTO view_email FROM auth\.users WHERE id=view_id;/);
  assert.doesNotMatch(validator, /\(SELECT email FROM auth\.users/);
  assert.match(validator, /v_athlete_id uuid := gen_random_uuid\(\)/);
  assert.match(validator, /v_invitation_id uuid/);
  assert.match(validator, /v_token_hash text/);
  assert.match(validator, /invitation\.invitation_id = v_invitation_id/);
  assert.doesNotMatch(validator, /invitation\.invitation_id = invitation_id/);
  assert.match(validator, /relationship\.athlete_id=v_athlete_id/);
  assert.doesNotMatch(validator, /relationship\.athlete_id=athlete_id/);
  assert.match(validator, /UPDATE public\.athlete_profile_relationships AS relationship SET revoked_at=clock_timestamp\(\)[\s\S]*relationship\.athlete_id=revoked_athlete_id/);
  assert.doesNotMatch(validator, /WHERE athlete_id=revoked_athlete_id/);
  assert.match(validator, /INSERT INTO public\.team_staff_memberships/);
  assert.match(validator, /public\.list_my_guardian_invitations\(v_athlete_id\)/);
  assert.doesNotMatch(validator, /INSERT INTO auth\.users|INSERT INTO public\.profiles|INSERT INTO public\.team_athlete_memberships/);
});
