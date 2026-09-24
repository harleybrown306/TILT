import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";

const migrationName = "20260923201138_create_child_login_invitation_foundation.sql";
const sql = readFileSync(new URL(`../supabase/migrations/${migrationName}`, import.meta.url), "utf8");
const validator = readFileSync(new URL("database/validate_child_login_invitation_foundation.sql", import.meta.url), "utf8");

test("child-login claim foundation is one canonical forward migration", () => {
  const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url))
    .filter((name) => /child_login_invitation/.test(name));
  assert.deepEqual(migrations, [migrationName]);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\s*$/);
});

test("claim invitations are hash-only, immutable, exactly seven days, and one pending per athlete", () => {
  assert.match(sql, /CREATE TABLE public\.child_login_invitations/);
  assert.match(sql, /token_hash text NOT NULL CONSTRAINT child_login_invitations_token_hash_unique UNIQUE/);
  assert.match(sql, /token_hash ~ '\^\[a-f0-9\]\{64\}\$'/);
  assert.match(sql, /expires_at = created_at \+ interval '7 days'/);
  assert.match(sql, /CREATE UNIQUE INDEX child_login_invitations_one_pending_per_athlete[\s\S]*\(athlete_id\)[\s\S]*status='pending'/);
  assert.match(sql, /Child login invitation identity fields cannot be changed/);
  assert.doesNotMatch(sql, /ON DELETE CASCADE/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION public\.(?:create|get|accept|revoke|list)_child_login/);
});

test("all future claim writes use a deterministic per-athlete/profile transaction lock", () => {
  const lock = sql.slice(sql.indexOf("CREATE FUNCTION private.child_login_claim_lock"), sql.indexOf("ALTER TABLE public.child_login_invitations"));
  assert.match(lock, /hashtextextended\('13EA:athlete:'/);
  assert.match(lock, /hashtextextended\('13EA:profile:'/);
  assert.match(lock, /IF a<=b THEN/);
  for (const name of ["create_child_login_invitation", "accept_child_login_invitation", "revoke_child_login_invitation"]) {
    const start = sql.indexOf(`CREATE FUNCTION public.${name}`);
    const functionSql = sql.slice(start, sql.indexOf("$function$;", start) + 11);
    assert.match(functionSql, /private\.child_login_claim_lock/);
  }
});

test("the table itself serializes every SELF-history mutation on the 13EA athlete lock", () => {
  const guard = sql.slice(sql.indexOf("CREATE FUNCTION private.guard_child_login_self_relationship_write"), sql.indexOf("ALTER TABLE public.child_login_invitations"));
  assert.match(guard, /BEFORE INSERT OR UPDATE OR DELETE ON public\.athlete_profile_relationships/);
  assert.match(guard, /OLD\.role = 'self'/);
  assert.match(guard, /NEW\.role = 'self'/);
  assert.match(guard, /hashtextextended\('13EA:athlete:' \|\| v_first::text, 13051\)/);
  assert.match(guard, /pg_advisory_xact_lock/);
  assert.match(guard, /v_first_key <= v_second_key/);
  assert.doesNotMatch(guard, /revoked_at IS NULL/);
});

test("SELF history cannot be physically erased or relocated while preserving revocation lifecycle", () => {
  const semantic = sql.slice(sql.indexOf("CREATE FUNCTION private.prevent_child_login_self_history_erasure"), sql.indexOf("ALTER TABLE public.child_login_invitations"));
  assert.match(semantic, /BEFORE UPDATE OR DELETE ON public\.athlete_profile_relationships/);
  assert.match(semantic, /TG_OP = 'DELETE' AND OLD\.role = 'self'/);
  assert.match(semantic, /NEW\.role <> 'self'/);
  assert.match(semantic, /NEW\.athlete_id <> OLD\.athlete_id/);
  assert.match(semantic, /NEW\.profile_id <> OLD\.profile_id/);
  assert.match(semantic, /ERRCODE='P0001'/);
  assert.match(semantic, /SECURITY DEFINER SET search_path TO ''/);
  assert.match(semantic, /REVOKE ALL ON FUNCTION private\.prevent_child_login_self_history_erasure\(\) FROM PUBLIC, anon, authenticated/);
  assert.match(semantic, /athlete_profile_relationships_protect_child_login_self_history/);
  assert.doesNotMatch(semantic, /NEW\.revoked_at/);
  assert.doesNotMatch(semantic, /NEW\.training_permission/);
  assert.doesNotMatch(semantic, /NEW\.manage_permission/);
});

test("acceptance has exact confirmed-email identity binding and accepted-only idempotency", () => {
  const accept = sql.slice(sql.indexOf("CREATE FUNCTION public.accept_child_login_invitation"), sql.indexOf("CREATE FUNCTION public.revoke_child_login_invitation"));
  assert.match(accept, /char_length\(p_invitation_token\) NOT BETWEEN 32 AND 256/);
  assert.match(accept, /p_invitation_token !~ '\^\[A-Za-z0-9_-\]\+\$'/);
  assert.match(accept, /u\.email_confirmed_at/);
  assert.match(accept, /lower\(btrim\(v_email\)\)<>v_i\.invited_email/);
  assert.match(accept, /IF v_i\.status='accepted' THEN[\s\S]*accepted_by_profile_id=v_actor[\s\S]*role='self'[\s\S]*training_permission AND r\.manage_permission/);
  assert.match(accept, /WHERE r\.athlete_id=v_i\.athlete_id AND r\.role='self' FOR UPDATE/);
  assert.match(accept, /WHERE r\.profile_id=v_actor AND r\.role='self' AND r\.revoked_at IS NULL FOR UPDATE/);
  assert.match(accept, /INSERT INTO public\.athlete_profile_relationships[\s\S]*'self',true,true/);
  assert.doesNotMatch(accept, /p_athlete_id|p_profile_id|p_actor_id/);
  assert.doesNotMatch(accept, /INSERT INTO public\.athletes/);
});

test("13E.A exposes no table access or phase-premature RPC grant", () => {
  assert.match(sql, /ALTER TABLE public\.child_login_invitations ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON public\.child_login_invitations FROM PUBLIC, anon, authenticated/);
  for (const signature of [
    "create_child_login_invitation(uuid,text,text)",
    "get_child_login_invitation_summary(text)",
    "accept_child_login_invitation(text)",
    "revoke_child_login_invitation(uuid)",
    "list_my_child_login_invitations(uuid)",
  ]) assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature.replace(/[()]/g, "\\$&")} FROM PUBLIC,anon,authenticated;`));
  assert.match(sql, /SECURITY DEFINER SET search_path TO ''/);
});

test("all five exact Phase 13E.A RPC contracts remain intentionally ungranted", () => {
  const signatures = [
    "create_child_login_invitation(uuid,text,text)",
    "get_child_login_invitation_summary(text)",
    "accept_child_login_invitation(text)",
    "revoke_child_login_invitation(uuid)",
    "list_my_child_login_invitations(uuid)",
  ];
  for (const signature of signatures) {
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature.replace(/[()]/g, "\\$&")} FROM PUBLIC,anon,authenticated;`));
  }
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION public\.(?:create|get|accept|revoke|list)_child_login_invitation/);
  assert.doesNotMatch(sql, /CREATE UNIQUE INDEX[^;]*invited_email[^;]*WHERE status='pending'/);
});

test("rollback validator checks security posture and claim invariants without persisting fixtures", () => {
  assert.match(validator, /(?:^|\n)BEGIN;[\s\S]*ROLLBACK;\s*$/);
  assert.match(validator, /#variable_conflict error/);
  for (const phrase of [
    "child login invitation table/RLS is missing",
    "authenticated has direct child login invitation table access",
    "child login invitation function hardening or phase grants are incorrect",
    "one pending child login invitation per athlete was not enforced",
    "wrong recipient learned child identity",
    "first child self claim was not created",
    "accepted child login invitation was not idempotent",
    "profile claimed a second active athlete",
    "historical self athlete was reclaimed",
    "direct child login invitation write was not denied",
  ]) assert.match(validator, new RegExp(phrase));
  assert.match(validator, /INSERT INTO auth\.users/);
  assert.match(validator, /v_marker text := '13ea-validator-'/);
});
