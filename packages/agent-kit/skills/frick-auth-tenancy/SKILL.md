---
name: frick-auth-tenancy
description: Use when changing auth, sessions, tenancy, tenant isolation, policy checks, or permission behavior in Frick apps.
---

# Frick Auth and Tenancy

Read `docs/threat-model.md`, `docs/cross-platform-client-contract.md`, and `docs/operations.md`.

Rules:
- Preserve tenant isolation for objects, streams, presence, signals, jobs, and blobs.
- Treat WebSocket session credentials as Hello payload or Authorization header credentials, not URL query tokens.
- Revalidate privileged WebSocket frames against the active session.
- Use structured auth errors: `auth.unauthenticated`, `auth.forbidden`, and `auth.sessionExpired`.
- When using `identityProviders`, keep the app-owned User mapping explicit and
  verify only the implemented provider routes: `/auth/apple/verify`,
  `/auth/apple/notifications`, `/auth/google/verify`,
  `/auth/oidc/:providerId/verify` (one per configured `identityProviders.oidc`
  entry), `/auth/email/signup`, `/auth/email/login`,
  `/auth/email/forgot-password`, and `/auth/email/reset-password`. Generic OIDC
  issuers are supported via `identityProviders.oidc`; do not treat SAML or
  arbitrary non-OIDC OAuth as implemented.
- For email password reset, keep the response enumeration-safe, store only
  hashed single-use tokens, route delivery through the app-owned reset hook,
  and delete active sessions after a successful reset.
- For sharing, keep grants tenant-bound and object-record scoped. Active grants
  may only relax `object.read` / `object.write` denials for the granted record;
  do not treat them as authorization for streams, child records, blobs, jobs,
  search, projections, or app-owned routes unless the app explicitly adds that
  behavior.
- Record development login assumptions in the spine.

Verify with tests that cross-tenant reads and writes are rejected.
