# Historical training-data deletion baseline

Applied on 2026-09-14 to the authoritative Supabase database.

- Name: `harden_historical_training_data_deletion`
- Version: `20260914191527`
- Exact applied SQL: [migration record](harden_historical_training_data_deletion.sql)

These docs/database files record remote migrations; the repository still has no
Supabase CLI bootstrap/migration workflow.

## Applied changes

Changed only these existing foreign keys from ON DELETE CASCADE to RESTRICT:

| Constraint | Relationship |
| --- | --- |
| workout_results_training_session_id_fkey | result -> session |
| training_sessions_assignment_id_fkey | session -> assignment |
| training_sessions_team_id_fkey | session -> team |
| training_sessions_athlete_user_id_fkey | session -> auth user |
| workout_results_athlete_user_id_fkey | result -> auth user |

Removed training_sessions_delete and workout_results_delete policies and revoked
DELETE on those two tables from authenticated. No replacement admin application
DELETE policy or purge mechanism was created.

Effective authenticated DELETE privilege is false for both tables. This includes
platform admins using ordinary authenticated access. Existing anon table grants
were not changed; no anon DELETE RLS policy permits history deletion.

SELECT/INSERT/UPDATE policies, helpers, triggers, other grants and all other
foreign keys were unchanged. The before/after hash of policies excluding the
two removed DELETE policies was 081ab3471a31861c6ab1cdaffa92c943.
No player, telemetry, audio, or environment changes were made.

## Database validation

Direct SQL validation used SET LOCAL ROLE authenticated and request.jwt.claim.sub
for existing users. All temporary role/membership changes, new assignment/session/
result fixtures, archive transitions and destructive attempts ran inside one
transaction ending in ROLLBACK. No training sessions were manually inserted.
Blocked parent deletion statements were caught in PL/pgSQL subtransactions.

All checks passed:

1. Existing admin/coach/athlete session/result SELECT sets match the existing
   ownership/team-coach/admin predicates.
2. Coach direct session DELETE receives insufficient_privilege.
3. Assistant direct session DELETE receives insufficient_privilege; SELECT works.
   No assistant fixture exists, so a coach membership was temporarily changed
   to assistant inside the rollback-only transaction.
4. Athlete direct session DELETE receives insufficient_privilege.
5. Athlete/coach/assistant/authenticated admin result DELETE receives
   insufficient_privilege. Authenticated admin session DELETE is also denied.
6. Privileged session deletion with a result fails specifically on
   workout_results_training_session_id_fkey.
7. Privileged assignment deletion with sessions fails specifically on
   training_sessions_assignment_id_fkey.
8. Privileged team deletion with history fails with foreign_key_violation.
9. Privileged athlete auth-user deletion with history fails with
   foreign_key_violation.
10. Authenticated owner archive and restore both update exactly one plan.
11. Authenticated coach removes an athlete membership; session/result remain.
12. Temporarily removing coach membership on one team denies its sessions/results
    while retaining session access on the other team.
13. Authenticated coach inserts a normal assignment. The existing trigger
    generates exactly the number of sessions corresponding to the plan items.
14. Authenticated athlete inserts a result for a generated session; the existing
    result trigger marks that session completed with a completion timestamp.

Catalog verification confirmed all five exact FK definitions use RESTRICT.
Team/auth-user tests establish deletion is blocked; multiple references can
participate, so they do not claim one particular constraint fires first.

Before and after: 15 sessions, 2 results. A hash of every complete session/result
row matched exactly: f09f82272cafe633d3ac7c2e5cd5a062. All validation mutations
rolled back; existing historical rows remained unchanged.

## Current result UPDATE permissions — intentionally unchanged

workout_results_update is FOR UPDATE TO authenticated:

USING: athlete_user_id = (SELECT auth.uid()).

WITH CHECK: athlete_user_id = (SELECT auth.uid()) AND an existing training_session
has id = training_session_id and athlete_user_id = (SELECT auth.uid()).

Authenticated has table-level UPDATE and effective UPDATE privilege on every
column: id, training_session_id, athlete_user_id, started_at, completed_at,
active_minutes, total_duration_minutes, exercises_completed, notes, result_data,
created_at, updated_at.

The athlete identity must remain the caller's identity. Other values can be
changed subject to PK/unique/FK/NOT NULL and nonnegative metric constraints.
training_session_id may move to another owned session if constraints permit.
private.set_updated_at() overrides updated_at with now().
Updating completed_at invokes private.sync_session_from_result(), changing the
referenced session's completion timestamp. created_at is not similarly protected.
Coach/admin SELECT does not grant result UPDATE unless the row also satisfies
the athlete ownership predicate.

Future approved work should lock result identity/provenance and completion facts,
define whether notes remain editable, and use audited corrections retaining
original values, actor, reason and timestamp. Reporting should expose correction
and measurement versions. This migration neither restricts nor expands UPDATE.

## Security advisor and application checks

Before/after security reports match: no errors and no new warnings.
Three pre-existing warnings remain:

1. public.accept_team_invitation(text): authenticated SECURITY DEFINER RPC.
2. public.get_team_invitation_summary(text): authenticated SECURITY DEFINER RPC.
   [Advisor guidance](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable).
3. Leaked password protection disabled.
   [Auth guidance](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

TypeScript (incremental disabled), ESLint (cache disabled), all 248 automated
tests, and the Webpack production build passed. No application/test changes
were needed.

## Remaining risks and limitations

Privileged postgres/service-role tooling still can intentionally delete results
and then sessions in dependency order; no purge workflow was created.
Authenticated session/result UPDATE can still alter historical facts/provenance.
Authenticated still has effective TRUNCATE privilege on both tables (verified
directly after migration). TRUNCATE bypasses RLS and can erase history through
SQL-capable access; PostgREST exposes no ordinary table TRUNCATE operation.
Revoking these pre-existing grants is recommended as a separately approved
follow-up. They were not changed in this DELETE/FK-scoped migration.
Privileged DDL remains outside this baseline.

Assignment/team/auth-user cascades remain elsewhere, but historical session/result
RESTRICT references stop successful parent deletion while that history exists.
Assignments with no sessions can still be deleted under their existing policies.
Plan-item deletion still sets session.plan_item_id to NULL; descriptive provenance
and workout-step content still need durable snapshots for future reports.
Public profile deletion, if done by privileged tooling, can remove memberships
without deleting auth-linked history, changing team authorization.

Future account erasure requires explicit privileged/audited dependency handling.
No automatic retention deletion was introduced.

## Rollback

Rollback is a separately approved migration, not a product action. Restore the
same five constraints using their exact columns/targets from the SQL record but
with ON DELETE CASCADE. Restore the original two policies:

```sql
CREATE POLICY training_sessions_delete ON public.training_sessions
FOR DELETE TO authenticated
USING (
  private.is_team_coach(team_id, (SELECT auth.uid()))
  OR private.is_admin((SELECT auth.uid()))
);

CREATE POLICY workout_results_delete ON public.workout_results
FOR DELETE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.training_sessions ts
    WHERE ts.id = workout_results.training_session_id
      AND private.is_team_coach(ts.team_id, (SELECT auth.uid()))
  )
  OR private.is_admin((SELECT auth.uid()))
);

GRANT DELETE ON public.training_sessions, public.workout_results
TO authenticated;
```

Apply rollback transactionally. It reopens the original deletion/cascade risks.
No data restoration is necessary for this migration, which changed no history.
