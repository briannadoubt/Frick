# App Authoring

This guide is for developers building a Frick application. If you instead need
to operate an existing app, see [operations.md](./operations.md).

The Frick CLI ships a `frick init` and `frick scaffold` set of commands so a
developer can go from zero to a running app in two commands:

```
frick init my-app
cd my-app && pnpm dev
```

For agent-assisted app builds, ask `init` to install the Frick Agent Kit and
emit an MCP config in one step:

```
frick init my-app --agents all --mcp
```

You can also install or refresh the kit later:

```
pnpm dlx @frick/agent-kit install --all --target .
```

The kit adds Codex, Claude Code, and Cursor skills/subagents, Cursor rules,
and `docs/frick/spine.md`, a shared contract that backend and platform agents
read before splitting work.

When an agent needs live runtime context from the app it is building, start the
CLI-owned MCP server:

```
frick mcp --endpoint http://127.0.0.1:4099
```

Use `frick mcp --print-config` to emit a machine-readable stdio config for
agent harnesses. The MCP server is read-only by default.

## Getting Started

`frick init <directory>` scaffolds a new Frick application at the given path.

```
frick init my-app --port 4099 --name my-app --version 0.1.0
```

Flags:

| Flag                  | Default              | Notes                                                                 |
| --------------------- | -------------------- | --------------------------------------------------------------------- |
| `--name <name>`       | basename of `<dir>`  | Lands in `package.json#name` and the schema's `name` / `schemaId`.    |
| `--port <port>`       | `4099`               | Default port the scaffolded server listens on.                        |
| `--version <ver>`     | `0.1.0`              | Used for the app version and the scaffolded schema's `schemaVersion`. |
| `--no-install`        | install runs by default | Skip `pnpm install`. Useful for tests and CI prep.                 |
| `--skip-schema-check` | check runs           | Skip the in-process schema validation that runs after scaffolding.    |
| `--agents <value>`    | unset                | Install Frick Agent Kit surfaces. Use `all`, `none`, or a comma-separated subset of `codex,claude,cursor`. |
| `--mcp`               | unset                | Include read-only `frick mcp` stdio config in the final JSON output. |

`init` refuses to overwrite an existing file in the target directory — it is
strictly for fresh scaffolds, not migration. After files are written, unless
`--no-install` was passed, the CLI shells out to `pnpm install`, and unless
`--skip-schema-check` was passed it then runs an in-process
`frick schema check` against the scaffolded schema's identity fields. The
final JSON record summarizes which files were created and the result of both
follow-up steps.

## Expected directory structure

```
my-app/
├── package.json          # name, version, scripts, @frick/* dependencies
├── tsconfig.json         # standard strict TS config, ESNext modules
├── frick.config.json     # optional, overrides FRICK_* env vars
├── src/
│   ├── schema.ts         # exports `schema: FrickSchema`
│   └── server.ts         # imports schema, calls createFrickServer({ schema, port })
└── tests/
    └── smoke.test.ts     # boots the server in-process, asserts /health returns 200
```

`src/schema.ts` contains marker comments (`// frick:objects`,
`// frick:streams`) and `src/server.ts` contains marker comments
(`// frick:projections:imports`, `// frick:projections:register`). The
scaffold commands locate these markers when appending new declarations —
don't delete the markers or scaffold will refuse to extend the file.

## How the scaffolded server connects to the framework

The scaffolded `src/server.ts` is a thin module that imports `createFrickServer`
from `@frick/server` and passes it the schema you author in `src/schema.ts`.
Everything else — HTTP routes, the SQLite store, the sync gateway, the
projection registry, the auth surface — is owned by the framework. That keeps
the app source narrow: the developer's job is to declare schema objects and
streams (and optionally a projection or two), and the framework wires the rest.
Read the boundaries doc at [framework-boundaries.md](./framework-boundaries.md)
for the full ownership map.

Apps can still add narrow server behavior through documented
`createFrickServer` options instead of deep-importing route or storage
internals:

- `appRoutes` mounts app-owned HTTP handlers before Frick's built-in routes.
  Use it for REST endpoints, OAuth callbacks, and webhooks that belong to the
  product rather than the sync framework. Routes run in declaration order and
  return `true` when they handled a request or `false` to fall through.
- `jobs.handlers` registers durable background job handlers by job type. The
  worker claims rows from the framework job store, retries retryable failures,
  and emits lifecycle telemetry.
- `recurring.jobs` re-enqueues registered job types on a time-window schedule
  without a separate cron process. Each recurring spec resolves one or more
  `(tenantId, payload)` targets and Frick applies an idempotency key per tenant
  and window.

```ts
import { createFrickServer } from "@frick/server";
import { schema } from "./schema.js";

export const server = createFrickServer({
  schema,
  appRoutes: [
    {
      pathPrefix: "/webhooks/payments",
      method: "POST",
      async handle(req, res) {
        // Verify the webhook signature before enqueueing app work.
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return true;
      },
    },
  ],
  jobs: {
    handlers: {
      "reports.recompute": async ({ payload }) => {
        const input = payload as { reportId?: string };
        return { status: "completed", result: { reportId: input.reportId } };
      },
    },
  },
  recurring: {
    jobs: [
      {
        name: "reports.hourly-recompute",
        jobType: "reports.recompute",
        intervalMs: 60 * 60 * 1000,
        resolveTargets: () => [{ tenantId: "_default", payload: {} }],
      },
    ],
  },
});
```

Keep these handlers small and framework-facing. If a handler needs product
tables, service credentials, or third-party SDK clients, initialize those in
app code and pass only the documented Frick primitives into the framework.

## Next steps

Once you have an app skeleton, grow it with the `scaffold` family:

- `frick scaffold object <Name>` — append a PascalCase object type stub to
  `src/schema.ts`. Idempotent — refuses to add a duplicate.
- `frick scaffold stream <Name>` — same, but for streams.
- `frick scaffold projection <name>` — kebab-case projection name; creates a
  new file under `src/projections/<name>.ts` and wires it into `src/server.ts`
  via the projection markers.

Search indexes registered through `createFrickServer({ search: { indexes } })`
are indexed by the framework, but query access is conservative. App-provided
indexes over objects, streams, or projections require an explicit `policyHooks`
allow for the `search.query` action before tenant users can query them; admin
principals can still query for inspection and operations.

## Product analytics

The TypeScript, Swift, and Android/Kotlin client SDKs can send product
analytics without adding app-local routes or tables. Events are authenticated
with the current Frick session and land in the server's platform event
pipeline as `analytics.user_event`.

```ts
await client.track("button.clicked", { label: "Save" }, {
  idempotencyKey: "click-save-123",
  traceId: "trace-abc",
});
```

Native clients use the same route and receipt shape:

```swift
try await client.track(
    "button.clicked",
    properties: ["label": .string("Save")],
    options: FrickAnalyticsTrackOptions(idempotencyKey: "click-save-123")
)
```

```kotlin
client.track(
    name = "button.clicked",
    properties = mapOf("label" to JsonPrimitive("Save")),
    idempotencyKey = "click-save-123",
)
```

React apps can use the matching hook:

```tsx
const track = useTrackAnalyticsEvent();
await track("screen.viewed", { screen: "Settings" });
```

For browser route/screen analytics, `<FrickProvider>` installs a small tracker
by default after a session is available. It records the initial route and
subsequent `history.pushState`, `history.replaceState`, and `popstate` route
changes. The default route payload includes only `path` and document `title`;
query strings, hash fragments, and full URLs are not sent unless you opt in
through `routeProperties`.

```tsx
<FrickProvider session={session}>
  <App />
</FrickProvider>
```

Fricken Dashboard reads those accepted events through
`/_frick/inspect/analytics/summary` in standalone local mode and
`/_frick/dashboard/api/analytics/summary` in mounted mode. Both surfaces show
tenant-scoped product event counts plus route activity without requiring
app-local analytics tables. The server materializes the summary through its
built-in platform-event consumer, so apps keep one analytics ingestion path
whether local development uses SQLite or production uses Kafka/Redpanda.

Pass `autoAnalytics={false}` to opt out, or pass an options object to customize
the browser source, event name, route properties, or error handler. Include
query strings or hashes only when they are known not to contain secrets:

```tsx
<FrickProvider
  session={session}
  autoAnalytics={{
    screenName: () => "screen.viewed",
    routeProperties: (location) => ({ path: location.pathname }),
  }}
>
  <App />
</FrickProvider>
```

The server owns tenant/user/device identity from the session. App code supplies
the event `name`, optional `properties`, optional `context`, optional primitive
`attributes`, optional `traceId`, optional `idempotencyKey`, and optional
canonical ISO `occurredAt`. Use idempotency keys for events that may be retried
after navigation or network loss.

## Background jobs

Job payloads belong in the schema's `jobs[]` array so generated contracts and
compatibility checks know about them. Server code registers handlers with
`createFrickServer({ jobs: { handlers } })`; the framework owns storage,
claiming, retries, dead-lettering, and lifecycle events.

Recurring work is configured separately from handlers. Use
`createFrickServer({ recurring: { jobs } })` when a task should be enqueued
once per time window, per tenant target, without external cron. The minimum
interval is 60 seconds. `resolveTargets` should be deterministic and cheap:
look up tenants or integration rows, return payloads, and let the job handler
do slow network or compute work.

Inspect local job state with `frick inspect jobs`, the mounted dashboard Jobs
view, or `/_frick/inspect/jobs` when inspection is enabled.

## Identity providers

Apps can opt into Frick-managed identity routes by passing
`identityProviders` to `createFrickServer`. Frick verifies provider
credentials, creates or finds the app-owned User object, mints a normal Frick
session, and, for Apple, handles server-to-server notifications.

```ts
createFrickServer({
  schema,
  identityProviders: {
    apple: { audience: "com.example.myapp" },
    google: { clientId: "123.apps.googleusercontent.com" },
    oidc: [
      {
        id: "okta",
        issuer: "https://example.okta.com",
        clientId: "0oaExampleClientId",
        discovery: true, // or: jwksUri: "https://example.okta.com/oauth2/v1/keys"
        claimMappings: { extra: { department: "dept" } },
      },
    ],
    email: {
      minPasswordLength: 12,
      onPasswordResetRequested: async ({ email, tenantId, token }) => {
        const resetUrl = `https://app.example/reset-password?token=${token}`;
        await appMailer.sendPasswordReset({ tenantId, to: email, resetUrl });
      },
    },
    userObject: {
      type: "User",
      appleSubjectField: "appleSubject",
      googleSubjectField: "googleSubject",
      oidcSubjectField: "oidcSubject",
      emailField: "email",
      primaryTenantField: "primaryTenantId",
    },
    onFirstSignIn: async ({ email, subject }) => ({
      tenantId: "_default",
      displayName: email?.split("@")[0] ?? subject,
    }),
  },
});
```

Supported routes:

- `POST /auth/apple/verify` accepts `{ identityToken, fullName?, deviceId?,
  replicaId? }` and returns `{ session, user, isNewUser }`.
- `POST /auth/apple/notifications` accepts Apple's `{ payload }` notification
  JWT; email updates patch the mapped User object, and consent
  revocation/account delete marks the user revoked and deletes active sessions.
- `POST /auth/google/verify` accepts `{ idToken, deviceId?, replicaId? }`,
  verifies the Google ID token against the configured OAuth client id, and
  returns the same `{ session, user, isNewUser }` shape.
- `POST /auth/oidc/:providerId/verify` accepts `{ idToken, nonce?, deviceId?,
  replicaId? }` for a provider declared in `identityProviders.oidc`, verifies
  the OIDC ID token against the provider's JWKS (resolved from `jwksUri` or the
  issuer's discovery document), checks `iss`/`aud`/expiry (and `nonce` when
  supplied), maps standard + `claimMappings` claims into the User object, and
  returns the same `{ session, user, isNewUser }` shape. The verified `sub` is
  stored as `"<providerId>:<sub>"` on the configured `oidcSubjectField`.
- `POST /auth/email/signup` accepts `{ email, password, displayName? }`,
  creates the mapped User row plus a password account, and mints a session.
- `POST /auth/email/login` accepts `{ email, password }`, avoids email
  enumeration by returning `invalid_credentials` for unknown emails and bad
  passwords, and mints a session for valid credentials.
- `POST /auth/email/forgot-password` accepts `{ email }`, always returns
  `{ ok: true }`, and calls `email.onPasswordResetRequested` only when the
  address exists. The hook receives the raw single-use reset token so app code
  can compose its own reset URL and dispatch email.
- `POST /auth/email/reset-password` accepts `{ token, password }`, enforces
  `minPasswordLength`, consumes the reset token, changes the password, and
  deletes active sessions for that user.

The `session` shape is the same session object used by the TypeScript, Swift,
and Android clients. The app still owns its User schema, tenant membership
model, and any first-sign-in side effects through the mapping and hooks above.
Email reset tokens are stored hashed at rest and expire after 60 minutes.
Generic OpenID Connect issuers are supported via `identityProviders.oidc`;
SAML and arbitrary non-OIDC OAuth provider routing are not implemented.

## Client telemetry

The TypeScript runtime emits OpenTelemetry-compatible client spans and metrics
without generated app code. `FrickClient` defaults to the OpenTelemetry API
bridge from `@frick/core`; if the host app installs a browser OTel provider,
Frick sync and analytics operations show up automatically. Without a provider,
the bridge is a no-op.

```ts
import { FrickClient, createOpenTelemetryClientRuntime } from "@frick/core";

const client = new FrickClient({
  endpoint: "wss://api.example.com/_frick/sync",
  telemetry: createOpenTelemetryClientRuntime(),
});
```

The standalone `trackAnalyticsEvent(...)` helper uses the same default bridge.
Pass `telemetry: false` to `FrickClient` to disable framework client telemetry,
or pass a custom `FrickClientTelemetryRuntime` to route spans and metrics into
another collector adapter. For standalone helpers, either pass `telemetry` on
the call or install a process-wide default with
`setDefaultClientTelemetryRuntime(...)`. Telemetry failures are isolated from
sync, writes, and analytics requests.

Swift and Android/Kotlin expose the same dependency-light
`FrickClientTelemetryRuntime` hook for analytics `track` calls. The native SDKs
do not bundle or initialize native OpenTelemetry SDKs; apps can bridge the hook
to their telemetry provider. Native sync socket telemetry is still separate
follow-up work. Android custom transports can opt into `traceparent`
forwarding by overriding the header-aware `post(path, body, headers)` overload;
the original `post(path, body)` implementation remains valid.

The built-in instrumentation covers:

- analytics posts: `frick.analytics.track` spans,
  `frick.client.analytics.events.total{status}`, and
  `frick.client.analytics.duration_ms{status}`. When app code does not supply
  `traceId`, the active telemetry span trace id is copied into the
  `analytics.user_event` payload for dashboard/server correlation. Telemetry
  runtimes may also inject W3C `traceparent`; default no-op native runtimes do
  not inject headers.
- sync WebSocket transport: `WebSocket /_frick/sync` client spans,
  `frick.client.ws.frames.sent.total{kind}`,
  `frick.client.ws.frames.received.total{kind}`, and
  `frick.client.ws.connection.duration_ms{closeCategory}` in TypeScript.

Frame `kind` labels are bounded to known protocol names or `unknown`; close
telemetry records close code/category and never raw close text. The default
bridge injects only the W3C `traceparent` header for analytics POST
correlation; it does not forward OTel baggage.

For schema evolution and the migration story, see
[operations.md](./operations.md#backup-and-restore) and the framework
hardening spec in `internal/`.

## Templates evolution

The templates are inlined as TypeScript modules under
`apps/cli/src/templates/` and are versioned with the framework — running
`frick init` always produces a layout compatible with the current
`@frick/server` cut. We do not promise forward compatibility with older
`@frick/*` releases. To upgrade an existing scaffold, bump the dependency
pins in your app's `package.json` and re-run `frick schema check` to catch
any drift; we do not currently ship an automatic re-scaffold path.
