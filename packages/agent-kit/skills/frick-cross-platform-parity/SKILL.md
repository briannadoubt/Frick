---
name: frick-cross-platform-parity
description: Use when reviewing or implementing behavior that must remain equivalent across TypeScript, Swift, and Kotlin Frick SDKs.
---

# Frick Cross-Platform Parity

Read `docs/cross-platform-client-contract.md`.

Parity checklist:
- Schema constants exist and match on all platforms.
- Structured error envelopes parse wrapped and top-level HTTP shapes.
- WebSocket Hello/HelloAck capability negotiation is equivalent.
- Cache metadata compatibility and reset semantics match.
- Object upserts, stream cursor behavior, presence auth, and diagnostics stay observable.

Run TypeScript tests plus Swift and Android checks when shared SDK semantics change.
