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
- Record development login assumptions in the spine.

Verify with tests that cross-tenant reads and writes are rejected.
