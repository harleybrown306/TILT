drop policy if exists team_invitations_update_manager on public.team_invitations;
create policy team_invitations_update_manager
on public.team_invitations for update
to authenticated
using (
  private.is_admin((select auth.uid()))
  or (role = 'athlete'::public.team_member_role and private.can_manage_roster(team_id, (select auth.uid())))
  or (role = 'assistant_coach'::public.team_member_role and private.can_manage_team(team_id, (select auth.uid())))
)
with check (
  status <> 'accepted'::public.team_invitation_status
  and (
    private.is_admin((select auth.uid()))
    or (role = 'athlete'::public.team_member_role and private.can_manage_roster(team_id, (select auth.uid())))
    or (role = 'assistant_coach'::public.team_member_role and private.can_manage_team(team_id, (select auth.uid())))
  )
);
