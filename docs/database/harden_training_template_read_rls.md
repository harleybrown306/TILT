# Training template read RLS hardening

Applied to the authoritative Supabase database on 2026-09-14.

- Migration: `harden_training_template_read_rls`
- Remote migration version: `20260914182438`
- Exact applied SQL: [harden_training_template_read_rls.sql](harden_training_template_read_rls.sql)

This repository has no Supabase CLI migration directory, configuration, or
baseline workflow. These files record the approved remote migration; they do not
constitute a complete database bootstrap or a new CLI migration workflow.

## Changes

The existing private read helper now requires public master templates to have
`kind = template`, `visibility = public`, and `status = active`.
The parent SELECT policy delegates to that helper. Admin access and coach-owner
access are unchanged. The existing child-item SELECT policy already uses this
helper and was not altered.

The helper remains SQL, STABLE, SECURITY DEFINER, with an empty search path.
Its ACL is unchanged. A before/after hash of every other public RLS policy
matched. No write policy, management helper, lifecycle trigger, assignment,
session, invitation workflow, application code, or environment file was changed.

## Direct database validation

Tests used `SET LOCAL ROLE authenticated` and the existing users' auth.uid()
request claim, so SELECT queries exercised RLS rather than postgres bypass.
The existing master and four owner plans were moved through draft, active, and
archived states inside a transaction ending in ROLLBACK. No assignments or
sessions were inserted. A subsequent query confirmed all five plans retained
their original active state.

All assertions passed in each lifecycle state:

- Admin: master visible and all three master items visible.
- Non-admin coach: master and its items visible only when active.
- Owner: all four private coach plans visible in every state.
- Copies: both copies retain source_template_id; all seven copy items remain
  visible when the source master is draft or archived.
- Coach-visible assignment/session IDs remain unchanged across source states.
- can_manage_training_plan remains false for the non-admin coach and master,
  preserving the existing normal-coach assignment INSERT guard. The existing
  admin exception to assignment permissions was not changed.

Additional direct RLS SELECT checks for all three existing profiles matched the
current athlete/team-coach/admin predicates: six assignments and fifteen sessions
per profile in this dataset. No unauthorized INSERT was attempted.

## Security advisor

Before and after reports were identical: no errors and no new warnings.
Three pre-existing warnings remain:

1. Authenticated users can execute SECURITY DEFINER
   public.accept_team_invitation(text).
2. Authenticated users can execute SECURITY DEFINER
   public.get_team_invitation_summary(text).
   Both are intentionally exposed invitation RPCs; their permissions were not
   changed. [Advisor guidance](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable).
3. Leaked password protection is disabled.
   [Auth guidance](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

Independent copies intentionally preserve copied content and source UUIDs.
Foreign-key checks can reveal identifier existence; this migration restricts
master row/content reads, not all identifier side channels.

## Application checks

- TypeScript: passed, incremental writes disabled.
- ESLint: passed, cache disabled.
- All automated tests: 248 passed, zero failures/skips.
- Production build: Next.js Webpack build passed.
- No tests required changes.

## Rollback

Restore the previous helper by removing only its status = active condition.
The helper-based parent policy can remain: the previous helper reproduces the
original inline SELECT predicate. For an exact catalog rollback, also restore
the original parent predicate: admin OR coach owned by auth.uid() OR public
template, without a status requirement. This deliberately reopens the original
exposure. No data restoration is needed.
