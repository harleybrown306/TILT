-- Phase 23: closed-beta programs are bootstrapped by a platform admin only.
-- Invitation recipients can still create verified Auth accounts, but cannot
-- self-provision a usable program through a direct teams INSERT.

drop policy if exists teams_insert_self_or_admin on public.teams;

create policy teams_insert_platform_admin_only
on public.teams
for insert
to authenticated
with check (
  private.is_admin((select auth.uid()))
  and created_by_user_id = (select auth.uid())
);
