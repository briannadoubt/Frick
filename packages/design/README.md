# @frick/design

Canonical design tokens (colors, typography, spacing, motion, semantic primitives) authored in TypeScript and consumed by every Frick design package. Run the generator to emit per-platform artifacts.

## Install

```sh
pnpm add @frick/design
```

## What's in here

- Authored tokens under `src/`
- A generator script (`pnpm --filter @frick/design generate`) that emits:
  - `packages/design-web/src/generated/*` — Web/React tokens
  - `packages/design-swift/Sources/FrickDesign/Generated/*` — Swift tokens
  - `apps/android/design/src/main/java/dev/frick/design/generated/*` — Android Compose tokens
- `pnpm --filter @frick/design check` validates the authored tokens against the schema

The generated packages are the consumption surface for app authors. Apps should not import `@frick/design` directly — use [`@frick/design-web`](../design-web) (Web), `FrickDesign` (Swift), or `dev.frick:design` (Android).

## License

See repository root.
