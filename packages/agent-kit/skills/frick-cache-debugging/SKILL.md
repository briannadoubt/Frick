---
name: frick-cache-debugging
description: Use when debugging Frick local cache metadata, incompatible-cache errors, pending appends, session-scope mismatch, or reset behavior.
---

# Frick Cache Debugging

Read `docs/cross-platform-client-contract.md`.

Checklist:
- Compare cached `schemaId`, `schemaVersion`, `schemaRevision`, `schemaHash`, `tenantId`, and `userId` against the current generated schema.
- Confirm pending append counts are preserved or reported before reset.
- Distinguish revision-compatible cache warnings from incompatible-cache failures.
- For session swaps, confirm TypeScript `setSession(...)` cleared framework state when `tenantId`/`userId` changed, or Swift sign-in cleared framework state when `userId` or `schemaHash` changed; Android currently reports `sessionScopeMismatch` until the app calls `resetCache()` or partitions cache storage.
- Keep reset operations limited to framework tables and caller-owned state untouched.

Verify on every affected SDK surface.
