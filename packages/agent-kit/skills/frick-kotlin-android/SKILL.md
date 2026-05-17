---
name: frick-kotlin-android
description: Use when building or debugging Kotlin or Android Frick clients, generated Kotlin DTOs, Android runtime behavior, cache compatibility, push receive, or design modules.
---

# Frick Kotlin Android

Read `docs/cross-platform-client-contract.md`, `docs/push-receive.md`, and `docs/framework-boundaries.md`.

Guidance:
- Do not hand-edit generated Kotlin DTOs.
- Preserve schema constants, structured error parsing, WebSocket Hello/HelloAck behavior, cache compatibility, and reset semantics.
- Use Android design artifacts from the design module.
- Keep Android demo app code thin; reusable behavior belongs in `apps/android/frick` or documented extension points.

Run `pnpm android:build` when touching Android paths.
