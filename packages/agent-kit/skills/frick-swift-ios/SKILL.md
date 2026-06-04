---
name: frick-swift-ios
description: Use when building or debugging Swift or iOS Frick clients, generated Swift DTOs, Swift runtime behavior, cache compatibility, push receive, or design-swift.
---

# Frick Swift iOS

Read `docs/cross-platform-client-contract.md`, `docs/push-receive.md`, and `docs/framework-boundaries.md`.

Guidance:
- Do not hand-edit generated Swift DTOs.
- Preserve schema constants, structured error parsing, WebSocket Hello/HelloAck behavior, cache compatibility, and reset semantics.
- For product schemas, pass the app schema identity and descriptor through `FrickClient(schemaId:schemaRevision:schemaHash:schemaDescriptor:)` so response guards, sync Hello payloads, `X-Frick-Schema-Hash` comparisons, and packed-frame decoding do not fall back to the foundation schema.
- Keep sign-in flows on the shared session installer path so a different `userId` clears framework cache state before the new session is installed.
- Keep subscribe/upsert/presence/signal frames issued immediately after `connect()` buffered until the WebSocket opens, with FIFO ordering behind Hello.
- Preserve reconnect subscription replay and tolerant `fetchObjects` row decoding; a reconnect should restore prior subscriptions, and one malformed object row should not poison the whole fetch.
- Preserve the sharing helpers (`createInvitation`, `acceptInvitation`,
  `listGrants`, `revokeGrant`) as thin wrappers around the framework HTTP
  routes; app-specific collaborator semantics belong above the SDK.
- Use `packages/design-swift` for generated design tokens.
- Keep iOS demo code thin; reusable client behavior belongs in `packages/swift`.

Run `pnpm swift:test` when touching Swift or design-swift paths. Run iOS build checks when app UI changes.
