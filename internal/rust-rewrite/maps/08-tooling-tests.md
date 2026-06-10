# Map 08 — Tooling & Tests (CLI, MCP, agent-kit, rangercrm-server, test landscape)

> Part of the Rust-rewrite specification series. All paths relative to `/Users/bri/dev/Frick`.
> Scope: (a) `apps/cli` commands/flags/behaviors, (b) `packages/mcp` + `packages/agent-kit` tool surface, (c) `apps/rangercrm-server` end-to-end, (d) test landscape (server-boot patterns, golden wire fixtures, SDK suites and server-URL injection points).

---

## 1. `apps/cli` — the `frick` operational CLI

Package: `@fricken/cli`, bin name `frick` → `./dist/index.js` (`apps/cli/package.json`). Depends on
`@fricken/agent-kit`, `@fricken/mcp`, `@fricken/protocol`, `@fricken/server` (all `workspace:*`).
Build runs `tsc -b && node scripts/copy-dashboard-assets.mjs` (dashboard assets are copied next to dist).

### 1.1 Global I/O contract (`apps/cli/src/index.ts`, `output.ts`, `errors.ts`)

- Output is **JSON Lines by default**: every command emits exactly one (or a small fixed number of) JSON record(s) on stdout (`src/index.ts:6-9`).
- `--pretty` or `--json=pretty` switches to 2-space-indented JSON (`src/output.ts:21-26`). There is **no** human-only output mode.
- Errors go to **stderr** as a single JSON object `{ "error": { "code", "message", "details?" } }` (`src/output.ts:34-42`).
- Exit codes (`src/errors.ts:11-14`):
  - `0` = ok (`EXIT_OK`)
  - `1` = a check failed (`EXIT_FAILURE`)
  - `2` = usage error (`EXIT_USAGE`, error code `"cli.usage"`)
  - `3` = framework refused (`EXIT_REFUSED`, error code `"cli.refused"`) — e.g. `reset` outside development, prod `migrate up` without `--confirm-prod`.
- Unknown command → stderr `{error:{code:"cli.unknown_command", message:"Unknown command: X", details:{available:[...]}}}`, exit 2 (`src/index.ts:104-114`).
- Non-CLI `Error`s map to `{code: error.name || "cli.error", message, exitCode: 1}` (`src/errors.ts:62-73`).
- Top-level help: no command, `--help` flag, or literal `help` command emits `{ commands: [...] }` listing all 16 commands with summaries and subcommands (`src/index.ts:58-63`, table at `src/index.ts:21-42`). NOTE: the file comment mentions `-h` but the parser treats `-h` as a positional (only `--`-prefixed tokens are flags), so `frick -h` actually hits the unknown-command path — `-h` is **not** supported despite the comment (`index.ts:58-60`, `argv.ts:27`).
- Entry-point guard: only runs `process.exit(...)` when `process.argv[1]` ends with `/index.ts`, `/index.js`, or `frick` (`src/index.ts:131-146`) — allows importing `run()` from tests.

### 1.2 Argv grammar (`apps/cli/src/argv.ts:22-48`)

Hand-rolled parser; no flag schema:
- `--flag` → `true`; `--flag=value` → `"value"`; `--flag value` → `"value"` only if value doesn't start with `--`; anything else is a positional.
- `requireBoolean` treats string values `"false"`, `"0"`, `"no"` as false; any other string truthy (`argv.ts:57-64`).
- No single-dash short flags at all (anything not starting with `--` is a positional).
- After the command name, the remaining argv is **re-parsed** so each handler sees its own subcommand at `positionals[0]` (`index.ts:65-68`).

### 1.3 Shared context flags (`apps/cli/src/context.ts`)

- `--db-path <path>` and `--env <development|test|production>` map to `loadFrickConfig` overrides; invalid `--env` values are silently ignored (`context.ts:16-24`).
- Config precedence: CLI flags > env vars > defaults; never writes `process.env` (`context.ts:26-36`).
- `openStore` always opens `FrickStore` with **`seed: false`** and `idempotencyKeyPruneIntervalMs: 0` — CLI must never mutate a DB it reads (`context.ts:38-52`).

### 1.4 Commands

#### `frick schema check|generate` (`src/commands/schema.ts`)
- `check`: `validateSchema(foundationSchema)` from `@fricken/protocol`; emits `{ok:true, schemaId, schemaVersion, schemaRevision, schemaHash}` (note key `schemaHash` ← `validated.hash`) (`schema.ts:20-40`). Failure → `CliFailureError("schema.invalid", ...)`, exit 1.
- `generate`: spawns `pnpm schema:generate` with `stdio:"inherit"`, then emits `{ok, command:"pnpm schema:generate", exitCode}` (`schema.ts:42-51`).
- Unknown subcommand → usage error with `expected:["check","generate"]`.

#### `frick lint [--against <prev-schema.json>]` (`src/commands/lint.ts`)
- No `--against`: `lintSchema(foundationSchema)`; each finding emitted as its own JSON line, then summary `{ok, findings, breaking}` (`lint.ts:55-66`). Exit 1 iff `breakingCount > 0`.
- With `--against <path>`: reads previous schema JSON from disk, `lintSchemaChange(current, previous)`. Unreadable file → `CliFailureError("lint.previous_unreadable", ...)`.

#### `frick migrate status|up` (`src/commands/migrate.ts`)
- Opens raw `node:sqlite` `DatabaseSync` (creating parent dirs unless `:memory:`) (`migrate.ts:28-33`).
- `status`: emits `{dbPath, env, applied:[{id,schemaRevision,appliedAt,checksum,durationMs}], pending:[{id,schemaRevision,description}]}` (`migrate.ts:35-65`).
- `up`: **refuses (exit 3)** when `config.env === "production"` and `--confirm-prod` not passed (`migrate.ts:69-74`). Runs `runFrameworkMigrations(db, {supportedSchemaRevision: foundationSchema.schemaRevision})`; emits `{dbPath, env, applied:[...], alreadyApplied:[ids]}`.

#### `frick doctor` (`src/commands/doctor.ts`)
- Composite check, one JSON record: `{ok, env, schema, db, migrations, config}`; each sub-check is `{ok, detail?, error?}` (`doctor.ts:114-126`). Exit 0 only if all four green.
- config detail: `{env, dbPath, demoAuthEnabled, inspectionEnabled, adminEnabled}` (`doctor.ts:39-45`).
- schema detail: `{schemaId, schemaRevision, schemaHash}`.
- db check opens a raw `DatabaseSync` and runs `SELECT 1 AS ok` — deliberately **not** `openStore()` so a missing DB file is a failure, not a side-effecting init (`doctor.ts:70-81`).
- migrations check recomputes `computeMigrationChecksum(migration)` per applied migration and reports `drift:[{id, recorded, current}]`; any drift → `ok:false`, `error:"checksum_drift:<n>"` (`doctor.ts:83-109`).

#### `frick inspect server|db|jobs|diagnostics` (`src/commands/inspect.ts`)
- Mirrors `/_frick/inspect/*` HTTP routes but driven from the **local DB directly** — no HTTP (`inspect.ts:1-10`). Shapes intentionally match `server.ts` inspection handlers so operators can diff CLI vs server output.
- `server`: `{schemaId, schemaVersion, schemaRevision, schemaHash, env, demoAuthEnabled, inspectionEnabled, dbPath}` (`inspect.ts:29-50`).
- `db`: `{ready, applied, lastApplied?{id,schemaRevision,appliedAt}, idempotencyCache:{size,capacity,evictions}, idempotencyKeyRows}` (`inspect.ts:52-84`).
- `jobs`: duck-types `store.jobs.countsByStatus` — if absent emits `{available:false, reason:"jobs framework not detected"}` and still **exits 0** (`inspect.ts:120-139`). Surprising: jobs operator surface not fully wired.
- `diagnostics`: assembles full FR-76/FR-77 diagnostics snapshot via `assembleDiagnosticsSnapshot(store, {env, cursors})`. Extra positionals after `diagnostics` are cursor probes in `stream:streamId` form; `--tenant-id` applies to all probes (`inspect.ts:92-118`). Bad probe → usage error.

#### `frick reset --dev` (`src/commands/reset.ts`)
- Requires `--dev` flag (else `cli.refused`, exit 3) AND `config.env === "development"` (`reset.ts:14-25`).
- Probes each `FRAMEWORK_TABLES` entry with `SELECT 1 FROM <table> LIMIT 1` to build `tablesDropped` report, then calls `resetFrickDatabase({db: path, env:"development", confirmDevReset:true})` (`reset.ts:30-52`). Emits `{ok:true, dbPath, env, tablesDropped}`.

#### `frick tenants list|create|set-push` (`src/commands/tenants.ts`)
- `list [--include-archived]`: emits `{tenants: rows}` from `store.tenants.list(includeArchived)`.
- `create <id> [--display-name <name>]`: `store.tenants.create(...)`; duplicate → `CliFailureError("tenants.exists", ...)` (`tenants.ts:147-167`).
- `set-push <id> --platform apns|fcm|webpush` — **push-credential management** (`tenants.ts:55-145`). Credentials are wrapped (encrypted) with `FRICK_PUSH_CRED_KEY` and stored in `tenant_settings` (file header `tenants.ts:4-9`):
  - `apns`: `--p8 <file> --key-id --team-id --bundle-id [--sandbox]` → `saveApnsCredentials(store.tenantSettings, tenantId, {keyId, teamId, bundleId, privateKeyPem, useSandbox})`. Emits `{ok:true, tenantId, platform:"apns"}`.
  - `fcm`: `--service-account <file>` (JSON must contain `project_id`, `client_email`, `private_key`; optional `token_uri`). Invalid JSON → `tenants.setPush.invalidServiceAccount`. Calls `saveFcmCredentials` with camelCase keys.
  - `webpush`: `--subject <mailto:|https://...> --public-key <b64url> --private-key <pem-file>`. Subject not starting with `mailto:` or `https://` → `tenants.setPush.invalidVapidSubject`. Calls `saveWebPushCredentials({subject, publicKey, privateKey})`.
  - Unsupported platform → usage error with `expected:["apns","fcm","webpush"]`.

#### `frick verify` (`src/commands/verify.ts`)
- Spawns `pnpm verify:generated` (regenerates schema + fixtures and asserts no diff vs checked-in artifacts); emits `{ok, command:"pnpm verify:generated", exitCode}`.

#### `frick backup` (`src/commands/backup.ts`)
- `[--tenant-id <id>|all] [--output <path>] [--db-path <path>]`. Default tenant is **`_default`**; `--tenant-id all` means whole DB (`backup.ts:2-8,21`).
- Streams NDJSON lines from `dumpFrickDatabase(store, {tenantId})`. With `--output`: NDJSON to file, summary `{ok, dbPath, tenantId, output, rows}` to stdout. Without: NDJSON to stdout, summary JSON to **stderr** so the dump stream stays clean (`backup.ts:66-72`).

#### `frick restore` (`src/commands/restore.ts`)
- `--input <path>` required; refuses without `--confirm yes` (reason `missingConfirmation`, exit 3).
- Refuses against production config unless env var `FRICK_RESTORE_ALLOW_PROD=1` (`restore.ts:30-35`).
- Flags `--overwrite`, `--force-schema-drift` (booleans). Calls `restoreFrickDatabase({target, source, confirm:"yes", overwrite, forceSchemaDrift})`, emits the report. `FrickRestoreRefusedError` → `CliFailureError("cli.restore.<reason>", ...)` (exit 1, not 3 — surprising asymmetry with backup's refusal model).

#### `frick dev [--profile sqlite|redpanda] [--dry-run]` (`src/commands/dev.ts`)
- Default profile `sqlite`. The sqlite profile **never starts anything** (`started:false` always); plan: env `{FRICK_PLATFORM_EVENTS_DRIVER:"sqlite"}`, steps `["pnpm server","pnpm web","pnpm cli dashboard"]` (`dev.ts:37-53`).
- `redpanda` profile constants (`dev.ts:20-21`): brokers `127.0.0.1:19092`, OTLP `http://127.0.0.1:4318`. Plan env:
  `FRICK_PLATFORM_EVENTS_DRIVER=kafka`, `FRICK_PLATFORM_EVENTS_KAFKA_BROKERS=127.0.0.1:19092`, `FRICK_PLATFORM_EVENTS_TOPIC=frick.platform.events`, `FRICK_OTEL_ENABLED=true`, `FRICK_OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`, `FRICK_OTEL_SERVICE_NAME=frick-server`, `FRICK_TEST_KAFKA_BROKERS=127.0.0.1:19092` (`dev.ts:62-70`).
- `--dry-run` (or sqlite profile) just emits the plan with `started:false`, exit 0. Otherwise spawns `docker compose -f ops/local/redpanda.compose.yaml up -d --wait redpanda otel-collector` (`dev.ts:86-99`), emits `{...plan, ok, started, exitCode}`.
- Compose file path resolved relative to the compiled module: `../../../..` from `dist` = repo root (`dev.ts:101-105`).

#### `frick deploy [image] [--profile compose|lightweight] [--dry-run]` (`src/commands/deploy.ts`)
- Default profile `compose`. Constants: `COMPOSE_BROKERS="redpanda:9092"`, `COMPOSE_OTLP_ENDPOINT="http://otel-collector:4318"`, `DEFAULT_SERVER_IMAGE="frick-server:latest"` (`deploy.ts:36-38`).
- `compose` plan: compose file `ops/deploy/compose.yaml`; env `FRICK_ENV=production, FRICK_HOST=0.0.0.0, FRICK_PORT=4099, FRICK_DB_PATH=/var/lib/frick/frick.sqlite, FRICK_PLATFORM_EVENTS_DRIVER=kafka, ...kafka/otel as above`; services `[frick-server, redpanda, otel-collector]` (`deploy.ts:170-200`).
- `lightweight` plan: `ops/deploy/lightweight.compose.yaml`; sqlite driver, OTel off, single `frick-server` service (`deploy.ts:142-167`).
- `deploy image [--tag <t>] [--dockerfile <f>] [--context <dir>] [--push] [--dry-run]`: defaults dockerfile `ops/deploy/server.Dockerfile`, context = repo root, tag `frick-server:latest`. Non-dry-run: `docker build -f <dockerfile> -t <tag> <context>`, then optional `docker push <tag>` (`deploy.ts:65-94`). Emits `ImageBuildPlan` with `built`/`pushed` booleans.

#### `frick init <directory>` (`src/commands/init.ts`) — scaffolding
- Usage: `frick init <directory> [--name <name>] [--port <port>] [--version <ver>] [--no-install] [--agents all|codex,claude,cursor] [--mcp]` (`init.ts:54-57`).
- Defaults: `appName` = basename of resolved dir; `port` = **4099**; `version` = **"0.1.0"**; install = true (`init.ts:59-88`). `--no-install` or `--install=false` skips `pnpm install`. `--skip-schema-check` skips the in-process schema check.
- Refuses (exit 3) to overwrite any existing file (`writeFileFresh`, `init.ts:107-114`).
- Files written (exact set, `init.ts:173-178`): `package.json`, `tsconfig.json`, `frick.config.json`, `src/schema.ts`, `src/server.ts`, `tests/smoke.test.ts`.
- `--agents` accepts `all` (or bare `--agents`) = `["codex","claude","cursor"]`, `none`/`false` = none, or comma list of those three (`init.ts:91-105`); installs agent-kit via `installAgentKit({targetDir, harnesses})`.
- `--mcp` adds `mcp: createMcpClientConfig({endpoint: "http://127.0.0.1:<port>"})` to the output record.
- Schema check is *not* a real import of the scaffolded TS — it calls `validateSchema` on an in-memory schema literal mirroring the template (with `hash:"scaffold"`) (`init.ts:131-166`). Output record: `{ok, directory, appName, port, version, created, agentKit?, mcp?, install, schemaCheck}` (`init.ts:191-205`). Exit 1 if install or schema check failed.

##### Scaffolded file contents (templates, `apps/cli/src/templates/`)
- Templates are inline TS template literals — no `.tpl` data dir (`templates/index.ts:1-12`). `TemplateVariables = {appName, port, version}`.
- `package.json` (`package.json.ts`): `{name, version, private:true, type:"module", scripts:{dev:"tsx src/server.ts", build:"tsc", test:"vitest run"}, dependencies:{"@fricken/protocol":"workspace:*", "@fricken/server":"workspace:*"}, devDependencies:{"@types/node":"^24.10.0", tsx:"^4.21.0", typescript:"^5.9.3", vitest:"^4.0.8"}}`.
- `frick.config.json` (`frick.config.json.ts`): `{appName, port, env:"development"}` — every key optional at runtime; exists so `frick doctor` has a config to validate.
- `tsconfig.json` (`tsconfig.json.ts`): target ES2022, module ESNext, moduleResolution Bundler, strict, outDir dist, rootDir src, include `src/**/*.ts`, exclude `node_modules`,`dist`,`tests`.
- `src/schema.ts` (`schema.ts.ts`): exports `schema: FrickSchema` with identity `{name: appName, schemaId: appName, schemaVersion: version, schemaRevision: 1, minimumClientRevision: 1, minimumServerRevision: 1, protocol: "frick.realtime", protocolVersion: 1, compatibility: "greenfield-cutover", hash: "scaffold"}` and empty `objects/streams/events/presences/signals/blobs/jobs/projections` arrays. Contains markers `// frick:objects` and `// frick:streams` for `frick scaffold`. The literal `hash:"scaffold"` is a placeholder — framework recomputes on validate.
- `src/server.ts` (`server.ts.ts`): `createFrickServer({schema, port})` with `port = Number(process.env.PORT ?? <port>)`; markers `// frick:projections:imports` and `// frick:projections:register`; ends `await app.listen();`.
- `tests/smoke.test.ts` (`smoke.test.ts.ts`): vitest test boots `createFrickServer({schema, port:0, dbPath:":memory:", config:{env:"test"}, jobs:{workerEnabled:false}})`, awaits `app.listen()`, fetches `` `${app.httpUrl}/health` `` expecting 200, asserts `app.store.schema.schemaId === schema.schemaId`, then `await app.close()`.

#### `frick scaffold object|stream|projection <Name>` (`src/commands/scaffold.ts`)
- `--directory`/`--cwd` flag selects the app dir (default `process.cwd()`).
- Objects/streams: name must be PascalCase `^[A-Z][A-Za-z0-9]*$`; projections kebab-case `^[a-z][a-z0-9-]*$` (`scaffold.ts:42-52`).
- IDs assigned by scanning comment markers `// frick:objects:id <n>` / `// frick:streams:id <n>` and taking max+1 (`scaffold.ts:78-91`) — *deliberate heuristic shortcut*; the stub itself embeds `// frick:<section>:id <n> <Name>` above the literal.
- Object stub: one field `{id:1, name:"displayName", kind:"string", required:true}`, one index `{id:1, name:"all", fields:["displayName"]}` (`scaffold.ts:93-104`). Stream stub: `keyFields:[{id:1,name:"key",kind:"string",required:true}], events:[]` (`scaffold.ts:106-115`).
- Insertion is bracket-balanced splice at the tail of the `objects: [` / `streams: [` array literal (`scaffold.ts:117-147`).
- Duplicate name → refusal exit 3 (idempotency by refusal).
- `projection <name>` creates `src/projections/<name>.ts` exporting `create<PascalName>Projection()` returning `{name, sources:[], handler:{apply(){return {changes:[]}}}}` and splices into `src/server.ts`: import line after `// frick:projections:imports`, and `// TODO: register ... \nvoid <factory>;` after `// frick:projections:register` (`scaffold.ts:227-271`).
- Output records: `{ok:true, kind:"object"|"stream", name, id, path}` or `{ok:true, kind:"projection", name, projectionPath, serverPath}`.

#### `frick dashboard` (`src/commands/dashboard.ts`)
- Flags: `--host` (default `127.0.0.1`), `--port` (default **4299**), `--endpoint` (default env `FRICK_DASHBOARD_ENDPOINT` then `http://127.0.0.1:4099`). Endpoint must be http(s) URL.
- Static file server for exactly 4 paths: `/`→`index.html`, `/index.html`, `/dashboard.css`, `/dashboard.js` (`dashboard.ts:19-24`); anything else 404, non-GET/HEAD 405 with `allow: GET, HEAD`.
- Assets resolved from `../dev-dashboard`, `../../dev-dashboard`, or `../../../dev-dashboard` relative to the compiled module (`dashboard.ts:83-100`); missing → usage error "rebuild @fricken/cli".
- Hardened headers on every response (`dashboard.ts:26-47`): strict CSP (`default-src 'self'`; `connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*`; `frame-src http://127.0.0.1:* http://localhost:*`; `object-src 'none'`; `frame-ancestors 'none'`; etc.), `x-frame-options: DENY`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, COOP/CORP same-origin, restrictive permissions-policy. `cache-control: no-store` everywhere.
- Emits `{ok:true, command:"dashboard", url:"http://<host>:<port>/?endpoint=<endpoint>", host, port, endpoint}` then **blocks forever** (`waitForever`, `dashboard.ts:195-199`). Host `0.0.0.0`/`::` displayed as `127.0.0.1` in the URL.

#### `frick mcp` (`src/commands/mcp.ts`)
- Flags: `--endpoint` (default env `FRICK_ENDPOINT` then `http://127.0.0.1:4099`), `--token`, `--tenant`, `--user`, `--allow-writes`, `--readonly`, `--print-config`.
- `allowWrites = --allow-writes && !--readonly` (`mcp.ts:41`) — `--readonly` wins.
- `--print-config` emits `createMcpClientConfig(options)` and exits 0; otherwise runs `runFrickMcpStdio` on process stdio and blocks forever.

### 1.5 CLI test suite (`apps/cli/tests/cli.test.ts`)
Covered below in §5.

---

## 2. `packages/mcp` — `@fricken/mcp` stdio MCP server

Package `@fricken/mcp` v0.3.0, bin `frick-mcp` → `dist/cli.js`. **Zero runtime dependencies** — hand-rolled JSON-RPC over stdin/stdout, no MCP SDK.

### 2.1 Transport (`src/stdio.ts`, `src/cli.ts`)
- Newline-delimited JSON-RPC 2.0 on stdin/stdout (`stdio.ts:25-61`). Parse error → `{jsonrpc:"2.0", id:null, error:{code:-32700, message:"Parse error", data:<detail>}}`. Handler exceptions → `-32603` with the error message. Notifications (handler returns `undefined`) produce no output.
- `frick-mcp` standalone CLI accepts exactly: `--endpoint`, `--token`, `--tenant`, `--user`, `--allow-writes`, `--readonly`, `--print-config`; unknown args → stderr `{error:{code:"mcp.usage", message}}`, exit 2 (`cli.ts:20-72`).

### 2.2 Protocol behavior (`src/server.ts`)
- `DEFAULT_MCP_PROTOCOL_VERSION = "2025-11-25"` (`server.ts:1`). `initialize` **echoes the client's protocolVersion** if it's a string, else the default (`server.ts:367-380`); serverInfo `{name:"frick-mcp", version:"0.0.0"}`; capabilities `{tools:{}, resources:{}, prompts:{}}`.
- Methods handled: `initialize`, `notifications/initialized` (no-op), `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list`, `prompts/get`. Anything else → `-32601 "Unknown MCP method: X"`. Missing `method` → `-32600`. Missing required params → `-32602`.
- Endpoint normalization strips trailing slashes; default `http://127.0.0.1:4099` (`server.ts:194-196`).
- Outgoing HTTP headers (the **wire-compat surface a Rust server must accept**, `server.ts:274-281`): `accept: application/json`; `authorization: Bearer <token>`; `x-frick-tenant: <tenantId>`; `x-frick-user: <userId>`.
- Non-2xx responses are returned as `{ok:false, status, body}`; non-JSON bodies wrapped `{text}` (`server.ts:283-303`).

### 2.3 Tools
Read tools (always listed, `server.ts:57-113`):

| name | input | HTTP call |
|---|---|---|
| `frick_mcp_config` | {} | none — returns client config |
| `frick_health` | {} | `GET /health` |
| `frick_ready` | {} | `GET /ready` |
| `frick_inspect_server` | {} | `GET /_frick/inspect/server` |
| `frick_inspect_db` | {} | `GET /_frick/inspect/db` |
| `frick_inspect_jobs` | {} | `GET /_frick/inspect/jobs` |
| `frick_read_stream` | `stream`*, `key`*, `limit` (int 1–100, default 50, clamped), `cursor` | `GET /streams/{stream}/{key}?limit=N[&cursor=C]` (URL-encoded path segments) |
| `frick_explain_error` | `code`* | none — static hint table |

Write tool (only listed when `allowWrites`, `server.ts:115-127`):
- `frick_append_event` — `stream`*, `key`*, `eventType`*, `payload`* (object) → `POST /streams/{stream}/{key}` with body `{"type": eventType, "payload": payload}` and `content-type: application/json` (`server.ts:329-345`). Without `--allow-writes`: `isError:true` result `{error:"frick_append_event requires --allow-writes"}` (not a JSON-RPC error).
- Tool results: `{content:[{type:"text", text: JSON.stringify(body, null, 2)}], structuredContent: body, isError}` (`server.ts:237-243`).
- Argument aliases: `frick_read_stream` accepts `stream` or `name`; `frick_append_event` accepts `eventType` or `type` (`server.ts:320,333`).
- Unknown tool → `isError:true` `{error:"Unknown Frick MCP tool: X"}` (still JSON-RPC success).

### 2.4 Error-hint table (`server.ts:162-172`)
Static map of structured Frick error codes → debugging hints: `auth.unauthenticated`, `auth.forbidden`, `auth.sessionExpired`, `schema.incompatible`, `schema.migrationRequired`, `storage.conflict`, `stream.appendRejected`, `sync.protocolError`, `sync.reconnectExhausted`. Unknown codes → "Treat it as opaque...". This enumerates the canonical error codes the Rust server must emit identically.

### 2.5 Resources & prompts
- Static resources (`server.ts:129-137`): `frick://mcp/config`, `frick://server/health`, `frick://server/ready`, `frick://inspect/server`, `frick://inspect/db`, `frick://inspect/jobs`, `frick://schema/current` (the last one reads `/_frick/inspect/server` — same payload as server inspection). Each `mimeType: application/json`, `annotations:{audience:["assistant"], priority:0.8}`, `name` = uri minus `frick://`.
- One resource template: `frick://streams/{stream}/{key}` named `stream-page` (`server.ts:393-404`).
- `resources/read` result includes a non-standard top-level `structuredContent` next to `contents` (`server.ts:433-444`).
- Prompts (`server.ts:139-160`): `debug_frick_sync` (args `userId`, `stream`), `inspect_frick_runtime`, `design_frick_projection` (arg `projection`). All render single-user-message texts (`server.ts:446-501`). Unknown prompt name → `{description:"Unknown prompt", ...}` success.

### 2.6 `createMcpClientConfig` (`server.ts:245-260`)
Returns `{ok:true, transport:"stdio", command:"frick", args:["mcp","--endpoint",<ep>,(--allow-writes),(--tenant,t),(--user,u),(--token,tok)], endpoint, readonly: allowWrites !== true}`. Note: the standalone `frick-mcp` CLI emits the same `command:"frick"` (not `frick-mcp`).

---

## 3. `packages/agent-kit` — `@fricken/agent-kit`

Package v0.3.0, bin `frick-agent-kit` → `dist/cli.js`. Ships `manifest.json`, `skills/`, `agents/`, `references/`, `adapters/` in the npm tarball. No runtime impact on the wire protocol — it is a static asset installer for agent harnesses (Codex, Claude Code, Cursor).

### 3.1 Manifest (`manifest.json`)
- `pluginSurfaces`: codex `adapters/codex/plugin/.codex-plugin/plugin.json`, claude `adapters/claude-code/plugin/plugin.json`, cursor `adapters/cursor/plugin/plugin.json`.
- `sharedReferences`: `references/spine-template.md`, `parallel-execution.md`, `prompt-cookbook.md`, `compatibility-matrix.md`.
- Exactly **25 capabilities** (each with skill path, per-harness agents, cursorRules, docs, commands): `frick-fullstack-app`, `frick-shared-spine`, `frick-parallel-execution`, `frick-schema-design`, `frick-server-backend`, `frick-projections`, `frick-jobs`, `frick-blobs`, `frick-auth-tenancy`, `frick-migrations-versioning`, `frick-web-react`, `frick-typescript-core`, `frick-swift-ios`, `frick-kotlin-android`, `frick-design-tokens`, `frick-sync-debugging`, `frick-cache-debugging`, `frick-protocol-debugging`, `frick-push-notifications`, `frick-dashboard-operations`, `frick-generated-artifacts`, `frick-cross-platform-parity`, `frick-testing`, `frick-release-readiness`, `frick-mcp-runtime`. Skills live under `skills/<id>/SKILL.md` (one dir per capability).
- Eight agent personas per harness: `frick-android`, `frick-backend`, `frick-debugger`, `frick-ios`, `frick-mcp`, `frick-orchestrator`, `frick-release-reviewer`, `frick-web` (`adapters/*/agents/`).

### 3.2 Installer (`src/installer.ts`)
- `installAgentKit({targetDir, harnesses?, force?, dryRun?})` → `InstallAgentKitReport {ok, targetDir, harnesses, written[], skipped[], dryRun}` (sorted paths).
- Default harnesses = all three. Existing files are **skipped** unless `force` (`installer.ts:103-114`). Path-traversal guard refuses writes outside targetDir (`installer.ts:96-101`).
- Shared install (always): `references/spine-template.md` → `docs/frick/spine.md`; whole `references/` dir → `docs/frick/agent-kit/`; generates `AGENTS.md` with fixed guidance text (`installer.ts:231-246`).
- codex → `.agents/plugins/frick-agent-kit/` (plugin + skills), `.codex/agents/`, `.agents/plugins/marketplace.json`.
- claude → `.claude/skills/`, `.claude/agents/`, `.claude/plugins/frick-agent-kit/`.
- cursor → `.cursor/skills/`, `.cursor/agents/`, `.cursor/rules/`, `.cursor/plugins/frick-agent-kit/`.
- `validateCapabilityMatrix()` checks every manifest-referenced file exists; finding kinds: `missing-skill|missing-agent|missing-cursor-rule|missing-plugin-surface|missing-reference` (`installer.ts:155-229`).

### 3.3 CLI (`src/cli.ts`)
`frick-agent-kit install [--target <dir>] [--all|--codex|--claude|--cursor] [--force] [--dry-run]`. No harness flags = all. JSON-lines output of the report; errors → stderr `{error:{code:"agentKit.error", message}}`, exit 1; missing command → usage text, exit 2.

---

## 4. `apps/rangercrm-server` — reference downstream app

Private package `rangercrm-server` v0.1.0; depends only on `@fricken/protocol` + `@fricken/server` (workspace). Two source files; run with `pnpm dev` = `tsx src/server.ts`.

### 4.1 `src/server.ts` (entire file, 8 lines)
```ts
const port = Number(process.env.PORT ?? 4099);
const app = createFrickServer({ schema, port });
await app.listen();
```
This is the **canonical example of a downstream app**: it proves `createFrickServer({schema, port})` is the entire public embedding API a Rust server must replicate (schema override + listen).

### 4.2 `src/schema.ts` — RangerCRM schema (mirrors legacy CoreData `RangerCoreData14.xcdatamodeld`)
- Identity: `{name:"rangercrm", schemaId:"rangercrm", schemaVersion:"0.1.0", schemaRevision:1, minimumClientRevision:1, minimumServerRevision:1, protocol:"frick.realtime", protocolVersion:1, compatibility:"greenfield-cutover", hash:"rangercrm-0.1.0"}` (`schema.ts:15-25`). Note: hand-written `hash` here is a free-form string, NOT a computed hash — confirms the runtime recomputes/ignores the literal.
- Five objects, all `mergePolicy: "versionPrecondition"`, all user-scoped via `ownerUserId`/`userId` string field; empty `streams/events/presences/signals/blobs/jobs/projections`:
  1. `Account` (id 1): 30 fields — strings/bools/timestamps; **lat/lng stored as `string`** (`accountCoordLatitude` id 24, `accountCoordLongitude` id 25) "to keep wire-stable across float representations" (`schema.ts:54-57`); 3 indexes `byOwner`, `byOwnerName`, `byOwnerFollowUp`.
  2. `Contact` (id 2): 21 fields; `accountId` is `kind:"ref", ref:"Account"` (field id 2); indexes `byOwner`, `byAccount`.
  3. `Quote` (id 3): 27 fields; **`quoteValueCents` is `kind:"int"`** (integer cents, no floats on the wire, `schema.ts:110-112`); `quoteStatus` is `kind:"enum", enumValues:["open","closed","won","lost"]` (field id 27); indexes `byOwner`, `byAccount`, `byOwnerStatus`.
  4. `Note` (id 4): 8 fields; indexes `byOwner`, `byAccount`.
  5. `UserProfile` (id 5): app-specific profile keyed by Frick `userId`; Frick itself owns email/handle/passwordHash (`schema.ts:169-174`); fields incl. `isRoot`, `twoFactorAuth`, `securityQuestion/Answer`, `repType`; one index `byUser`.
- Comments stress: **stable field ids matter, never reuse one**; iOS client seeds Frick object ids (UUID strings) from legacy CoreData ids so migration is idempotent (`schema.ts:8-11`).
- This schema is the best concrete fixture of the full field-kind vocabulary used by a real app: `string`, `bool`, `int`, `timestamp`, `ref` (with `ref:` target), `enum` (with `enumValues`).

---

## 5. Test landscape

### 5.1 Vitest setup and the cwd gotcha

- Single root config `/Users/bri/dev/Frick/vitest.config.ts`: `testTimeout: 30_000`, `hookTimeout: 30_000` (raised from the 5s default because many suites cold-spawn `tsx` processes per test — comment in the config), excludes `node_modules/dist/dist-types/build/.build/.claude`.
- Root scripts (`package.json`): `pnpm test` = `pnpm build:packages && vitest run` **from the repo root**; `pnpm test:pg` runs the six Postgres suites (`pg-migrations pg-sql-driver pg-identity pg-tenant-admin pg-blobs pg-search`).
- **CWD GOTCHA (must preserve in any Rust test harness):** several suites resolve paths from `process.cwd()` assuming the repo root:
  - `packages/protocol/tests/fixtures.test.ts:12` — `join(process.cwd(), "packages/protocol/fixtures")`.
  - `packages/protocol/tests/generate-signing.test.ts:14-16` — `repoRoot = process.cwd()`, runs `npx tsx packages/protocol/scripts/generate-native-artifacts.ts` with `cwd: repoRoot`.
  - `packages/protocol/package.json` test script is `cd ../.. && vitest run packages/protocol/tests` — i.e. it forces repo-root cwd. `apps/server`'s script is plain `vitest run`, so `pnpm --filter @fricken/server exec vitest run <file>` runs from the package dir and any repo-root-relative path doubles up (`packages/protocol/packages/protocol/fixtures/...` ENOENT). Correct one-file invocation: `pnpm exec vitest run apps/server/tests/<file>` **from the repo root**.
  - The Kotlin (`apps/android/frick/src/test/java/dev/frick/client/FrickProtocolFixturesTest.kt:64-81`) and Swift (`packages/swift/Tests/FrickSwiftTests/FrickEventStreamParserTests.swift:1272-1291`) fixture tests are cwd-robust: Kotlin walks parent dirs from `user.dir` until it finds `packages/protocol/fixtures/<name>`; Swift derives the repo root from `#filePath`.

### 5.2 Wire/golden fixtures (`packages/protocol/src/fixtures.ts`, checked-in under `packages/protocol/fixtures/`)

Three canonical JSON fixtures, regenerated by `pnpm fixtures:generate` (`packages/protocol/scripts/generate-fixtures.ts`, which `rm -rf`s and rewrites the dir; output `JSON.stringify(value, null, 2) + "\n"`):

1. **`foundation-schema.json`** — the (intentionally empty) production foundation schema. Identity: `{name:"frick-foundation", schemaId:"frick-foundation", schemaVersion:"0.1.0", schemaRevision:1, minimumClientRevision:1, minimumServerRevision:1, protocol:"frick.realtime", protocolVersion:1, compatibility:"greenfield-cutover", hash:"frick-foundation-empty-0.1.0"}` plus 8 empty arrays in order `objects, streams, events, presences, signals, blobs, jobs, projections`.
2. **`error-envelope.json`** — built with `createFrickErrorEnvelope` (`src/fixtures.ts:10-20`); exact field order: `code:"schema.incompatible", message:"Fixture schema mismatch", requestId:"fixture-error", retryable:false, details:{reason:"fixture"}, schemaHash:"frick-foundation-empty-0.1.0", schemaRevision:1`.
3. **`hello-frame.json`** — a `FrickFrame` is a **2-element tuple `[FrameKind, payload]`**; `FrameKind.Hello === 0`. Payload field order: `replicaId:"fixture-replica", deviceId:"fixture-device", schemaHash, knownCursors:{}, clientCapabilities:{platform:"test", sdkVersion:"0.0.0-fixture", schema:{schemaId, schemaRevision, schemaHash}, transports:["websocket"], encodings:["msgpack"], primitives:["objects","streams","presence","signals"], offline:{cache:true, pendingAppends:true}, blobUploads:["direct"], push:[], experimental:[], required:[]}` (this is the serialized output of `defaultClientCapabilities`, `src/fixtures.ts:22-37`).

These fixtures are the **cross-platform drift gate**: decoded and compared against generated constants by
- TS: `packages/protocol/tests/fixtures.test.ts` (asserts identity equality vs `foundationSchema`, `isFrickErrorEnvelope`, `FrameKind.Hello`, `defaultClientCapabilities`).
- Kotlin: `apps/android/frick/src/test/java/dev/frick/client/FrickProtocolFixturesTest.kt` (decodes into generated DTOs with `ignoreUnknownKeys`).
- Swift: `FrickProtocolFixturesTests` inside `packages/swift/Tests/FrickSwiftTests/FrickEventStreamParserTests.swift:1272+` (asserts vs `FrickSchema.schemaId/schemaRevision/schemaHash/schemaVersion`).
- `pnpm verify:generated` (`scripts/check-generated-artifacts.ts`) re-runs `schema:generate` + `fixtures:generate` + `design:generate` and fails if any **tracked** file is newly dirty (it snapshots pre-existing dirt first to avoid false positives).

A second, richer schema fixture: **`productTestSchema`** (`packages/protocol/src/fixtures/product-test-schema.ts`, 286 lines) — identity `{name:"frick-product-test", schemaId:"frick-product-test", schemaVersion:"0.1.0", schemaRevision:1, hash:"frick-product-test-0.2.0"}` (note version/hash mismatch is intentional and harmless — hash is a free string). It is the pre-cleanup chat-product schema (User/Conversation/RoomMember/CallRoom objects, streams, presence, signals, blobs, jobs, projections) kept purely so server tests exercise framework primitives against a non-trivial schema; "do not import this file from runtime code".

### 5.3 How server tests boot servers (`apps/server/tests/`, 161 test files)

Canonical pattern (`apps/server/tests/server.test.ts:954-970`):
```ts
const server = createFrickServer({ port: 0, dbPath: ":memory:", schema: productTestSchema, ...options });
await server.listen();
const address = server.server.address();   // real ephemeral port
return {
  url: `ws://127.0.0.1:${address.port}/_frick/sync`,
  httpUrl: `http://127.0.0.1:${address.port}`,
  store: server.store,
  close: server.close,
};
```
Key facts a Rust black-box harness must mirror:
- `port: 0` (OS-assigned), `dbPath: ":memory:"`, schema = `productTestSchema`; WS sync endpoint path is **`/_frick/sync`**.
- Auth helpers used everywhere (`server.test.ts:1055-1159`):
  - `POST /auth/dev-login` body `{userId, tenantId?, deviceId?, replicaId?, platform?}` → 200 `{schemaHash, sessionToken, userId, deviceId, replicaId, expiresAt}` (ISO date). Session token length > 30.
  - `POST /auth/signup` body `{displayName, handle, password, deviceId?, replicaId?, platform?}` → **201** `{schemaHash, sessionToken, userId, displayName, handle, deviceId, replicaId, expiresAt}`.
  - `POST /auth/login` body `{identity, password, ...}` → 200, same shape; wrong password → 401.
  - Subsequent calls use `authorization: Bearer <sessionToken>`.
- **dev-login handle gotcha** (memory note + test-observed): `/auth/dev-login` derives a globally-unique handle from `userId`, so the same userId cannot dev-login into two tenants ("Handle is already taken"). Tests that need same-user-across-tenants mint sessions directly via `store.sessions.create({...})`.
- Unauthenticated `GET /objects` → 401; `GET /objects?type=User` with bearer → 200 and response JSON includes `schemaHash` of the active schema (`server.test.ts:35-69`).
- WS tests use the `ws` npm package plus `encodeFrame`/`decodeFrame`, `FrameKind`, `defaultClientCapabilities`/`defaultServerCapabilities` from `@fricken/protocol` to drive the msgpack handshake directly.
- Many suites are unit-level instead (no server boot): e.g. `wire.test.ts` calls `sendFrame` against a stub socket and asserts the backpressure close `1013 "WebSocket outbound buffer exceeded"` when `bufferedAmount > maxBufferedAmount`.
- Suite breadth (file names enumerate the behavioral surface): auth/admin/authz, blobs (+GC, quotas, processors), backups, calls control plane + wire, cluster/region buses (redis), CORS, demo auth, diagnostics, http-errors, idempotency, jobs, OIDC/SAML, platform events (memory/sqlite/kafka against a **shared conformance suite** `platform-events.conformance.ts` exporting `definePlatformEventPipelineConformance(harness)`), Postgres (`pg-*.test.ts` — same store contracts on a real PG), push (APNs/FCM/WebPush adapters + `push-wire-contract.test.ts` which pins the exact push JSON the native `FrickPushPayload.from(...)` decoders read, driven over a local HTTP/2 server), projections (+delta push, sync), sessions, sharing, SSE, streams cursor, sync object writes, telemetry-otel, tenant isolation/migration, ws-authz / ws-frame-size / ws-session-device-binding.

### 5.4 End-to-end smoke harness (`scripts/e2e-smoke.ts`, `pnpm e2e:smoke`)

- Boots a real server on a **disk-backed** SQLite file in a tmpdir (not `:memory:`), `config:{env:"development"}`, schema = `productTestSchema`, `port: 0`.
- Asserts: all `FRAMEWORK_MIGRATIONS` apply to a fresh file; auth session survives across requests; HTTP append + stream read + inbox projection; **WebSocket Hello → HelloAck → Schema → Subscribe → Delta round-trip**; graceful shutdown; cold restart against the same DB with no migration re-run and no data loss.
- Emits JSON Lines per step `{step, status:"ok"|"failed", detail?/error}`; exit 0/1.
- Contains a buffered frame-queue helper because Node's spec WebSocket does not buffer messages pre-listener (comment at `scripts/e2e-smoke.ts` ~line 105) — a Rust harness using a raw WS client needs the same care.

### 5.5 CLI black-box tests (`apps/cli/tests/cli.test.ts`, 941 lines, 45 tests)

- Every test spawns the CLI as a **real child process**: `pnpm exec tsx apps/cli/src/index.ts <args>` with `cwd` = repo root (`cli.test.ts:31-53`), asserting exit code + stdout/stderr JSON shapes — exactly the contract a Rust `frick` binary must reproduce.
- Coverage: `--help` listing; `mcp --print-config`; `dashboard` (parses the first stdout line of a long-running process, then kills it; invalid port → exit 2); `dev` (redpanda/sqlite plans via `--dry-run`, unknown profile rejected); `deploy` (compose/lightweight plans, `deploy image` plan + custom inputs + flag validation); `schema check`; `migrate status/up` incl. production refusal; `doctor` green + db-failure red; `reset` (dev-only refusals); `tenants list/create/set-push` — notably *"set-push --platform webpush wraps VAPID credentials that the server can decrypt"* (`cli.test.ts:552`) verifies round-trip decryption via `loadWebPushCredentials` + `TenantSettingsStore` + `SqliteSqlDriver` with a `FRICK_PUSH_CRED_KEY`; `inspect server/jobs/diagnostics` (+malformed cursor probe); `backup`/`restore` NDJSON round-trip and `--confirm` refusal; `lint` clean + breaking `--against`; `init` file tree + agents/MCP install; `scaffold object/projection`; unknown command exit 2.

### 5.6 MCP & agent-kit package tests

- `packages/mcp/src/index.test.ts` (6 tests, in-process): initialize capability echo; tools/resources/prompts listings; HTTP call carries `authorization`/`x-frick-tenant`/`x-frick-user` headers via injected `fetcher`; write-tool gating by `allowWrites`; resources/read + prompts/get; stdio parse error → JSON-RPC `-32700`.
- `packages/agent-kit/src/index.test.ts` (2 tests): manifest capability matrix has zero findings and ≥25 capabilities incl. `frick-mcp-runtime`; installer writes all harness surfaces into a tmpdir and a second run writes nothing (`written: []`, all skipped); `docs/frick/spine.md` content contains "Frick App Spine".

### 5.7 Client SDK test suites and pointing them at an arbitrary server

Per `docs/cross-platform-client-contract.md` (the contract every SDK must share — schema identity constants, shared error envelope incl. wrapped + top-level mirror shapes, capability negotiation prefixes `transport.*`/`encoding.*`/`primitive.*`/`blobUpload.*`/`push.*`/`experimental.*`, cache compatibility rules, `ProjectionDelta` semantics, sharing clamps of 14/90 days, etc.):

- **TypeScript / web** — runtime SDK is `packages/core` (tests in `packages/core/tests/`: `runtime`, `bindings`, `optimistic`, `analytics`, `background-sync`, `indexeddb-cache`, `calls`, `p2p`, `sfu`, `e2ee*`); React bindings `packages/react/src/index.test.tsx`; design system `packages/design-web/src/*.test.tsx`; web app shell tests `apps/web/src/*.test.ts` (service-worker, security-headers, app-session, theme). All run under the root vitest config (`packages/core` has **no own test script**; the root run picks them up). Pointing at a server: `FrickClient`/runtime takes `endpoint` (WebSocket URL) and optional `httpEndpoint`; `resolveHttpEndpoint(endpoint)` translates `ws(s)://` → `http(s)://`, stripping path/search/hash for WS endpoints while HTTP endpoints keep their path for subpath mounting (`packages/core/src/http.ts:1-12`, `runtime.ts:81-82,223-224`).
- **Swift** — `packages/swift/Tests/FrickSwiftTests/` (16 files: SyncSocket, Store, StoreRegistry, ProjectionStore, SessionManager/Persistence, SharingService, Query, PushPayload, MsgPackHardening, EventStreamParser+ProtocolFixtures, CodecBenchmark, Calls/CallSession, ClientSessionSwap, ModelMacroIntegration) plus `Tests/FrickMacrosTests/`. Run via `pnpm swift:test` = `pnpm schema:generate && pnpm design:generate && swift test --package-path packages/swift && swift test --package-path packages/design-swift` (root `package.json`). The unit tests use mock/stub transports and the checked-in JSON fixtures — **no live server**. To point at an arbitrary server: `FrickClient(baseURL:)` — default `FrickClient.defaultBaseURL` is `http://127.0.0.1:4099` in DEBUG, `https://127.0.0.1:4099` otherwise; non-HTTPS base URLs require `allowInsecureLocalTransport` (DEBUG default true) and are validated in the initializer (`packages/swift/Sources/FrickSwift/FrickClient.swift:926-993`). Product-schema apps must inject `schemaId/schemaRevision/schemaHash/syncDescriptor` or the Hello handshake is rejected ("Schema id mismatch") (`FrickClient.swift:958-970`).
- **Kotlin / Android** — JVM unit tests in `apps/android/frick/src/test/java/dev/frick/client/` (SyncSocket, SQLiteStorage, SessionManager, SharingService, ProjectionStore, ObservableStore, PushReceiver, EventStreamParser, ProtocolFixtures, CodecBenchmark, CallManager, StoreRegistry, SyncSocketTelemetry, ClientSignOut), plus `frick-compose` and `design` module tests. Run via `pnpm android:build` → `./gradlew :frick:testDebugUnitTest ...` (root `package.json`). Pointing at a server: `FrickClient(baseUrl:)` with `DefaultBaseUrl = "https://127.0.0.1:4099"` (`apps/android/frick/src/main/java/dev/frick/client/FrickClient.kt:849,938`).
- **Conformance strategy for the Rust server**: none of the SDK unit suites dial a configurable URL from env today — they are transport-mocked. The live-server compatibility levers are (a) the three golden JSON fixtures in `packages/protocol/fixtures/` (decode-compat), (b) `apps/server/tests/*` black-box suites and `scripts/e2e-smoke.ts` (behavior), and (c) each SDK's constructor `baseURL`/`baseUrl`/`endpoint` parameter, which is the intended injection point for an arbitrary-server conformance harness. `apps/server/tests/push-wire-contract.test.ts` is the template for cross-language wire pinning (server-emitted JSON asserted against the exact paths native decoders read).

---

## 6. Surprises / undocumented behaviors worth preserving

1. `frick inspect jobs` duck-types a not-yet-existing `countsByStatus` and exits 0 with `available:false` — scripts probe presence, not health (`apps/cli/src/commands/inspect.ts:120-139`).
2. `frick restore` maps refusals to **exit 1** (`cli.restore.<reason>` failure), while missing `--confirm yes` is exit 3 — two different refusal channels in one command (`apps/cli/src/commands/restore.ts:23-27,58-66`).
3. CLI `--env` flag with an invalid value is silently dropped rather than erroring (`apps/cli/src/context.ts:18-19`).
4. `frick init`'s "schema check" validates a hard-coded in-memory schema literal, not the scaffolded file (`apps/cli/src/commands/init.ts:131-166`) — it can only fail if `validateSchema` itself rejects the canonical empty shape.
5. Scaffold ID allocation depends on comment markers (`// frick:objects:id N`), not on parsing the actual literals — renumbering is the developer's job (`apps/cli/src/commands/scaffold.ts:78-91`).
6. MCP `initialize` echoes back whatever protocolVersion string the client sent (no version negotiation/validation) (`packages/mcp/src/server.ts:367-371`).
7. `createMcpClientConfig` always advertises `command:"frick"` even when emitted by the standalone `frick-mcp` binary (`packages/mcp/src/server.ts:245-260`, `src/cli.ts:63-64`).
8. The `frick dashboard` URL embeds the Frick endpoint as a query parameter (`?endpoint=...`) — the dashboard JS reads it client-side; CSP allows connecting only to localhost origins (`apps/cli/src/commands/dashboard.ts:62-66,26-47`).
9. Schema `hash` literals are free-form placeholders in scaffolds and rangercrm (`"scaffold"`, `"rangercrm-0.1.0"`, productTestSchema `"frick-product-test-0.2.0"` with schemaVersion `0.1.0`) — identity comparison treats hash as an opaque string; only the foundation/golden fixtures pin a specific value (`frick-foundation-empty-0.1.0`).
10. Root `vitest.config.ts` raised timeouts to 30s specifically because black-box suites cold-spawn `tsx`; a faster Rust binary could lower this, but the JSON-shape contracts in `apps/cli/tests/cli.test.ts` stay binding.
11. `apps/server/src/gateway.ts` contains an **intentional NUL byte** — grep treats the file as binary; use `rg --text` / `grep -a` (memory note; relevant to any tooling that scans the source tree).
12. RangerCRM deliberately encodes floats as strings (lat/lng) and currency as integer cents to keep msgpack wire representation stable across platforms (`apps/rangercrm-server/src/schema.ts:54-57,110-112`) — a precedent the Rust codec must not "helpfully" normalize.
