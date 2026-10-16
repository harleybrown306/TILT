-- Run only against an approved read-only clone or a disposable database before
-- any account-mode backfill. The script is aggregate-only and rolls back.
BEGIN TRANSACTION READ ONLY;

-- Classify existing profiles from current authorization evidence. A platform
-- admin is treated as Coaching evidence; any staff/Family overlap is a manual
-- reconciliation case, never an automatic assignment.
WITH profile_evidence AS (
  SELECT
    profile.id,
    lower(btrim(auth_user.email)) AS normalized_email,
    auth_user.email_confirmed_at IS NOT NULL AS has_verified_email,
    profile.platform_role = 'admin'::public.platform_role AS platform_admin_evidence,
    EXISTS (
      SELECT 1
      FROM public.team_staff_memberships AS staff
      WHERE staff.profile_id = profile.id
    )
    OR EXISTS (
      SELECT 1
      FROM public.team_memberships AS membership
      WHERE membership.user_id = profile.id
        AND membership.role IN ('coach'::public.team_member_role, 'assistant_coach'::public.team_member_role)
    )
    OR EXISTS (
      SELECT 1
      FROM public.teams AS team
      WHERE team.created_by_user_id = profile.id
    ) AS coaching_evidence,
    EXISTS (
      SELECT 1
      FROM public.athlete_profile_relationships AS relationship
      WHERE relationship.profile_id = profile.id
        AND relationship.revoked_at IS NULL
        AND relationship.role IN ('guardian', 'self')
    ) AS family_evidence
  FROM public.profiles AS profile
  JOIN auth.users AS auth_user ON auth_user.id = profile.id
), candidates AS (
  SELECT
    *,
    CASE
      WHEN (platform_admin_evidence OR coaching_evidence) AND family_evidence THEN 'mixed_manual_review'
      WHEN platform_admin_evidence OR coaching_evidence THEN 'coaching_candidate'
      WHEN family_evidence THEN 'family_candidate'
      ELSE 'unresolved'
    END AS proposed_disposition
  FROM profile_evidence
)
SELECT
  proposed_disposition,
  count(*) AS profiles,
  count(*) FILTER (WHERE has_verified_email) AS profiles_with_verified_email,
  count(*) FILTER (WHERE NOT has_verified_email) AS profiles_without_verified_email
FROM candidates
GROUP BY proposed_disposition
ORDER BY proposed_disposition;

-- Pending invitations reserve an intended account family only for review in
-- this slice. No invitation writer reads this result or claims an email yet.
WITH pending_invitation_evidence AS (
  SELECT
    lower(btrim(invitation.invited_email)) AS normalized_email,
    CASE
      WHEN invitation.role = 'assistant_coach'::public.team_member_role THEN 'coaching'
      ELSE 'family'
    END AS proposed_mode,
    'legacy_team_invitation'::text AS source
  FROM public.team_invitations AS invitation
  WHERE invitation.status = 'pending'::public.team_invitation_status
    AND invitation.expires_at > pg_catalog.clock_timestamp()

  UNION ALL

  SELECT lower(btrim(invitation.invited_email)), 'family', 'family_team_invitation'
  FROM public.family_team_invitations AS invitation
  WHERE invitation.status = 'pending'::public.team_invitation_status
    AND invitation.expires_at > pg_catalog.clock_timestamp()

  UNION ALL

  SELECT lower(btrim(invitation.invited_email)), 'family', 'guardian_invitation'
  FROM public.guardian_invitations AS invitation
  WHERE invitation.status = 'pending'::public.team_invitation_status
    AND invitation.expires_at > pg_catalog.clock_timestamp()

  UNION ALL

  SELECT lower(btrim(invitation.invited_email)), 'family', 'child_login_invitation'
  FROM public.child_login_invitations AS invitation
  WHERE invitation.status = 'pending'::public.team_invitation_status
    AND invitation.expires_at > pg_catalog.clock_timestamp()
), invitation_summary AS (
  SELECT
    normalized_email,
    array_agg(DISTINCT proposed_mode ORDER BY proposed_mode) AS proposed_modes,
    array_agg(DISTINCT source ORDER BY source) AS sources
  FROM pending_invitation_evidence
  GROUP BY normalized_email
)
SELECT
  normalized_email,
  proposed_modes,
  sources
FROM invitation_summary
WHERE cardinality(proposed_modes) > 1
ORDER BY normalized_email;

-- Surface a pending invitation that conflicts with the currently inferred
-- disposition of an existing account using the same verified email.
WITH profile_candidates AS (
  SELECT
    lower(btrim(auth_user.email)) AS normalized_email,
    CASE
      WHEN profile.platform_role = 'admin'::public.platform_role
        OR EXISTS (
          SELECT 1 FROM public.team_staff_memberships AS staff
          WHERE staff.profile_id = profile.id
        )
        OR EXISTS (
          SELECT 1 FROM public.team_memberships AS membership
          WHERE membership.user_id = profile.id
            AND membership.role IN ('coach'::public.team_member_role, 'assistant_coach'::public.team_member_role)
        )
        OR EXISTS (
          SELECT 1 FROM public.teams AS team WHERE team.created_by_user_id = profile.id
        ) THEN 'coaching'
      WHEN EXISTS (
        SELECT 1 FROM public.athlete_profile_relationships AS relationship
        WHERE relationship.profile_id = profile.id
          AND relationship.revoked_at IS NULL
          AND relationship.role IN ('guardian', 'self')
      ) THEN 'family'
      ELSE NULL
    END AS proposed_mode
  FROM public.profiles AS profile
  JOIN auth.users AS auth_user ON auth_user.id = profile.id
  WHERE auth_user.email_confirmed_at IS NOT NULL
), pending_invitation_evidence AS (
  SELECT lower(btrim(invitation.invited_email)) AS normalized_email,
         CASE WHEN invitation.role = 'assistant_coach'::public.team_member_role THEN 'coaching' ELSE 'family' END AS proposed_mode,
         'legacy_team_invitation'::text AS source
  FROM public.team_invitations AS invitation
  WHERE invitation.status = 'pending'::public.team_invitation_status
    AND invitation.expires_at > pg_catalog.clock_timestamp()
  UNION ALL
  SELECT lower(btrim(invitation.invited_email)), 'family', 'family_team_invitation'
  FROM public.family_team_invitations AS invitation
  WHERE invitation.status = 'pending'::public.team_invitation_status
    AND invitation.expires_at > pg_catalog.clock_timestamp()
  UNION ALL
  SELECT lower(btrim(invitation.invited_email)), 'family', 'guardian_invitation'
  FROM public.guardian_invitations AS invitation
  WHERE invitation.status = 'pending'::public.team_invitation_status
    AND invitation.expires_at > pg_catalog.clock_timestamp()
  UNION ALL
  SELECT lower(btrim(invitation.invited_email)), 'family', 'child_login_invitation'
  FROM public.child_login_invitations AS invitation
  WHERE invitation.status = 'pending'::public.team_invitation_status
    AND invitation.expires_at > pg_catalog.clock_timestamp()
), profile_invitation_conflicts AS (
  SELECT
    profile_candidate.normalized_email,
    profile_candidate.proposed_mode AS existing_mode,
    invitation.proposed_mode AS invitation_mode,
    invitation.source
  FROM profile_candidates AS profile_candidate
  JOIN pending_invitation_evidence AS invitation
    ON invitation.normalized_email = profile_candidate.normalized_email
  WHERE profile_candidate.proposed_mode IS NOT NULL
    AND profile_candidate.proposed_mode <> invitation.proposed_mode
)
SELECT
  normalized_email,
  existing_mode,
  invitation_mode,
  array_agg(DISTINCT source ORDER BY source) AS invitation_sources
FROM profile_invitation_conflicts
GROUP BY normalized_email, existing_mode, invitation_mode
ORDER BY normalized_email, invitation_mode;

ROLLBACK;
