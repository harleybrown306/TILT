-- Correct only the email-regex literalization in the invitation email check.
-- E'\\.' is parsed by PostgreSQL as the regex token '\.' (literal dot).
ALTER TABLE public.family_team_invitations
  DROP CONSTRAINT family_team_invitations_email_normalized;

ALTER TABLE public.family_team_invitations
  ADD CONSTRAINT family_team_invitations_email_normalized
  CHECK (
    invited_email = lower(btrim(invited_email))
    AND invited_email ~ E'^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'
  );
