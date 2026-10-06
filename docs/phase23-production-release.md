# Phase 23: controlled closed-beta release

## Runtime and configuration

TILT is a Next.js 16 App Router application running on the Node.js server runtime. Build with `npm run build` and serve with `npm run start`. The repository selects no hosting provider.

The production runtime must provide the variables in [`.env.example`](../.env.example). `NEXT_PUBLIC_*` values are browser-visible and frozen at build time. `TILT_APP_URL` and `NEXT_PUBLIC_TILT_APP_URL` must be the exact same canonical HTTPS origin; no path, credentials, query, or fragment is valid. This prevents invitation and Auth links from using a preview hostname or request-derived host.

## Readiness and diagnostics

`GET /api/health` is public and dependency-free. It returns `200 {"status":"ok"}` only when core configuration is valid; otherwise it returns `503 {"status":"unavailable"}`. It does not disclose configuration, database state, users, migrations, or secrets. Responses are not cached.

Production configuration is validated before the Node.js server accepts traffic. An optional safe `TILT_RELEASE_ID` is exposed by health and used as the Next deployment ID to reduce stale-client/version-skew risk. Platform logs and existing privacy-safe operation references are sufficient for the first closed beta; alerting, metrics, dashboards, and error aggregation are post-beta decisions unless the selected host cannot retain/search logs.

## Access, email, and Supabase

Verified-email signup may remain enabled so invited people can create the account required to accept an invitation. An account alone cannot create a program: the Phase 23 migration restricts `teams` inserts to a platform admin whose profile ID is the creator. UI and Server Actions match this restriction, but RLS is authoritative.

Before the first program, an owner must bootstrap one verified production account as `platform_role = 'admin'` through the production Supabase console or an approved audited procedure. Do not use browser credentials for this change.

The repository remains email-provider-neutral. With no adapter, delivery returns `unavailable` and the copy-link fallback remains available without a service-role key. A future provider adapter must use the reserved-delivery RPC boundary, keep the service key server-only, distinguish provider acceptance from inbox delivery, avoid token logs, and preserve no-referrer links.

Supabase production requirements: set the canonical Site URL; allow the exact canonical `/auth/callback` redirect; enable and verify hosted email confirmation; apply migrations in repository order outside the application runtime; preserve migration RLS/RPC ownership and grants. The app has no Storage, Realtime, cron, or Edge Function requirement.

## Release sequence

1. **Owner:** choose hosting, canonical domain, and email-provider strategy.
2. **Domain owner:** configure DNS and HTTPS; stop if the canonical origin differs from either app-origin variable.
3. **Supabase owner:** configure Site URL, redirect allowlist, confirmed email, and the bootstrap platform admin; verify a controlled confirmation reaches `/auth/callback`.
4. **Release operator:** provide matching Supabase/origin values at build and runtime, plus a safe release ID; verify `/api/health` is 200.
5. **Release operator:** apply the complete migration history before app deployment; first verify the bootstrap account is admin. Stop on migration failure—application rollback cannot safely undo partial schema changes.
6. **Release operator:** deploy, then test sign-in, confirmation, invitation acceptance, admin-only program creation, workout completion, and stale-browser refresh.
7. **Operator:** stop beta onboarding for cross-origin Auth, unhealthy configuration, missing membership, or unexpected public program creation. Route traffic back to the prior compatible app build; do not roll back migrations without a migration-specific plan.

Provider selection remains an owner decision. Before enabling it, choose a sender/domain, API credentials, DNS records, sandbox/test mode, rate limits, and link-tracking behavior that does not rewrite or leak invitation tokens. Public-launch deletion/export, retention, minor consent, jurisdictional, and privacy/Terms gates remain outside Phase 23.
