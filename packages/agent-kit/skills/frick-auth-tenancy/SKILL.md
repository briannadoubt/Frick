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
- When using `identityProviders`, keep the app-owned User mapping explicit and verify only the implemented provider routes: `/auth/apple/verify`, `/auth/apple/notifications`, `/auth/google/verify`, `/auth/email/signup`, and `/auth/email/login`; do not treat generic OIDC/SAML/arbitrary OAuth as implemented.
- Record development login assumptions in the spine.

Verify with tests that cross-tenant reads and writes are rejected.
