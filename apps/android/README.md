# Frick Android

Android workspace for the Frick Kotlin SDK, Compose helpers, generated design
tokens, and the thin demo app.

## Modules

- `:frick` — reusable Kotlin client runtime: HTTP auth/object helpers,
  WebSocket sync, cache compatibility, product analytics, push receive,
  observable object/projection/call/sharing/session layers, and StateFlow
  diagnostics.
- `:frick-compose` — Compose helpers over the runtime, including
  `rememberFrickQuery` for typed object collections.
- `:design` — generated Android design-token bindings.
- `:app` — demo harness. Keep product behavior thin; reusable SDK behavior
  belongs in `:frick` or `:frick-compose`.

## Checks

From the repo root, run the generated-artifact steps before Android checks:

```bash
pnpm schema:generate
pnpm design:generate
```

CI/publish cover the framework modules:

```bash
cd apps/android
./gradlew :frick:testDebugUnitTest :frick:lintDebug :frick:assembleDebug \
  :frick-compose:lintDebug :frick-compose:assembleDebug \
  :design:testDebugUnitTest :design:lintDebug :design:assembleDebug
```

`pnpm android:build` is the stricter local check and also builds/lints `:app`
with the repo's expected JDK/Android SDK paths.
