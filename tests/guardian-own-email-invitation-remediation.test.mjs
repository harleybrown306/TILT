import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../supabase/migrations/20261003132630_restore_guardian_invitation_own_email_guard.sql", import.meta.url), "utf8");

test("guardian own-email remediation keeps the authenticated creation boundary and uses current database-owned email", () => {
  assert.match(migration, /^BEGIN;[\s\S]*COMMIT;\s*$/);
  assert.match(migration, /to_regprocedure\('public\.create_guardian_invitation\(uuid,text,text,timestamp with time zone\)'\)/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.create_guardian_invitation\([\s\S]*?p_expires_at timestamptz DEFAULT/);
  assert.match(migration, /v_actor uuid := \(SELECT auth\.uid\(\)\)/);
  assert.match(migration, /SELECT lower\(btrim\(user_record\.email\)\) INTO v_actor_email[\s\S]*?FROM auth\.users AS user_record[\s\S]*?user_record\.id = v_actor/);
  assert.match(migration, /IF v_actor_email = v_email THEN RAISE EXCEPTION 'Cannot invite your own email'; END IF;/);
  assert.match(migration, /private\.can_manage_guardian_invitation\(p_athlete_id\)/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /Guardian invitation token is unavailable/);
  assert.doesNotMatch(migration, /email_confirmed_at|confirmed_at|user_metadata|p_actor_email|server_create_guardian/);
});
