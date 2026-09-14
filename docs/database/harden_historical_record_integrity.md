# Historical record integrity — Phase 1B

Applied 2026-09-14. Remote migration:
`harden_historical_record_integrity`, version `20260914205119`.
Exact SQL: [applied record](harden_historical_record_integrity.sql).

## Inspection and chosen model

Before migration, authenticated and anon both had TRUNCATE on training_sessions
and workout_results, plus table-level UPDATE covering all workout_results columns.
The authenticated workout_results_update policy allowed existing rows owned by
auth.uid(); WITH CHECK required the resulting athlete_user_id to equal auth.uid()
and training_session_id to reference a session owned by that same athlete.

Repository inspection found no workout_results UPDATE call and no completed-result
or result-notes editor. Completion only INSERTs. result_data contains workout_name
and completed_steps today, so it contains historical outcome information.

The smallest model is no ordinary result UPDATE. Removed table and column UPDATE
grants from authenticated and anon, and removed workout_results_update.
Explicit column revocation prevents residual column-level grants from preserving
access. No replacement admin mutation policy or correction mechanism was added.
SELECT/INSERT policies, result/session triggers, FKs, service-role grants and
PostgreSQL ownership remain unchanged. No application changes were needed.

After migration:

- authenticated/anon TRUNCATE is false on both tables.
- authenticated/anon result table UPDATE is false.
- Effective result column UPDATE is false for all twelve columns.
- No result UPDATE policy remains.

Protected from normal post-insert updates: id, training_session_id,
athlete_user_id, started_at, completed_at, active_minutes, total_duration_minutes,
exercises_completed, notes, result_data, created_at, updated_at.
No athlete-editable result fields remain. Notes are protected because no existing
product flow requires edits. updated_at remains controlled by the existing
timestamp trigger for privileged future updates; ordinary clients cannot set it
through UPDATE. Initial INSERT behavior is intentionally unchanged.

## Direct validation

All mutation tests ran in a transaction ending in ROLLBACK.
Authenticated tests used SET LOCAL ROLE authenticated with the user's auth.uid()
claim. Assistant and another-athlete contexts were created by temporary membership
role changes, also rolled back.

Passed:

- Every existing profile's session/result SELECT set matches the unchanged
  athlete/team-coach/admin predicates.
- Each of twelve result-column UPDATE statements is permission-denied for
  athlete, coach and authenticated admin. Even SET column=column is rejected,
  proving denial occurs at privilege checking before field values matter.
- Assistant UPDATE is permission-denied.
- Another athlete cannot SELECT the target result and cannot UPDATE it.
- An authenticated TRUNCATE attempt on workout_results is permission-denied.
- Privilege queries prove authenticated and anon lack TRUNCATE on both tables
  and lack table/column result UPDATE.
- Normal authenticated coach assignment INSERT generates sessions through the
  existing trigger. No sessions were manually inserted.
- Normal athlete result INSERT succeeds for a generated session.
- private.sync_session_from_result() marks the session completed with a
  completion timestamp.

Before/after complete-row history hash:
`f09f82272cafe633d3ac7c2e5cd5a062`.
Counts remain 15 sessions and 2 results. All fixture writes and temporary changes
rolled back; existing history is unchanged.

## Advisor and application checks

No errors or new findings. Known pre-existing warnings remain separately:

1. public.accept_team_invitation(text): authenticated SECURITY DEFINER RPC.
2. public.get_team_invitation_summary(text): authenticated SECURITY DEFINER RPC.
   [Advisor guidance](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable).
3. Leaked-password protection disabled.
   [Auth guidance](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

TypeScript (incremental disabled), ESLint (cache disabled), all 248 automated
tests, and Webpack production build passed. No tests or application code changed.

## Rollback

Use a separately approved transaction to restore TRUNCATE on both tables to
authenticated and anon, restore table-level workout_results UPDATE to both roles,
and recreate the previous UPDATE policy:

```sql
BEGIN;
GRANT TRUNCATE ON public.training_sessions, public.workout_results
TO authenticated, anon;
GRANT UPDATE ON public.workout_results TO authenticated, anon;
CREATE POLICY workout_results_update ON public.workout_results
FOR UPDATE TO authenticated
USING (athlete_user_id = (SELECT auth.uid()))
WITH CHECK (
  athlete_user_id = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1 FROM public.training_sessions ts
    WHERE ts.id = workout_results.training_session_id
      AND ts.athlete_user_id = (SELECT auth.uid())
  )
);
COMMIT;
```

Rollback restores effective prior permissions and reopens the integrity gaps.
No data restoration is needed.

## Follow-up boundaries

An eventual audited correction workflow should retain original facts, actor,
reason, timestamp and measurement version. No correction/purge workflow was built.
Existing session UPDATE permissions remain outside this result-scoped phase.
Privileged deletion/DDL and initial client-supplied result values remain possible;
post-insert immutability does not verify physical training or measurement accuracy.
Future telemetry/timer design must still handle prescription snapshots, approximate
timing, idempotent delivery, background training and durable summaries.
No telemetry, audio, player edits or environment changes were introduced.
