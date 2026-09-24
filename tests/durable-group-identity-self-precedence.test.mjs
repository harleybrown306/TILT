import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../supabase/migrations/20260924170432_cutover_team_group_memberships_to_durable_athletes.sql", import.meta.url), "utf8");
const assignmentPage = readFileSync(new URL("../src/app/teams/[teamId]/assign/page.tsx", import.meta.url), "utf8");
const assignmentActions = readFileSync(new URL("../src/app/teams/[teamId]/assign/actions.ts", import.meta.url), "utf8");
const groupPage = readFileSync(new URL("../src/app/teams/[teamId]/groups/[groupId]/page.tsx", import.meta.url), "utf8");
const groupActions = readFileSync(new URL("../src/app/teams/[teamId]/groups/[groupId]/actions.ts", import.meta.url), "utf8");
const childFoundation = readFileSync(new URL("../supabase/migrations/20260923201138_create_child_login_invitation_foundation.sql", import.meta.url), "utf8");
const legacyGroups = readFileSync(new URL("../supabase/migrations/20260914143620_phase_4_team_groups_assignment_batches.sql", import.meta.url), "utf8");

test("group membership backfill follows the preserved same-team legacy roster correspondence", () => {
  assert.match(migration, /legacy_roster\.team_id = group_row\.team_id/);
  assert.match(migration, /legacy_roster\.user_id = membership\.athlete_user_id/);
  assert.match(migration, /legacy_roster\.role = 'athlete'::public\.team_member_role/);
  assert.match(migration, /durable_roster\.id = legacy_roster\.id/);
  assert.match(migration, /durable_roster\.team_id = group_row\.team_id/);
  assert.match(migration, /count\(legacy_roster_id\) <> 1/);
  assert.match(migration, /count\(durable_roster_id\) <> 1/);
  assert.match(migration, /would collapse into duplicate durable athlete memberships/);
  assert.doesNotMatch(migration, /athlete_id\s*=\s*athlete_user_id/);
  const backfill = migration.slice(0, migration.indexOf("ALTER TABLE public.team_group_memberships\n  ADD COLUMN"));
  assert.doesNotMatch(backfill, /athlete_profile_relationships/);
});

test("group membership has durable subject, uniqueness, and database-enforced same-team containment", () => {
  assert.match(migration, /ADD COLUMN team_id uuid,\s*ADD COLUMN athlete_id uuid/);
  assert.match(migration, /team_group_memberships_athlete_id_fkey[\s\S]*REFERENCES public\.athletes\(id\) ON DELETE RESTRICT/);
  assert.match(migration, /team_group_memberships_group_team_fkey[\s\S]*FOREIGN KEY \(team_group_id, team_id\)[\s\S]*REFERENCES public\.team_groups\(id, team_id\)/);
  assert.match(migration, /team_group_memberships_team_athlete_fkey[\s\S]*FOREIGN KEY \(team_id, athlete_id\)[\s\S]*REFERENCES public\.team_athlete_memberships\(team_id, athlete_id\)/);
  assert.match(migration, /UNIQUE \(team_group_id, athlete_id\)/);
  assert.match(migration, /DROP COLUMN athlete_user_id/);
});

test("group writers keep actor authority separate from the durable athlete subject", () => {
  const insertPolicy = migration.slice(migration.indexOf("CREATE POLICY team_group_memberships_insert_roster_manager"), migration.indexOf("CREATE POLICY team_group_memberships_delete_roster_manager"));
  assert.match(insertPolicy, /created_by_user_id = \(SELECT auth\.uid\(\)\)/);
  assert.match(insertPolicy, /private\.can_manage_roster\(group_row\.team_id, \(SELECT auth\.uid\(\)\)\)/);
  assert.match(insertPolicy, /roster\.athlete_id = team_group_memberships\.athlete_id/);
  assert.doesNotMatch(insertPolicy, /athlete_profile_relationships|training_permission|manage_permission/);
  assert.match(legacyGroups, /team_group_memberships_select_team_member[\s\S]*private\.is_team_member/);
});

test("MANAGE and ACT select SELF before GUARDIAN without changing VIEW", () => {
  for (const [name, column] of [["can_manage_athlete_identity", "manage_permission"], ["can_act_for_training", "training_permission"]]) {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION private.${name}`);
    const body = migration.slice(start, migration.indexOf("$function$;", start) + "$function$;".length);
    assert.match(body, new RegExp(`relationship\\.${column}`));
    assert.ok(body.indexOf("relationship.role = 'self'") < body.indexOf("relationship.role = 'guardian'"));
    assert.match(body, /coalesce\(/);
    assert.match(body, /false/);
  }
  assert.doesNotMatch(migration, /CREATE OR REPLACE FUNCTION private\.can_view_athlete_identity/);
});

test("direct consumers use durable athlete IDs, including claimed-child group assignment", () => {
  for (const source of [assignmentPage, assignmentActions, groupPage, groupActions]) {
    assert.match(source, /team_group_memberships/);
    assert.match(source, /athlete_id|athleteId/);
    assert.doesNotMatch(source, /athlete_user_id|athleteUserId/);
  }
  assert.match(assignmentActions, /\.map\(\(member\) => member\.athlete_id\)/);
  assert.match(groupActions, /\.from\("team_athlete_memberships"\)[\s\S]*\.eq\("athlete_id", athleteId\)/);
});

test("B1 does not release or alter child-login invitation boundaries", () => {
  assert.match(childFoundation, /REVOKE ALL ON FUNCTION public\.create_child_login_invitation\(uuid,text,text\) FROM PUBLIC,anon,authenticated/);
  assert.match(childFoundation, /REVOKE ALL ON FUNCTION public\.accept_child_login_invitation\(text\) FROM PUBLIC,anon,authenticated/);
  assert.doesNotMatch(migration, /child_login_invitations|child_login_claim_lock|guard_child_login_self_relationship_write|prevent_child_login_self_history_erasure/);
  assert.doesNotMatch(migration, /GRANT EXECUTE ON FUNCTION public\.(?:create|get|accept|revoke|list)_child_login_invitation/);
});
