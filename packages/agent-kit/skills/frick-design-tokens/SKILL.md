---
name: frick-design-tokens
description: Use when authoring, generating, or debugging Frick design tokens for web, Swift, or Android clients.
---

# Frick Design Tokens

Read `docs/framework-boundaries.md` and inspect `packages/design`.

Guidance:
- Author canonical token definitions in the design package.
- Regenerate platform outputs with `pnpm design:generate`.
- Do not hand-edit generated design files in web, Swift, or Android packages.
- Keep token changes coherent across React, SwiftUI, and Android consumers.

Verify with `pnpm design:generate`, `pnpm verify:generated`, and platform checks for touched clients.
