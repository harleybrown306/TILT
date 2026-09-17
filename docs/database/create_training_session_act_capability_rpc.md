# Training session ACT capability RPC

`public.can_act_for_training_session(p_session_id uuid)` is a read-only,
authenticated capability boundary for the application. It returns `true` only
when the current `auth.uid()` can ACT for the durable athlete resolved from the
session. It accepts no actor, profile, athlete, team, role, or permission input
and delegates all authorization to `private.can_act_for_training_session`.

For 6C.3C, session SELECT independently establishes documented VIEW. A `true`
RPC result permits interactive training; `false` permits only the applicable
read-only UI. An RPC/database error must fail closed for ACT without being
treated as a VIEW denial.

The function is `STABLE`, `SECURITY DEFINER`, postgres-owned, has an empty
search path, returns only boolean, and is executable only by `authenticated`.
This intentionally produces the standard Security Advisor warning for an
authenticated public `SECURITY DEFINER` RPC; PUBLIC and anon have no EXECUTE.
