# frick-conformance

Black-box conformance scenario runner (**FR-250**) — the acceptance gate for
the Frick Rust rewrite.

A language-neutral suite of black-box scenarios that exercise an **arbitrary**
Frick server (the TypeScript server **or** the Rust server) over HTTP +
WebSocket and assert identical *observable* behavior: HTTP status codes, JSON
response shapes, and the msgpack frame flow over the `/_frick/sync` WebSocket.

This crate covers the **scenario** half of conformance. The **wire-protocol**
half — byte-exact frame/schema fixtures — already lives under
`conformance/fixtures/wire/` and is pinned by the protocol crate's own tests.

## What it asserts

Each scenario in `tests/scenarios.rs` is a `#[tokio::test]` that drives
`ServerHandle::target()`, so the whole suite runs against whichever server the
`FRICK_CONFORMANCE_URL` env var points at:

| Area | Scenario |
|---|---|
| lifecycle | `GET /health` → `{ok:true}`; `GET /ready` → `status:"ready"` + `schemaHash`; `GET /schema` → the active schema |
| auth | `POST /auth/dev-login` shape + a usable bearer; unauthenticated `GET /objects` → 401 `auth.unauthenticated`; `POST /auth/signup` → 201; `POST /auth/login` wrong password → 401 |
| objects | `GET/PUT/DELETE /objects/User/<id>` round-trip (version + ETag, row appears, `existed:true`) |
| streams | `POST /append` → 200 `{ok,event}`; `GET /streams/...?after=0` returns it; idempotent re-append by `requestId` |
| signals | `POST /signals/WebRTCSignal/<key>` then `GET` drains it back |
| WS sync (headline) | dev-login → Hello → HelloAck + Schema → Subscribe stream → StreamPage → HTTP append → **Delta over the socket** |
| WS handshake gate | Subscribe before Hello → Nack `sync.protocolError` reason `handshakeRequired`; Ping pre-Hello → Pong |
| WS object subscribe | Subscribe object `User` → initial `Snapshot` |
| projection subscribe | Subscribe projection `ConversationInbox` → initial `ProjectionDelta` (or `projectionNotFound` Nack if unregistered) |

Both server implementations must produce these identically. Assertions stay on
observable behavior, never internal details.

## Running

### Against the in-process Rust server (default)

```sh
cargo test -p frick-conformance
```

With no `FRICK_CONFORMANCE_URL`, the harness boots an in-process Rust server via
`frick_server::create_frick_server` on port 0 with an in-memory store and
dev-auth on. It runs the `productTestSchema` decoded from the committed wire
fixture `conformance/fixtures/wire/schema-product-validated.bin`, and registers
a `ConversationInbox` projection (a real product app does the same — the
framework does not auto-register declared projections).

### Against a running TypeScript server (cross-impl parity)

```sh
FRICK_CONFORMANCE_URL=http://127.0.0.1:4099 cargo test -p frick-conformance
```

The external server **must** be booted with the **same** `productTestSchema`,
or the Hello handshake (and every packed record on the wire) will mismatch. The
default `pnpm server` boots the *empty foundation* schema, so it will **not**
work for the parity run. Start a server with the product test schema instead —
the e2e-smoke harness (`scripts/e2e-smoke.ts`, `pnpm e2e:smoke`) is the
canonical boot, or a one-file recipe:

```ts
// conformance-server.ts (run with: npx tsx conformance-server.ts)
import { createFrickServer } from "./apps/server/src/server.js";
import { productTestSchema } from "./packages/protocol/src/fixtures/product-test-schema.js";

const app = createFrickServer({
  port: 4099,
  dbPath: ":memory:",
  config: { env: "development" },
  schema: productTestSchema,
});
await app.listen();
console.log(`product-test server on http://127.0.0.1:${app.port}`);
```

Then point the suite at it:

```sh
npx tsx conformance-server.ts &
FRICK_CONFORMANCE_URL=http://127.0.0.1:4099 cargo test -p frick-conformance
```

## Library API

`src/lib.rs` is a reusable harness:

- `ServerHandle::target()` — pick external (env) vs in-process Rust server.
- `ServerHandle::http()` / `::connect_ws()` — HTTP and WebSocket clients bound
  to the target.
- `HttpClient` — `get`/`post`/`put`/`delete`, plus `dev_login` /
  `dev_login_token` helpers returning a session token.
- `WsConn` — `send`/`next_frame` (skips the gateway's heartbeat `Ping`s),
  `hello` (Hello → HelloAck + Schema), `subscribe`, `ping`.
- `product_test_schema()` — the schema both servers must run.
- `nonce()` — a unique per-call suffix so reused external servers don't trip
  the dev-login global-handle uniqueness gotcha.
