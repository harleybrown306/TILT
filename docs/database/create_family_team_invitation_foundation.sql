# Phase 13D.3 — Family-to-Team Invitation Foundation

## Historical provenance

`20260922024628_create_family_team_invitation_foundation.sql` is the exact SQL payload applied remotely and recorded under remote migration version `20260922024628`, with remote name `20260921190000_create_family_team_invitation_foundation`.

Its SHA-256 is `0bffa69963b8686a3468ac96afafdd7f2dd3a877ab6b136a397875cf4b0148ed`. It is the exact 380-line prefix of the originally authored 388-line source (`8ce0936e3d2c851ed2cda582aafbe3279ef29628bc6cd9a46af348b8c0b2b728`), ending with the summary-RPC grant. It deliberately does not claim the acceptance-RPC grant was applied.

The originally authored source is retained outside `supabase/migrations` as `create_family_team_invitation_foundation.intended.sql`, solely for documentation and static provenance testing.

## Forward correction

`20260922024629_grant_family_team_invitation_acceptance.sql` is strictly later than the remote historical version. Its only database mutation grants `authenticated` EXECUTE on `public.accept_family_team_invitation(text, uuid, text, text, integer)`.

Together, the historical migration and forward correction provide the intended narrow RPC access without rewriting the remote ledger or representing the omitted grant as historical fact. Existing `team_invitations` and legacy membership behavior remain unchanged.

## Pending forward correction

`20260922024630_fix_family_team_invitation_email_validation.sql` is a prepared, unapplied forward migration. It replaces only `public.create_family_team_invitation(uuid, text, text, timestamptz)` to use an `E`-string regex literal whose parsed PostgreSQL regex contains `\.` (a literal-dot matcher). It preserves the function signature, SECURITY DEFINER/search-path settings, and existing function ACLs; it makes no grants, RLS, table, legacy-object, or other function changes.
