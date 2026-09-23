# Guardian invitation foundation provenance

The canonical normal-CLI migration artifact is
`supabase/migrations/20260922194927_create_guardian_invitation_foundation.sql`.

It introduces the independent `guardian_invitations` lifecycle and its narrow
authenticated RPC boundaries. The migration is the authoritative SQL source;
this document intentionally contains no alternate migration payload.

The feature grants an accepted recipient an active `guardian` relationship with
`manage_permission = false` and `training_permission = false`. Existing active
guardian relationships are preserved without modification.

Only an active `guardian` relationship with `manage_permission = true` may
create, revoke, or list guardian invitations. Self relationships, team staff,
admins, VIEW-only guardians, and ACT-only guardians do not qualify. Acceptance
locks the invitation, athlete, and inviter guardian relationship before it
rechecks authorization and active-athlete state; the recipient relationship is
then serialized by the deterministic advisory lock.

Invitation email comparisons normalize both sides as `lower(btrim(email))`.
Expiry must be after transaction time and no more than seven days later. Token
hash collisions remain uniquely constrained and return a controlled domain
error without exposing hash material.
