import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";

const migrationName = "20260923201138_create_child_login_invitation_foundation.sql";
const sql = readFileSync(new URL(`../supabase/migrations/${migrationName}`, import.meta.url), "utf8");
const managerAuthorizationMigrationName = "20260924182152_child_login_invitation_manager_authorization.sql";
const managerAuthorizationSql = readFileSync(new URL(`../supabase/migrations/${managerAuthorizationMigrationName}`, import.meta.url), "utf8");
const recipientAuthorizationMigrationName = "20260924182153_reconcile_child_login_recipient_claim_authorization.sql";
const recipientAuthorizationSql = readFileSync(new URL(`../supabase/migrations/${recipientAuthorizationMigrationName}`, import.meta.url), "utf8");
const validator = readFileSync(new URL("database/validate_child_login_invitation_foundation.sql", import.meta.url), "utf8");

test("child-login claim foundation and C1 manager authorization are canonical forward migrations", () => {
  const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url))
    .filter((name) => /child_login/.test(name));
  assert.deepEqual(migrations, [migrationName, managerAuthorizationMigrationName, recipientAuthorizationMigrationName]);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\s*$/);
  assert.match(managerAuthorizationSql, /^BEGIN;[\s\S]*COMMIT;\s*$/);
  assert.match(recipientAuthorizationSql, /^BEGIN;[\s\S]*COMMIT;\s*$/);
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

test("C1 releases only manager RPCs with canonical MANAGE and preserves create authorization locks", () => {
  const create = managerAuthorizationSql.slice(
    managerAuthorizationSql.indexOf("CREATE OR REPLACE FUNCTION public.create_child_login_invitation"),
    managerAuthorizationSql.indexOf("CREATE OR REPLACE FUNCTION public.revoke_child_login_invitation"),
  );
  const revoke = managerAuthorizationSql.slice(
    managerAuthorizationSql.indexOf("CREATE OR REPLACE FUNCTION public.revoke_child_login_invitation"),
    managerAuthorizationSql.indexOf("CREATE OR REPLACE FUNCTION public.list_my_child_login_invitations"),
  );
  const list = managerAuthorizationSql.slice(
    managerAuthorizationSql.indexOf("CREATE OR REPLACE FUNCTION public.list_my_child_login_invitations"),
    managerAuthorizationSql.indexOf("DROP FUNCTION private.child_login_guardian_manage"),
  );

  for (const functionSql of [create, revoke, list]) {
    assert.match(functionSql, /SECURITY DEFINER SET search_path TO ''/);
    assert.match(functionSql, /private\.can_manage_athlete_identity/);
    assert.doesNotMatch(functionSql, /private\.child_login_guardian_manage/);
  }
  assert.match(create, /private\.child_login_claim_lock\(p_athlete_id\)[\s\S]*athletes a[\s\S]*FOR UPDATE[\s\S]*athlete_profile_relationships r[\s\S]*r\.profile_id=v_actor[\s\S]*r\.role IN \('self','guardian'\) FOR UPDATE[\s\S]*private\.can_manage_athlete_identity\(p_athlete_id\)/);
  assert.match(create, /WHERE r\.athlete_id=p_athlete_id AND r\.role='self' FOR UPDATE/);
  assert.match(revoke, /private\.child_login_claim_lock\(v_athlete\)[\s\S]*FOR UPDATE[\s\S]*private\.can_manage_athlete_identity\(v_i\.athlete_id\)/);
  assert.match(list, /WHERE i\.athlete_id=p_athlete_id AND private\.can_manage_athlete_identity\(p_athlete_id\)/);
  assert.match(managerAuthorizationSql, /DROP FUNCTION private\.child_login_guardian_manage\(uuid,uuid\);/);
  assert.match(managerAuthorizationSql, /GRANT EXECUTE ON FUNCTION public\.create_child_login_invitation\(uuid,text,text\) TO authenticated;/);
  assert.match(managerAuthorizationSql, /GRANT EXECUTE ON FUNCTION public\.revoke_child_login_invitation\(uuid\) TO authenticated;/);
  assert.match(managerAuthorizationSql, /GRANT EXECUTE ON FUNCTION public\.list_my_child_login_invitations\(uuid\) TO authenticated;/);
  assert.doesNotMatch(managerAuthorizationSql, /GRANT EXECUTE ON FUNCTION public\.(?:get_child_login_invitation_summary|accept_child_login_invitation)/);
  for (const signature of [
    "create_child_login_invitation(uuid,text,text)",
    "revoke_child_login_invitation(uuid)",
    "list_my_child_login_invitations(uuid)",
    "get_child_login_invitation_summary(text)",
    "accept_child_login_invitation(text)",
  ]) assert.match(managerAuthorizationSql, new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature.replace(/[()]/g, "\\$&")} FROM PUBLIC,anon,authenticated;`));
  assert.match(managerAuthorizationSql, /REVOKE ALL ON TABLE public\.child_login_invitations FROM PUBLIC,anon,authenticated;/);
});

test("D1 binds recipient acceptance to the original inviter's explicit canonical MANAGE and releases only recipient RPCs", () => {
  const helper = recipientAuthorizationSql.slice(
    recipientAuthorizationSql.indexOf("CREATE FUNCTION private.can_manage_athlete_identity_for_profile"),
    recipientAuthorizationSql.indexOf("CREATE OR REPLACE FUNCTION public.accept_child_login_invitation"),
  );
  const accept = recipientAuthorizationSql.slice(
    recipientAuthorizationSql.indexOf("CREATE OR REPLACE FUNCTION public.accept_child_login_invitation"),
    recipientAuthorizationSql.indexOf("REVOKE ALL ON FUNCTION public.get_child_login_invitation_summary"),
  );

  assert.match(helper, /RETURNS boolean[\s\S]*SECURITY DEFINER[\s\S]*SET search_path TO ''/);
  assert.match(helper, /relationship\.profile_id = p_profile_id[\s\S]*relationship\.role = 'self'[\s\S]*relationship\.revoked_at IS NULL/);
  assert.match(helper, /relationship\.profile_id = p_profile_id[\s\S]*relationship\.role = 'guardian'[\s\S]*relationship\.revoked_at IS NULL/);
  assert.match(helper, /SELECT coalesce\([\s\S]*self[\s\S]*guardian[\s\S]*false/);
  assert.match(recipientAuthorizationSql, /REVOKE ALL ON FUNCTION private\.can_manage_athlete_identity_for_profile\(uuid,uuid\) FROM PUBLIC, anon, authenticated;/);
  assert.doesNotMatch(recipientAuthorizationSql, /GRANT EXECUTE ON FUNCTION private\.can_manage_athlete_identity_for_profile/);

  assert.match(accept, /private\.child_login_claim_lock\(v_candidate,v_actor\)[\s\S]*FOR UPDATE[\s\S]*v_i\.status = 'accepted'/);
  assert.match(accept, /r\.profile_id = v_i\.inviter_profile_id[\s\S]*r\.role IN \('self','guardian'\)[\s\S]*FOR UPDATE[\s\S]*private\.can_manage_athlete_identity_for_profile\(v_i\.athlete_id,v_i\.inviter_profile_id\)/);
  assert.doesNotMatch(accept, /private\.can_manage_athlete_identity\(v_i\.athlete_id\)/);
  assert.ok(
    accept.indexOf("private.can_manage_athlete_identity_for_profile(v_i.athlete_id,v_i.inviter_profile_id)")
      < accept.indexOf("WHERE r.athlete_id = v_i.athlete_id AND r.role = 'self'"),
    "accept must evaluate original-inviter canonical MANAGE before target SELF-history enforcement",
  );
  assert.match(accept, /WHERE r\.athlete_id = v_i\.athlete_id AND r\.role = 'self'[\s\S]*FOR UPDATE/);
  assert.match(accept, /WHERE r\.profile_id = v_actor AND r\.role = 'self' AND r\.revoked_at IS NULL[\s\S]*FOR UPDATE/);
  assert.match(accept, /INSERT INTO public\.athlete_profile_relationships[\s\S]*'self',true,true,v_i\.inviter_profile_id/);
  assert.doesNotMatch(accept, /INSERT INTO public\.athletes/);

  for (const signature of [
    "get_child_login_invitation_summary(text)",
    "accept_child_login_invitation(text)",
  ]) {
    assert.match(recipientAuthorizationSql, new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature.replace(/[()]/g, "\\$&")} FROM PUBLIC, anon, authenticated;`));
    assert.match(recipientAuthorizationSql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature.replace(/[()]/g, "\\$&")} TO authenticated;`));
  }
  assert.doesNotMatch(recipientAuthorizationSql, /GRANT EXECUTE ON FUNCTION public\.(?:get_child_login_invitation_summary|accept_child_login_invitation).*?(?:anon|PUBLIC)/);
});

test("rollback validator checks security posture and claim invariants without persisting fixtures", () => {
  assert.match(validator, /(?:^|\n)BEGIN;[\s\S]*ROLLBACK;\s*$/);
  assert.match(validator, /#variable_conflict error/);
  for (const phrase of [
    "child login invitation table/RLS is missing",
    "authenticated has direct child login invitation table access",
    "child login invitation function hardening or phase grants are incorrect",
    "C1-03 SELF=false suppresses guardian=true failed",
    "C1-11 former inviter retained authority",
    "D1 original inviter canonical MANAGE failed",
    "D1 case 1 active SELF manager claim conflict failed",
    "D1 case 2 SELF=false guardian=true denial failed",
    "D1 case 3 revoked SELF target history claim conflict failed",
    "D1 case 4 former inviter authority loss failed",
    "D1 case 5 revoked recipient SELF different athlete failed",
    "D1 recipient active SELF conflict failed",
    "D1 recipient revoked SELF fallback failed",
    "SECTION C1 PASS",
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

test("C1 no-reclaim cases clear pending invitations and require the historical-SELF error", () => {
  const c1 = validator.slice(
    validator.indexOf("-- Section C1:"),
    validator.indexOf("-- Section L:"),
  );
  for (const caseNumber of ["04", "05", "06"]) {
    assert.match(c1, new RegExp(`C1-${caseNumber} seeded invitation was not revoked`));
    assert.match(c1, new RegExp(`C1-${caseNumber}.*SQLERRM='Athlete self claim is unavailable'`));
  }
  assert.doesNotMatch(c1, /C1 historical SELF no-reclaim failed/);
});
