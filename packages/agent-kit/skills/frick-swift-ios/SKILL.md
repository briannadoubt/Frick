---
name: frick-swift-ios
description: Use when building or debugging Swift or iOS Frick clients, generated Swift DTOs, Swift runtime behavior, cache compatibility, push receive, or design-swift.
---

# Frick Swift iOS

Read `docs/cross-platform-client-contract.md`, `docs/push-receive.md`, and `docs/framework-boundaries.md`.

Guidance:
- Do not hand-edit generated Swift DTOs.
- Preserve schema constants, structured error parsing, WebSocket Hello/HelloAck behavior, cache compatibility, and reset semantics.
- Use `packages/design-swift` for generated design tokens.
- Keep iOS demo code thin; reusable client behavior belongs in `packages/swift`.

Run `pnpm swift:test` when touching Swift or design-swift paths. Run iOS build checks when app UI changes.
