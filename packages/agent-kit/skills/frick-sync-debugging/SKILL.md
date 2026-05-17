---
name: frick-sync-debugging
description: Use when debugging Frick realtime sync, WebSocket handshakes, capability negotiation, cursors, reconnects, nacks, or live updates.
---

# Frick Sync Debugging

Read `docs/cross-platform-client-contract.md` and `docs/operations.md`.

Debugging path:
1. Confirm schema identity and cache metadata.
2. Inspect Hello/HelloAck capability negotiation.
3. Check auth state and session revalidation.
4. Inspect cursors, pending mutations, and last structured error.
5. Use dashboard and inspect routes for server-side state.

Prefer reproductions that cover the original symptom and keep parity across TypeScript, Swift, and Kotlin when the behavior is shared.
