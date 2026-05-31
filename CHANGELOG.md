# Changelog

All notable changes to Frick framework packages are recorded here. The format is loosely based on [Keep a Changelog](https://keepachangelog.com/) and the versioning policy lives in [`docs/versioning.md`](docs/versioning.md).

Each package version is independent — a release header documents which packages moved and by how much.

## Unreleased

### Server — generic OIDC provider routing

- **`@frick/server`:** `createFrickServer({ identityProviders })` now accepts an `oidc` array of generic OpenID Connect providers, so apps can plug in any standards-compliant issuer (Okta, Auth0, Microsoft Entra, Keycloak, …) for sign-in alongside the existing Apple / Google / email providers (FR-30). Each provider is `{ id, issuer, clientId, audience?, jwksUri? | discovery, claimMappings? }` and mounts `POST /auth/oidc/:providerId/verify`. The client obtains an `id_token` from the issuer and POSTs it; Frick verifies signature + `iss` + `aud` (defaulting to `clientId`) + expiry with `jose` against the provider's JWKS — resolved either from a directly-configured `jwksUri` or by fetching the issuer's `<issuer>/.well-known/openid-configuration` discovery document (`discovery: true`) and reading its `jwks_uri`. When discovery is used the document's own `issuer` must match the configured issuer (defense against a hijacked well-known endpoint). An optional request `nonce` is checked when supplied. Standard claims (`sub`, `email`, `name`, `preferred_username`) plus any `claimMappings.extra` (`{ "<UserField>": "<claim>" }`) populate the app-owned User object; first sign-in runs the same `onFirstSignIn` hook the other providers use (now `provider: "oidc"` with `providerId`), and a normal bearer session is minted exactly like the Google path. The verified `sub` is stored on the new `oidcSubject` User field as a per-provider composite `"<providerId>:<sub>"`, so two issuers reusing the same subject never alias onto one account. Session TTL/limiter unification across providers remains separate follow-up work (FR-29). New exports: `OidcProviderConfig`, `OidcClaimMappings`, `OidcProviderRuntime`, `VerifiedOidcIdentity`, `VerifyOidcOptions`, `OidcDiscoveryDocument`. No change to Apple, Google, or email behavior. See [`docs/operations.md`](docs/operations.md).

### Server — live projection delta-push over the sync gateway

- **`@frick/server`:** Apps can now register projections at boot via the new `ServerOptions.projections` field (`createFrickServer({ projections: [...] })`). Each projection's declared object/stream `sources` are validated against the active schema at startup — an unknown source type fails fast with a `FrickConfigError` instead of silently never matching a write (FR-110). Registered projections remain available for HTTP read at `GET /projections/:name`.
- A projection's `apply` now runs on object upserts made through the durable write path (`upsertObjectWithPolicy`, used by `PUT /objects/...` and the WebSocket `ObjectUpsert` frame), not only the legacy positional `upsertObject`. Previously object-sourced projections (and search indexes) never observed writes from the normal app paths; stream-sourced projections were unaffected.
- Sync clients subscribing with kind `"projection"` now receive an **initial snapshot** of the projection's current rows (delivered as a `ProjectionDelta` frame) followed by live `ProjectionDelta` updates as source objects/streams change. Both the snapshot and live deltas are scoped to the subscriber's tenant — cross-tenant rows are never leaked (FR-111). The registry materializes a tenant-scoped row map from each `apply` change to back the snapshot. No wire-protocol or `@frick/core` change — the existing `useProjection()` client path consumes the snapshot exactly like an incremental delta. See [`docs/operations.md`](docs/operations.md).

### Design — runtime design-context switching (web)

- **`@frick/design-web`:** `FrickDesignProvider` now switches the full design context — `mode` (`system` | `light` | `dark`), `density` (`compact` | `regular` | `comfortable`), `brand` (`frick` | `frickenChat` | custom), and `iconPack` (`native` | `frick` | custom) — at runtime with no reload. The provider applies the matching `data-frick-*` attributes that select the generated CSS-variable block in `tokens.css`, so every resolved color, metric, and component re-resolves live when any axis changes (FR-95). Each axis can be **controlled** (pass the prop) or **uncontrolled** (`default*` props + the new `setMode` / `setDensity` / `setBrand` / `setIconPack` / `setDesignContext` setters exposed on the context). The new `useDesignContext()` hook is the canonical accessor; `useFrickDesign()` remains as an alias.
- Context axis types were realigned with the canonical `@frick/design` model (previously `density` was missing `regular`, `brand` was missing `frickenChat`, and `iconPack` was `lucide`). The provider default context is now `light` / `regular` / `frick` / `native`, matching the `:root` block emitted by `pnpm design:generate` (it previously defaulted to `comfortable`, which did not match the generated default).
- Icons are now icon-pack-aware: `FrickIconGlyph` (and every component that renders an icon) renders the platform-native lucide glyph for `iconPack: "native"` and a self-contained brand fallback pack (`frickIcons`) for any non-native pack, so switching the icon pack updates rendered glyphs live. Exposes `nativeIcons`, `frickIcons`, and `iconPackFor()`. The previous `semanticIcons` export is kept as an alias of `nativeIcons`.
- No generated artifact, token schema, or `components.css` change. iOS/Android are unchanged.

### Server / CLI — Web Push adapter export + VAPID provisioning

- **`@frick/server`:** The Web Push adapter is now a documented package export, completing the push trio next to APNs and FCM. `createFrickWebPushAdapter` and its types are reachable both from the package root and via the new `@frick/server/push/web-push-adapter` subpath (mirroring `@frick/server/push/apns-adapter` and `@frick/server/push/fcm-adapter`). No adapter behavior changed — Web Push still deliberately sends an empty push body; encrypted payloads (RFC 8291) remain follow-up work (FR-7).
- **`@frick/cli`:** `frick tenants set-push --platform webpush --subject <mailto:|https:> --public-key <b64url> --private-key <pem-file>` now provisions per-tenant Web Push VAPID credentials, encrypting them with `FRICK_PUSH_CRED_KEY` into `tenant_settings.push.webPush.encrypted` (same envelope as the existing `apns`/`fcm` workflows). Private key material is read from disk and is not echoed. See [`docs/push-adapters.md`](docs/push-adapters.md).

### Protocol — optional schema artifact signing + client verification

- **`@frick/protocol`:** Added OPTIONAL Ed25519 signing of generated schema artifacts to close the build-pipeline poisoning gap in [`docs/threat-model.md`](docs/threat-model.md) (FR-45). New exports `signSchemaArtifact` / `verifySchemaArtifact` (plus `verifySchemaArtifactForSchema`, `schemaArtifactIdentity`, `schemaArtifactManifestEntry`, `canonicalizeSchemaIdentity`, `sha256Hex`) sign over a canonical representation of the schema identity — `schemaId` + `schemaHash` + `schemaRevision` + a manifest of emitted artifact files and their SHA-256 digests — using `node:crypto`. Keys may be `KeyObject`, PEM, or base64-DER. Verification returns a structured `{ valid, reason }` result instead of throwing.
- `pnpm schema:generate` now emits a detached signature at `packages/protocol/generated/schema-signature.json` **only when** `FRICK_SCHEMA_SIGNING_KEY` is set; without a key, signing is a no-op so default generation is byte-for-byte unchanged and `pnpm verify:generated` stays clean. The signature path is gitignored (release-pipeline artifact, never committed). `packages/protocol/scripts/verify-schema-signature.ts` is a runnable example clients can adapt to verify a bundle against a trusted public key. No mandatory key infrastructure is required.

### Protocol / Server — field sensitivity classification

- **`@frick/protocol`:** Schema field definitions (`FieldDef`) accept an optional `sensitivity` classification — one of `public | private | pii | secret | content` — so logging, diagnostics, and (future) export/deletion workflows can treat field values appropriately. The annotation is fully optional and backward-compatible: existing schemas without it keep working, the value is validated by `validateSchema` (unknown classifications are rejected), and it is **server-only metadata** that is not propagated to generated native artifacts (Swift / Kotlin / TS bindings), so adding it never requires regenerating those outputs and is wire-backwards-compatible. Fields that omit the annotation resolve to a conservative default of `private` (`DEFAULT_FIELD_SENSITIVITY`) via the new `resolveFieldSensitivity` helper. A new `redactRecord` / `redactRecords` helper (plus `fieldSensitivityMap`, `shouldRedactSensitivity`, and `REDACTED_FIELD_VALUE`) masks values whose declared classification is in the redaction set — `pii`, `secret`, and `content` by default (`DEFAULT_REDACTED_SENSITIVITIES`) — while leaving `public`/`private` values intact.
- **`@frick/server`:** The mounted dashboard object-data inspection API (`GET /_frick/dashboard/api/data/objects/:type`) now redacts schema fields classified `pii` / `secret` / `content` before returning rows, so raw sensitive values never surface in admin or tenant inspection output. `public` and (default) `private` values pass through unchanged. This complements the structured logger's existing name-based redaction. Full export/deletion flows are out of scope here (tracked separately).

### Server — storage-driver selector

- **`@frick/server`:** Added a durable-storage driver selector to runtime config so a future Postgres driver can be chosen. `FRICK_DB_DRIVER` (`sqlite` | `postgres`, default `sqlite`) selects the driver, and `FRICK_DATABASE_URL` is parsed into config for future Postgres use. SQLite remains the default and the only implemented driver — `FRICK_DB_PATH` and the production `":memory:"` guard are unchanged. Selecting `FRICK_DB_DRIVER=postgres` fails fast at config validation with `postgres storage driver is not yet implemented (FR-22)`. No runtime behavior change for existing SQLite deployments. See [`docs/operations.md`](docs/operations.md) for the new env vars.

### Server — grantee leave-share / self-revocation

- New `POST /share/grants/:id/leave` route lets the grantee of a share self-revoke ("leave") their own grant, returning `{ grant }` with the revoked row. Previously only the grant owner could revoke (via `DELETE /share/grants/:id`), so a recipient had no way to drop their own access (FR-72). The new route is grantee-only: any other caller — including the owner — gets a tenant-isolated `404`, and `DELETE` remains owner-only. Self-revocation reuses the existing idempotent revoke path, so leaving an already-revoked grant returns the existing revoked row. Documented in `docs/operations.md` and `docs/threat-model.md`.

### Design — token validation hardening

- `@frick/design` validation (`pnpm design:check`, run as part of `pnpm design:generate` / `pnpm verify:generated`) now catches more classes of token mistakes and fails the build on any of them:
  - **Off-scale spacing/radius:** literal `semantic.spacing` / `semantic.padding` / `semantic.corner` values (including density overrides) must be members of the declared `primitive.space` / `primitive.radius` scales, not merely on the 4-point grid.
  - **Circular aliases:** alias cycles are now detected statically across every mode/density/brand layer combination, not just the single default resolve, so a cycle hidden in an override layer is reported up front with its full chain.
  - **Missing icon mappings:** component `icon.*` aliases that point at a key absent from `icons` are flagged with the offending component path instead of silently emitting a dangling glyph name.
  - **Color contrast:** the resolved semantic palette is checked for WCAG 2.1 contrast across all modes/brands — body-text pairs against AA (4.5:1) and the action-button label pair against AA-large (3:1).
  - **Raw styling literals:** a new linter scans the handwritten `packages/design-web/src/components.css` and rejects raw color literals (hex / `rgb()` / `hsl()`) and fractional `opacity` values in component rules, steering them to `var(--frick-*)` tokens. Definitions in the `--frick-*` bridge layer and structural numerics (`0`/`1` opacity, grid/`minmax`/`%`/breakpoints) are exempt.
- Tokenized the one pre-existing raw literal this surfaced: the disabled-state `opacity: 0.48` in `components.css` now references a new `--frick-opacity-disabled` bridge variable (mirroring `primitive.opacity.disabled`). No generated artifact or rendered value changed.

### Server — CORS subdomain/suffix wildcard origins

- `FRICK_ALLOWED_ORIGINS` (and the `allowedOrigins` config override) now accept subdomain wildcard entries of the form `<scheme>://*.<host>` (e.g. `https://*.example.com`) alongside the existing allow-all `*` and exact-origin entries. A wildcard matches any non-empty subdomain prefix over the same scheme and port (`https://app.example.com`, `https://a.b.example.com`) but not the apex host (`https://example.com`) unless that exact origin is also listed. Large multi-tenant deployments no longer need to enumerate every per-tenant origin. Matching is shared by the HTTP preflight/response path and the WebSocket upgrade `verifyClient` check; wildcard-matched requests reflect the concrete request origin (with `Vary: Origin`), never the pattern string. Malformed entries (bare-host wildcards like `https://*`, mid-host wildcards, multiple wildcards, or non-origin strings) are rejected at config load with `FrickConfigError`. The production default remains the closed empty allowlist.

### Server — per-principal connection cap

- `@frick/server` now enforces a per-principal concurrent WebSocket connection cap in addition to the existing global `maxWebSocketConnections` cap. The new `FrickLimits.maxConnectionsPerPrincipal` field (default `64`) is keyed by `(tenantId, userId)` and enforced at connect when a bearer token is present, otherwise at the `Hello` handshake. Over-cap connections receive a structured `rateLimit.exceeded` Nack (with `details.limit: "maxConnectionsPerPrincipal"`) and are closed with code `1013`, without affecting other principals. Configurable via `createFrickServer({ limits })` or the `FRICK_MAX_CONNECTIONS_PER_PRINCIPAL` env var (an explicit `limits` override wins over the env var). Counters are in-process and reset on restart, consistent with the single-node model.

### Server — outbound email adapter surface

- `@frick/server` now exports a documented outbound email surface, mirroring the push-adapter convention. New exports from the main entrypoint: the `FrickEmailAdapter` / `FrickEmailMessage` / `FrickEmailDelivery` / `FrickEmailContext` interfaces, `createFrickEmailRouter` (+ `FrickEmailRouter` and its option/helper types), `createFrickResendEmailAdapter` (the Resend reference adapter, reading `RESEND_API_KEY`), and `createFrickTestEmailAdapter` (the in-memory test sink). The Resend adapter is also reachable via the `@frick/server/email/resend-adapter` subpath, matching `@frick/server/push/apns-adapter`.
- `identityProviders.email` gained an opt-in `outbound` config (`EmailOutboundConfig`): supply an adapter + `defaultFrom`, and the framework dispatches the password-reset email (`/auth/email/forgot-password`, when a `resetUrl` builder is provided) and a first-sign-in welcome email (`/auth/email/signup`, when `welcome` is set) through it. URL composition stays in app code. Sends are best-effort — a failed delivery is logged and audited in the DevTools event feed but never fails the originating auth request. The existing `onPasswordResetRequested` hook still fires and coexists with framework-managed dispatch, so apps that want full control keep their seam.

### Bug Fixes

- **Swift SDK:** `FrickSyncSocket.sendFrame` now buffers frames into the existing pending queue when the WebSocket task isn't open yet, instead of throwing `notConnected`. This fixes a race where consumers issuing `subscribeObject` / `subscribePresence` / `setPresence` / `clearPresence` / `subscribeProjection` immediately after `FrickClient.connectSync()` (which schedules `openSocket()` on a detached Task) would intermittently fail. Buffered frames flush in FIFO order right after the hello handshake lands.

### Swift SDK — per-app schema hash override

- `FrickClient.init(...)` now accepts a `schemaHash: String` parameter (default `FrickSchema.schemaHash`). Apps with a custom protocol schema can pass their own hash so wire-level guards — response envelopes (`requireCompatibleSchema(expected:)`), the `X-Frick-Schema-Hash` header, the sync Hello frame, and cache-metadata bootstrap — compare against the app's hash rather than the generated foundation default. `FrickSyncSocket.init(...)`, `FrickClientCapabilities.defaultIOS(...)`, and `FrickCacheMetadata.currentSchema(...)` gained matching defaulted `schemaHash:` parameters so the override threads end-to-end. Unblocks RangerCRM (and other consumers) from the previous workaround of aligning their server's `schema.hash` to the foundation hash.

### Swift SDK — auto reset-cache on session swap

- `FrickClient` now auto-resets the on-disk cache when an auth call installs a session for a *different* `userId` than the one currently in the store (RCRM-45). All sign-in / sign-up entry points (`signInWithApple`, `signInWithEmail`, `signUpWithEmail`, `signInWithGoogle`, `signUp`, `login`, `devLogin`) and `restoreSession` funnel through a private `installSession` helper that compares incoming-vs-current `userId` and only clears storage on a real swap. Consumers no longer have to call `resetCache()` before swapping users to avoid the session-scope-mismatch guard; same-user reauth and first-sign-in are unaffected.

### Framework Boundary Cleanup

- Removed the public `@frick/core/chat` subpath and moved chat/demo helpers back under `apps/web/src/chat-foundation.ts`.
- Removed most chat-specific React helpers from the public `@frick/react`
  entrypoint; the web demo now owns its auth, blob, search, draft, media, and
  realtime wrappers locally. `useOptionalEndpoint` remains generic, and
  `useInbox` remains as a legacy wrapper for apps that still expose `/inbox`;
  the framework server no longer ships the inbox route.
- Replaced the shipped foundation schema with an empty generic schema. Frick no longer ships customer-facing `User`, `Conversation`, `MessageStream`, inbox, typing, call, draft, attachment, or push-job product shapes.
- Removed framework-owned chat routes, projections, search indexes, scheduled-message sweep logic, and conversation inbox storage from the server runtime.
- Removed chat/inbox/message/draft convenience APIs from the Swift and Android SDKs; apps build those nouns in their own schema and client layer.

### Cohesive SDK Refactor (Phases 1–6)

A multi-commit rollout that lifts the client SDKs from "you can hand-write it" to "the SDK does the obvious thing":

#### Phase 1 — Codegen foundation + chat helpers graduated

- New TypeScript schema generator (`generateTypeScriptBindings`) emits typed DTOs, tagged-union stream-event types, a `FrickBindings` interface, and field-id lookup tables. Output written to `packages/core/src/generated/bindings.ts` so consumers get `frick.Conversation.useAll()` with full autocomplete.
- New typed error-code generators emit Swift `FrickErrorCode: String` enums, Kotlin `enum class FrickErrorCode(val wireValue: String)` with `fromWire(...)` round-tripping, and a TS const-union + membership predicate — all derived from a single `FRICK_ERROR_CODES` source-of-truth array.
- `bindSchema(client, schema)` runtime factory in `@frick/core` flattens schema entries into name-keyed bindings that reuse the existing `Signal<T>` cache.
- New backwards-paginated read primitive: `StreamStore.readBefore(...)` + `?before=N&limit=M` on the `/streams/:name/:key` route + `FrickClient.loadOlder(stream, key, count, before?)`.
- Chat-demo helpers are app-owned in `apps/web/src/chat-foundation.ts`; framework packages expose the generic runtime primitives they build on.

#### Phase 2 — Optimistic mutations + persistent web cache + devtools

- `OptimisticOverlay` in `@frick/core` synthesizes display-only events / object upserts into the runtime's `stream()` / `objects()` signals before server Ack. `client.append(..., { optimistic })` and `client.upsertObject(..., undefined, { optimistic: true })` opt in; the new Promise rejects with `OptimisticConflictError` on `storage.conflict` nacks so the UI can roll back.
- `openIndexedDBFrickCache({ dbName, indexedDB? })` factory in `@frick/core` mirrors every write through to IndexedDB so a page reload preserves objects, stream events, cursors, and the pending-append queue. Closes the web client's parity gap with iOS/Android SQLite caches.
- New `@frick/devtools` workspace publishes a `<FrickDevtools enabled />` React component — floating panel polls `/_frick/inspect/devtools/events`, surfaces connection status + frame log + push deliveries + filter-by-kind input. Dependency-free inline styles; gate behind `import.meta.env.DEV` in production.

#### Phase 3 — Auth/blob/search hooks + breaking `useStream` shape

- `useStream(...)` now returns `{ events, loadOlder, hasMore, loading }` instead of a bare array. **Breaking change** — pre-1.0 with `greenfield-cutover` compatibility makes this safe. `useAppend` / `useUpsertObject` gain optional `{ optimistic }` options threading into the Phase 2 overlay.
- Demo auth, blob upload, and search wrappers now live under `apps/web/src/demo-*.tsx` instead of the framework React package.

#### Phase 4 — Realtime UX wrappers + media memos

- Demo realtime and media wrappers now live under `apps/web/src/demo-*.tsx` instead of the framework React package.

#### Phase 5 — Native parity

- Kotlin: `FrickSyncSocket.subscribePresence` / `setPresence` / `clearPresence` (closes the gap with Swift + TypeScript). New `FrickInboundEvent.PresenceDelta(name, records, cleared)` case + `PRESENCE_DELTA` frame handler. `FrickClient.search(index, q, filter, limit)` mirrors the Swift+TS search call with typed `FrickSearchResponse`.
- Swift: `FrickClient.search(...)` + `FrickSearchHit` / `FrickSearchResponse` Codable structs. New `Sources/FrickSwift/SwiftUI/FrickStream.swift` adds `@FrickStream("MessageStream", key:)` and `@FrickPresence("TypingState", key:)` property wrappers driven by an `@Environment(\.frickSyncSocket)` key.
- Swift: `FrickDraftStore` syncs per-user/per-conversation `MessageDraft` rows over `FrickSyncSocket.subscribeObject` and `upsertObject`.
- New `:frick-compose` Gradle module: `rememberFrickStream(socket, stream, key)` + `rememberFrickPresence(...)` + `UseFrickEvents` / `UseFrickStatus` Composables. Lives in its own module so the base `:frick` SDK stays Compose-agnostic.
- Android: `FrickDraftStore` mirrors the React and Swift draft id convention and syncs `MessageDraft` rows through object subscriptions/upserts.
- Web Push adapter (`createFrickWebPushAdapter`) rounds out the APNs/FCM trio. VAPID-authenticated ES256 JWT signing, per-tenant credential storage in `tenant_settings.push.webPush.encrypted`. Maps 410 / 404 → `push.unregistered`, 429 → `push.rateLimited`, etc.

#### Phase 6 — Production lifecycle

- Outbound email: `FrickEmailAdapter` interface + `createFrickTestEmailAdapter` (default) + `createFrickResendEmailAdapter` (Resend reference implementation, `RESEND_API_KEY` from env). `createFrickEmailRouter(...)` wraps every send with `frick.email.delivery` devtools telemetry, `redactEmail`-masked recipient logs, and convenience helpers `sendVerificationEmail` / `sendPasswordResetEmail`.
- Composer drafts: `useDraft(conversationId)` in `@frick/react` persists composer text per `(user, conversation)` in `localStorage` with a 250ms debounce by default. Passing `{ sync: true }` uses the `MessageDraft` foundation object for cross-device drafts, with last-write-wins retry on version conflicts.
- Product analytics client API: `trackAnalyticsEvent(...)`, TypeScript/Swift/Android `FrickClient.track(...)`, and `useTrackAnalyticsEvent()` send authenticated `analytics.user_event` records to the platform event pipeline. React apps now get automatic session-gated route/screen tracking from `<FrickProvider>` by default, with privacy-safe path/title route payloads and `autoAnalytics={false}` as the opt-out.
- Standalone Fricken Dashboard now loads product analytics through authenticated inspection (`/_frick/inspect/analytics/summary`) and uses the existing inspection platform-event route, so `frick dashboard` can show analytics and pipeline health without mounted server mode.
- TypeScript client OpenTelemetry bridge: `FrickClient` and standalone analytics helpers now emit OTel-compatible analytics and sync WebSocket spans/metrics by default, correlate analytics events with active trace ids, bound frame labels, sanitize close telemetry, and allow `telemetry: false`, `setDefaultClientTelemetryRuntime(...)`, or a custom `FrickClientTelemetryRuntime`.
- Swift and Android client telemetry hooks: native `FrickClient.track(...)` calls now emit dependency-light `frick.analytics.track` spans plus analytics event/duration metrics through host-provided runtimes, correlate missing analytics `traceId` values from the active span, and optionally propagate `traceparent` without bundling native OTel SDKs. Android custom transports can keep implementing `post(path, body)` and override the header-aware overload only when they need `traceparent` forwarding.
- Server package boundary: `@frick/server` now has an import-safe package entrypoint, build script, dist export map, documented push-adapter subpath exports, and a separate `src/dev.ts` runnable entry so importing the package no longer starts a listener. Scaffolded servers and smoke tests use `app.listen()` / `app.close()`, and custom-schema servers skip foundation seed rows that do not belong to the app schema.
- `@frick/server` now exports job handler/registry/result types from its
  package entrypoint so deployable app modules can register jobs without deep
  imports.
- Web demo hardening: Vite serve/preview responses now include CSP and browser security headers, and production builds emit the strict header set to `dist/_headers` for static hosts that honor it. Preview uses a stricter no-`unsafe-inline`/no-`unsafe-eval` CSP; dev keeps the local HMR allowances Vite needs. Demo auth sessions are kept in memory only; startup, sign-in, and logout purge legacy browser-stored bearer tokens and logout clears browser push-registration state.
- Web background sync: `apps/web/public/frick-sw.js` Service Worker handles the `frick-pending-appends` sync tag (posts `frick:flush` to clients) and push receive + `notificationclick` deep-link routing. Notification click targets are normalized to same-origin app routes before `postMessage` / `openWindow`. `registerFrickBackgroundSync({ onFlush, onNavigate })` helper in `@frick/core` does the registration dance with graceful degradation when the Background Sync API is missing.

#### Protocol

- Generator now emits a `FrickSchemaDescriptor` (Swift `enum`) and `FRICK_*` constant tables (Kotlin `internal val`s) alongside the existing DTOs: type-id → name and (typeId → fieldId → fieldName) for objects, streams, and events. Used by the native SDKs to decode packed Delta tuples back into named-field shapes.
- `HelloPayload` gains an optional `sessionToken`. WebSocket clients authenticate with the Hello token or an `Authorization: Bearer ...` upgrade header; `sessionToken` URL query credentials are no longer accepted.
- WebSocket sync now rejects all non-`Hello`/non-`Ping` frames until a compatible `HelloAck` has been sent, returning a structured `sync.protocolError` Nack without persisting writes.

### Server (`@frick/server`)

- Added a configurable replay-window bound for `requestId` idempotency
  (`FRICK_IDEMPOTENCY_REPLAY_WINDOW_MS`, default 24h). A retry whose
  idempotency record is older than the window is no longer deduplicated and
  mints a fresh event. The bound is enforced at lookup time — independent of
  durable retention/pruning — and the idempotency key is upserted so a
  beyond-window replay rewrites it to the new event.
- Added framework sharing primitives: `POST /share/invite` creates a
  single-use invitation token for an object record, `POST /share/accept`
  redeems a token into a durable grant, `GET /share/grants` lists active grants
  for the principal as owner or grantee, and `DELETE /share/grants/:id`
  revokes owner-issued grants. Active grants relax same-tenant `object.read`
  and `object.write` denials for the granted record only.
- Added optional `identityProviders.apple` server routes. Apps can mount
  `POST /auth/apple/verify` for Apple identity-token verification and
  `POST /auth/apple/notifications` for Apple server-to-server notifications;
  Frick maps the verified subject into an app-owned User object, calls
  first-sign-in/revocation hooks, mints normal sessions, and revokes sessions
  on Apple consent revocation or account deletion.
- Added optional `identityProviders.google` and `identityProviders.email`
  routes. Google verifies ID tokens against the configured OAuth client id at
  `POST /auth/google/verify`; email/password signup and login are available at
  `POST /auth/email/signup` and `POST /auth/email/login`, using the same
  app-owned User mapping, first-sign-in hook, and session shape.
- Email/password identity routes now include `POST /auth/email/forgot-password`
  and `POST /auth/email/reset-password`. Reset tokens are single-use,
  SHA-256-hashed at rest, expire after 60 minutes, avoid email enumeration on
  request, and delete active sessions after a successful password change.
- `POST /analytics/events` now ingests authenticated product analytics into
  the platform event pipeline as `analytics.user_event`, deriving tenant,
  subject, device, and replica identity from the active session and returning
  pipeline receipts with idempotency duplicate status.
- Structured logger redaction now recurses through nested fields and redacts common secret-shaped names such as tokens, passwords, authorization headers, API keys, and private keys.
- Auth sessions now store a SHA-256 digest of the bearer token in SQLite instead of the raw replayable token; the migration rebuilds `auth_sessions`, revoking pre-existing sessions.
- `POST /search` now applies source-level visibility to custom search indexes before returning hits; object-backed hits are checked against object visibility, stream/projection hits without provable source identity fail closed, and framework-reserved source fields are not exposed.
- Custom app-source search indexes now fail closed for tenant users until an app policy hook explicitly allows `search.query`; built-in and foundation-backed indexes with framework visibility proof keep their existing access, and admin principals can still query for operations.
- Admin audit writes are fail-closed for tenant creation, tenant setting writes, account creation, job enqueue, search rebuild, and projection rebuild. Rebuild routes record the allow intent before non-rollbackable work starts.
- Logout now closes active WebSocket sessions for the revoked session token, and privileged WebSocket frames revalidate the backing session row before writes or subscriptions.
- Forward stream pages are bounded by `maxStreamPageSize` across HTTP, SSE initial pages, and WebSocket subscriptions; responses include `cursor` and `hasMore` for continuation.
- WebSocket and SSE admission are bounded by `maxWebSocketConnections` and `maxSseConnections`.
- WebSocket and SSE outbound buffers are bounded by `maxWebSocketOutboundBufferedBytes` and `maxSseOutboundBufferedBytes`; slow clients are closed instead of accumulating unbounded queued data.
- `/auth/signup`, `/auth/login`, and `/auth/dev-login` now use an in-process fixed-window limiter keyed by route, tenant, and identity/IP, returning `429 rateLimit.exceeded` after `maxAuthAttemptsPerWindow`.
- Search requests now enforce query/filter size limits and return a sanitized `sync.protocolError` envelope for invalid adapter query syntax instead of leaking SQLite/FTS parser details.
- Admin search rebuild now rejects projection-backed indexes instead of clearing them through an empty generic source iterator.
- **APNs push adapter** — HTTP/2 over `node:http2`, persistent per-tenant sessions, ES256 JWT signed from the tenant's stored `.p8` PEM and cached for ~50 minutes. Maps `Unregistered` / `BadDeviceToken` / `ExpiredProviderToken` onto the framework's revocation codes so the router tombstones the dead registration. Wire via `createFrickApnsAdapter()` in `ServerOptions.push.adapters`.
- **FCM v1 push adapter** — `fcm.googleapis.com/v1/projects/{projectId}/messages:send` via `fetch`; service-account JWT exchanged for an OAuth2 access token and cached for `expires_in`. Maps `UNREGISTERED` / `INVALID_ARGUMENT` / `SENDER_ID_MISMATCH` onto revocation codes; preserves quota and server errors with stable codes. Wire via `createFrickFcmAdapter()`.
- **Per-tenant push credentials** — stored in `tenant_settings` wrapped with AES-256-GCM. The encryption key comes from `FRICK_PUSH_CRED_KEY` (base64-encoded 32 bytes); when unset the adapters return a `push.credentials.disabled` skipped-delivery rather than running without encryption.
- **`frick.push.delivery` DevTools events** — every fan-out attempt records intent, platform, status, error code, and receipt id so operators can read back exactly what landed where.
- **Platform event pipeline baseline** — the server now ships a shared event contract, memory and durable SQLite adapters, a KafkaJS Redpanda/Kafka adapter boundary, backup/restore preservation, authenticated health at `/_frick/inspect/platform-events` plus `/_frick/dashboard/api/platform-events/health`, and initial job lifecycle events.
- **Dashboard analytics summary** — mounted Fricken Dashboard now exposes `/_frick/dashboard/api/analytics/summary`, a tenant-scoped read model over retained `analytics.user_event` platform events, and renders product event/route summaries in the dashboard.
- **Dashboard data browser** — mounted Fricken Dashboard now exposes `/_frick/dashboard/api/data/objects/:type`, a read-only schema object listing API that reuses tenant/user visibility rules and renders object rows in the Data view.
- **Dashboard account browser** — mounted Fricken Dashboard now exposes `/_frick/dashboard/api/accounts`, a tenant-scoped sanitized account listing API, and renders account rows in the Auth view with admin tenant selection.
- **Dashboard tenant browser** — mounted Fricken Dashboard now exposes `/_frick/dashboard/api/tenants`, a read-only tenant ledger view that pins tenant sessions to their own tenant and lets admin bearers include archived rows.
- **Dashboard tenant settings summary** — mounted Fricken Dashboard now exposes `/_frick/dashboard/api/tenant-settings`, a sanitized tenant settings read model that shows safe limit/retention values and push credential presence without returning encrypted credential material.
- **Dashboard blob metadata browser** — mounted Fricken Dashboard now exposes `/_frick/dashboard/api/blobs`, a read-only tenant/owner-scoped storage metadata view that renders blob ids, owners, hashes, sizes, MIME types, creation timestamps, and safe derivative summaries without returning blob content bytes, derivative bytes, storage keys, or raw derivative metadata.
- **Dashboard job browser** — mounted Fricken Dashboard now exposes `/_frick/dashboard/api/jobs`, a read-only tenant-scoped background job listing API that renders lifecycle state, attempts, scheduling timestamps, and error codes without returning payloads, completed results, idempotency keys, worker ids, or error messages.
- **Analytics aggregate consumer** — the server now materializes `analytics.user_event` platform events into durable analytics aggregate/recent-event tables via the configured platform-event adapter, so dashboard summaries work with SQLite and Kafka/Redpanda pipelines.
- **Server OpenTelemetry baseline** — `@frick/server` now has a first-class OTel runtime for HTTP request spans, WebSocket connection/frame telemetry with bounded labels and sanitized close attributes, job-run spans, and request/WebSocket/job metrics, controlled by `FRICK_OTEL_*` / standard OTLP env vars. The Redpanda local profile starts a collector and prints the matching server env.
- WebSocket presence subscribe/set/clear frames now run through authz. Foundation `TypingState` enforces known conversation membership and prevents clients from writing another user's typing state.

### CLI (`@frick/cli`)

- New `frick deploy --profile compose|lightweight` command prints or starts
  standard Docker Compose deployment profiles. The compose profile wires the
  server-mounted dashboard, Redpanda/Kafka platform events, and OTel collector;
  the lightweight profile keeps the same server shape with SQLite platform
  events.
- New `frick deploy image` action builds the server image consumed by deploy
  profiles, with `--tag`, `--dockerfile`, `--context`, `--push`, and
  `--dry-run` support while preserving JSON-only stdout.
- New `frick dev` command prints local runtime profiles; `--profile redpanda`
  starts the checked-in Redpanda Compose service and emits the Kafka platform
  event env vars for local conformance testing.
- New `frick tenants set-push` subcommand:
  - `--platform apns --p8 <file> --key-id ... --team-id ... --bundle-id ... [--sandbox]` encrypts and stores APNs credentials.
  - `--platform fcm --service-account <google-svc-account.json>` encrypts and stores FCM service-account credentials.

### Swift SDK (`packages/swift`)

- `FrickSyncSocket.handleDelta` now decodes the wire's `PackedStreamEvent` tuples into named-field `FrickStreamEvent` values via the new `FrickSchemaDescriptor`. Legacy map-shaped event fixtures continue to decode as before.
- New `FrickInboundEvent.objectsDelta(records:cursor:)` case surfaces `PackedObjectRecord` entries from the gateway's `publishObjects` channel as typed `FrickObjectRecord` values. Additive — existing `.delta` consumers are unchanged.
- `FrickSession` now preserves `tenantId`; Swift SQLite cache metadata stores `tenantId` / `userId` and refuses cached hydration or pending replay when the stored scope does not match the current session.

### Android SDK (`apps/android/frick`)

- `FrickSyncSocket` now decodes `PackedObjectRecord` and `PackedStreamEvent` tuples into named-field maps using the generated `FRICK_OBJECT_NAMES` / `FRICK_STREAM_NAMES` / `FRICK_EVENT_NAMES` / `FRICK_OBJECT_FIELDS` / `FRICK_EVENT_FIELDS` tables. Fixes a regression where every WS Delta event was silently dropped because the decoder cast the tuple form as a map. Unknown field ids round-trip as `"#<id>"` keys so a forward-incompatible schema bump degrades gracefully rather than dropping fields.
- `FrickSession` now preserves `tenantId`; Android SQLite cache metadata stores `tenantId` / `userId` and refuses cached hydration or pending replay when the stored scope does not match the current session.

### Repository

- Added standard self-hosted Compose profiles at `ops/deploy/compose.yaml` and
  `ops/deploy/lightweight.compose.yaml` for production-shaped and lightweight
  Frick runtime deployments without copying platform code into app source
  trees.
- Added `ops/deploy/server.Dockerfile` and a root `.dockerignore` for building
  the canonical Node 24 Frick server image with mounted dashboard assets.
- Added Redpanda local infrastructure at `ops/local/redpanda.compose.yaml`
  for testing the Kafka-compatible platform event pipeline without generating
  infrastructure into app source trees.
- Added the first Frick Platform runtime boundary: project modules can supply
  schema/manifest metadata, and the server can mount authenticated Fricken
  Dashboard routes plus project/schema metadata at `/_frick/dashboard`.
- Added `@frick/agent-kit`, a publishable agent compatibility pack with a
  `frick-agent-kit install` CLI, Codex/Claude/Cursor plugin surfaces, Frick
  skills, subagent profiles, Cursor rules, and a shared app spine template for
  agent-assisted fullstack app builds.
- Added `@frick/mcp` and `frick mcp`, a CLI-owned stdio MCP runtime that lets
  agents inspect documented Frick health, readiness, schema, inspection, stream,
  jobs, and structured-error surfaces. It defaults to read-only mode, with write
  tools gated behind `--allow-writes`.
- Added `frick dashboard`, which serves Fricken Dashboard: a static
  Firebase-style local console under `apps/dev-dashboard` for inspecting
  health, readiness, schema identity, metrics, jobs, migrations, and DevTools
  events against any running Frick server.
- npm publishing is now tag-driven through a pinned-action GitHub Actions workflow that accepts only `framework-v*` tags on `main`, uses npm trusted publishing with OIDC provenance, and publishes the public TypeScript packages from packed `dist` entrypoints.
- `pnpm release:dry-run` now fails publishable packages that expose TypeScript source entrypoints or point manifest fields at files missing from the packed tarball.
- Root `pnpm test`, `pnpm server`, `pnpm web`, and `pnpm cli` build public package entrypoints first so fresh checkouts work with the npm-style `dist` exports.
- `pnpm verify:generated` now regenerates and checks schema DTOs, protocol fixtures, and tracked design-token outputs; the Android publish workflow runs that drift gate plus Android tests/lint/debug builds before publishing to GitHub Packages.
- Apache License 2.0 (`LICENSE`).
- `.gitignore` now excludes `*.p8`, `*.pem`, `*-service-account.json`, and `.env*` so credential files can't be committed by accident.

## 0.1.0 - 2026-05-11

First public scaffolding pass. Establishes the wire contract, server, native clients, demo apps, CLI, and operational documentation. All framework packages start at `0.1.0` after this entry.

### Protocol

- Frame kinds: `hello`, `hello-ack`, `subscribe`, `unsubscribe`, `append`, `signal`, `object-upsert`, `projection-delta`, plus heartbeat and error envelopes.
- `schemaRevision: 1` baseline with capability negotiation in the hello handshake.
- Shared `FrickErrorEnvelope` over HTTP and WebSocket paths.
- Native schema artifact generator emits Swift and Kotlin constants from the TS source of truth.
- Baseline fixtures plus a drift check (`pnpm verify:generated`) guard the generated outputs.
- Schema linter module surfaces shape violations for app authors.

### Server (`@frick/server`)

- Migration runner with checksum-pinned `frick_migrations` table; refuses to boot on drift or unknown future revisions.
- Sync gateway with hello handshake, capability negotiation, frame-size caps, per-tenant limits, heartbeat, presence TTL, and bounded subscription/pending-append queues.
- Multi-tenant isolation threaded through every storage method, request path, and admin route.
- Authorization decisions with typed reason codes; deny-by-default for unknown actions; tenant-scope checks on writes; conversation-membership and blob-ownership enforcement.
- Object versioning with `versionPrecondition` enforcement and `ObjectUpsert` conflict envelopes over the sync socket.
- Typed projection registry with delta broadcasting; conversation inbox re-expressed as a projection.
- Job worker with backoff, dead-letter queue, lifecycle inspect routes, and admin trigger endpoint.
- Push notification router as a job handler with device registrations and admin delivery.
- SQLite FTS5 search adapter wired into store writes with an admin rebuild route.
- Blob derivative storage, synchronous upload validators, and a `blob.process` job handler.
- Backup and restore: NDJSON dump generator with schema-tagged header; restore reader refuses schema drift.
- Per-tenant settings store with admin routes; HTTP and WS paths resolve limits per request.
- DevTools event store with retention pruning; emits events on HTTP, WS, and job lifecycle.
- Compliance: data-subject export and erase endpoints, hash-chained admin audit log with `verifyChain`.
- App registry and hello-driven app routing; `/_frick/inspect/apps` and admin schema-lint route.
- Operational surface: graceful shutdown with in-flight tracking, health/ready/inspect routes, structured logger with redaction defaults, child loggers, per-request log lines, metrics module, idempotency cache with retention and row caps, CORS enforcement, admin bearer auth.

### Swift (`Frick`, `FrickDesign`)

- `FrickSyncSocket` WebSocket transport with hello handshake, append/subscribe/object-upsert send paths, and reconnect handling.
- `FrickClient.connectSync` entry point.
- Shared error envelope parsing over HTTP responses.
- Cache schema compatibility enforced on load.
- Protocol fixture decode tests against generated constants.

### Android (`dev.frick:frick`, `dev.frick:design`)

- `FrickSyncSocket` WebSocket transport scaffolding, hello handshake, status flow, append/subscribe/object-upsert send paths.
- Inbound delta and projection-delta handling.
- Reconnect with backoff plus pending append flush.
- Shared error envelope parsing.
- Cache schema compatibility enforced on load.
- Protocol fixture decode tests against generated constants.
- `mockwebserver3` based sync socket tests.

### Web (`@frick/core`, `@frick/react`, `@frick/web`)

- `@frick/core` runtime with bounded pending append queue, reconnect backoff, projection-delta receive path, `upsertObject` with conflict typing, and cache schema compatibility.
- `@frick/react` `useProjection` hook.
- Web demo wired to the runtime contract.

### CLI (`@frick/cli`)

- Commands: `init`, `schema`, `migrate`, `doctor`, `inspect`, `reset`, `tenants`, `verify`, `lint`, `backup`, `restore`, plus object/stream/projection scaffolders.
- Templates module backing `init` and the scaffolders.

### Docs

- Framework boundaries, threat model, operations runbook, cross-platform client contract.
- App authoring guide, server operations notes (idempotency cache, frame-size cap, per-request logging, metrics snapshot, backup and restore, tenant boundary, CORS).
- Framework hardening spec and plan.
- Versioning policy and release runbook (this round).

### Deprecated

- _None._

### Removed

- _None._

### Security

- Admin routes gated behind `FRICK_ADMIN_TOKEN`.
- Logger redacts secrets by default; CORS enforced on HTTP and WS; deny-by-default authorization; tenant isolation tests across object/stream/blob/inbox paths.
