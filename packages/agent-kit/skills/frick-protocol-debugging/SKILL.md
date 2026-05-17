---
name: frick-protocol-debugging
description: Use when debugging Frick protocol frames, schema identity, MessagePack encoding, fixtures, generated DTOs, structured errors, or capability payloads.
---

# Frick Protocol Debugging

Read `docs/cross-platform-client-contract.md` and `docs/versioning.md`.

Guidance:
- Start with schema identity and generated artifact drift.
- Check structured error envelope shape across HTTP, WebSocket nacks, and client typed errors.
- Use protocol fixtures for cross-platform encoding behavior.
- Regenerate native artifacts after schema changes.

Run `pnpm schema:generate`, `pnpm fixtures:generate` when needed, and `pnpm verify:generated`.
