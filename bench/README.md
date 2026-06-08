# `@fricken/bench` — Benchmarks (FR-96 / FR-97 / FR-98 / FR-99 / FR-100)

A reusable synthetic benchmark package for Frick. It drives configurable load
against a Frick server and emits a single machine-readable JSON result to stdout
so CI and trend tooling can consume it. It is reusable, not a one-off — the
performance-budget checker (FR-100) sits on top of the measurement suites.

The CLI hosts the measurement suites plus a budget checker:

| Subcommand | Story | What it measures | Script |
| --- | --- | --- | --- |
| `load` (default) | FR-96 | Synthetic per-user load: object upserts + stream appends | `pnpm load:harness` |
| `latency` | FR-97 | p50/p90/p99 latency across the core paths | `pnpm bench:latency` |
| `throughput` | FR-98 | Sustained ops/sec + resource growth (memory/db/cache) | `pnpm bench:throughput` |
| `codec` | FR-99 | Codec encode/decode speed over representative frames (no server) | `pnpm bench:codec` |
| `budget` | FR-100 | PASS/FAIL the suites against declared thresholds + record a trend | `pnpm bench:budget` |

Every suite is kept deliberately separate from the correctness tests: the
harnesses only **measure** and never assert product behavior. By default each
spins up an in-process `createFrickServer` on an ephemeral port backed by an
in-memory SQLite store; pass `--http-url URL --ws-url URL` (both required) to
drive an already-running external server instead.

## Load harness (FR-96)

### What it does

By default the harness:

1. spins up an in-process `createFrickServer` on an ephemeral port, backed by an
   in-memory SQLite store (`dbPath: ":memory:"`);
2. registers `--users` synthetic users — each dev-logs-in over HTTP, opens a WS
   connection, Hello-handshakes, and (unless `--no-subscribe`) subscribes to its
   own conversation stream;
3. has each user perform `--object-writes-per-user` object upserts and
   `--appends-per-user` stream appends, recording per-operation latency;
4. prints a JSON result and exits non-zero if any operation errored.

Synthetic payloads are deterministic given `--seed`.

### Running

```bash
# Defaults (10 users, 5 object writes + 20 appends each, subscribed):
pnpm load:harness

# Custom load, pretty JSON:
pnpm load:harness --users 100 --appends-per-user 50 --object-writes-per-user 10 --pretty

# Drive an already-running external server instead of spinning one up:
pnpm load:harness --http-url http://127.0.0.1:8787 --ws-url ws://127.0.0.1:8787/_frick/sync
```

### Flags (env fallbacks in parentheses)

| Flag | Meaning | Env |
| --- | --- | --- |
| `--users N` | synthetic users | `FRICK_LOAD_USERS` |
| `--appends-per-user N` | stream appends per user | `FRICK_LOAD_APPENDS_PER_USER` |
| `--object-writes-per-user N` | object upserts per user | `FRICK_LOAD_OBJECT_WRITES_PER_USER` |
| `--seed N` | deterministic payload seed | `FRICK_LOAD_SEED` |
| `--no-subscribe` | skip the WS subscription step | `FRICK_LOAD_SUBSCRIBE=0` |
| `--http-url URL` / `--ws-url URL` | drive an external server (both required) | `FRICK_LOAD_HTTP_URL` / `FRICK_LOAD_WS_URL` |
| `--pretty` | indent the JSON output | — |
| `--help` | print usage to stderr | — |

Precedence is flag > env > default. Diagnostics go to stderr; stdout carries
exactly one JSON object.

### Output shape

```jsonc
{
  "schemaVersion": 1,
  "tool": "frick-load-harness",
  "startedAt": "2026-06-07T00:00:00.000Z",
  "config": { "users": 10, "appendsPerUser": 20, "objectWritesPerUser": 5, "subscribe": true, "seed": 1 },
  "env": { "node": "v24.x", "platform": "darwin", "inProcessServer": true },
  "totalDurationMs": 123.45,
  "operations": {
    "connect":      { "count": 10, "errors": 0, "latencyMs": { "min": 0, "max": 0, "mean": 0, "p50": 0, "p90": 0, "p99": 0, "count": 10 }, "throughputPerSec": 0 },
    "objectUpsert": { "count": 50,  "errors": 0, "latencyMs": { /* … */ }, "throughputPerSec": 0 },
    "streamAppend": { "count": 200, "errors": 0, "latencyMs": { /* … */ }, "throughputPerSec": 0 }
  },
  "totals": { "users": 10, "connections": 10, "objectUpserts": 50, "streamAppends": 200, "errors": 0 }
}
```

### Programmatic use

```ts
import { runLoad, parseLoadConfig } from "@fricken/bench";

const result = await runLoad({ users: 5, appendsPerUser: 10 });
```

## Latency suite (FR-97)

Measures one latency sample per iteration across the core paths and emits JSON
(`tool: "frick-latency-bench"`) with p50/p90/p99 per path:

- **`httpRequest`** — an authenticated HTTP `GET /objects` round-trip.
- **`wsAppend`** — WS stream append → durable `Ack` round-trip (correlated by `requestId`).
- **`objectFanout`** — one client upserts a `Conversation`; a *second* subscribed
  client receives the broadcast `Delta` (the write → fan-out path).
- **`catchUp`** — `Subscribe` to a backfilled stream → first `StreamPage`
  (subscribe → snapshot/page catch-up). A backlog is seeded over HTTP first.
- **`reconnect`** — open a fresh WS, Hello-handshake, drain `HelloAck`.

```bash
# Defaults (50 iterations/path, 25-event catch-up backlog):
pnpm bench:latency

# Custom, pretty JSON:
pnpm bench:latency --iterations 200 --catch-up-backlog 100 --pretty
```

### Flags (env fallbacks in parentheses)

| Flag | Meaning | Env |
| --- | --- | --- |
| `--iterations N` | samples per path | `FRICK_LAT_ITERATIONS` |
| `--catch-up-backlog N` | seeded backlog events for the catch-up path | `FRICK_LAT_CATCH_UP_BACKLOG` |
| `--http-url URL` / `--ws-url URL` | drive an external server (both required) | `FRICK_LOAD_HTTP_URL` / `FRICK_LOAD_WS_URL` |
| `--pretty` | indent the JSON output | — |

### Output shape

```jsonc
{
  "schemaVersion": 1,
  "tool": "frick-latency-bench",
  "startedAt": "2026-06-07T00:00:00.000Z",
  "config": { "iterations": 50, "catchUpBacklog": 25 },
  "env": { "node": "v24.x", "platform": "darwin", "inProcessServer": true },
  "totalDurationMs": 123.45,
  "paths": {
    "httpRequest":  { "count": 50, "errors": 0, "latencyMs": { "min": 0, "max": 0, "mean": 0, "p50": 0, "p90": 0, "p99": 0, "count": 50 } },
    "wsAppend":     { "count": 50, "errors": 0, "latencyMs": { /* … */ } },
    "objectFanout": { "count": 50, "errors": 0, "latencyMs": { /* … */ } },
    "catchUp":      { "count": 50, "errors": 0, "latencyMs": { /* … */ } },
    "reconnect":    { "count": 50, "errors": 0, "latencyMs": { /* … */ } }
  },
  "totalErrors": 0
}
```

```ts
import { runLatency } from "@fricken/bench";
const result = await runLatency({ iterations: 100 });
```

## Throughput + resource-growth suite (FR-98)

Drives a sustained append/upsert workload across N concurrent WS connections and
emits JSON (`tool: "frick-throughput-bench"`) with completed ops/sec plus a
`resources` section sampling process memory, SQLite db size + per-table row
counts, and the idempotency-cache row count **before vs after**, with deltas.

Resource growth requires the in-process `store`, so it is present only when the
suite spins the server up itself (the default). Driving an external server with
`--http-url`/`--ws-url` still measures throughput but omits `resources`.

```bash
# Defaults (8 connections, 100 ops each, 20% upserts, awaiting each ack):
pnpm bench:throughput

# Pipelined (don't await each ack) for a higher throughput number:
pnpm bench:throughput --connections 16 --ops-per-connection 500 --no-await-acks --pretty
```

### Flags (env fallbacks in parentheses)

| Flag | Meaning | Env |
| --- | --- | --- |
| `--connections N` | concurrent WS connections | `FRICK_TPUT_CONNECTIONS` |
| `--ops-per-connection N` | ops issued per connection | `FRICK_TPUT_OPS_PER_CONNECTION` |
| `--upsert-ratio F` | fraction of ops that are object upserts (0..1) | `FRICK_TPUT_UPSERT_RATIO` |
| `--no-await-acks` | pipeline ops instead of awaiting each ack | `FRICK_TPUT_AWAIT_ACKS=0` |
| `--seed N` | deterministic payload seed | `FRICK_LOAD_SEED` |
| `--http-url URL` / `--ws-url URL` | drive an external server (growth omitted) | `FRICK_LOAD_HTTP_URL` / `FRICK_LOAD_WS_URL` |
| `--pretty` | indent the JSON output | — |

### Output shape

```jsonc
{
  "schemaVersion": 1,
  "tool": "frick-throughput-bench",
  "startedAt": "2026-06-07T00:00:00.000Z",
  "config": { "connections": 8, "opsPerConnection": 100, "upsertRatio": 0.2, "awaitAcks": true, "seed": 1 },
  "env": { "node": "v24.x", "platform": "darwin", "inProcessServer": true },
  "durationMs": 456.78,
  "ops": { "appends": 640, "upserts": 160, "total": 800, "errors": 0 },
  "throughputPerSec": { "appends": 0, "upserts": 0, "total": 0 },
  "resources": {
    "before": { "memory": { "rss": 0, "heapUsed": 0, "external": 0 }, "dbBytes": 0, "rowCounts": { "stream_events": 0, "objects": 0, "idempotency_keys": 0 }, "idempotencyCacheRows": 0 },
    "after":  { /* … */ },
    "delta":  { "rssBytes": 0, "heapUsedBytes": 0, "dbBytes": 0, "rowCounts": { "stream_events": 640, "objects": 160, "idempotency_keys": 640 }, "idempotencyCacheRows": 640 }
  }
}
```

```ts
import { runThroughput } from "@fricken/bench";
const result = await runThroughput({ connections: 4, opsPerConnection: 200 });
```

## Codec speed suite (FR-99)

Benchmarks the `@fricken/protocol` wire codec (`encodeFrame` / `decodeFrame`)
in **pure isolation** — no server, no sockets, no I/O, just CPU — over four
representative frame shapes, and emits JSON (`tool: "frick-codec-bench"`) with
per-op latency (microseconds), ops/sec, and bytes/sec for each shape and
direction (encode + decode):

- **`appendMessage`** — a single `Append` frame carrying one `MessageSent`.
- **`objectUpsert`**  — an `ObjectUpsert` of a `Conversation`.
- **`streamPage`**    — a `StreamPage` with `--page-events` packed stream events.
- **`delta`**         — a `Delta` with one object + `--page-events` events.

Each direction is timed as a tight loop of `--ops` calls per sample, repeated
`--samples` times (after a JIT warm-up), so the per-op cost is amortized over a
measurable batch and you get a percentile distribution of batch timings.

```bash
# Defaults (2000 ops/sample, 30 samples, 32 events per page/delta):
pnpm bench:codec

# Custom, pretty JSON:
pnpm bench:codec --ops 5000 --samples 50 --page-events 64 --pretty
```

### Flags (env fallbacks in parentheses)

| Flag | Meaning | Env |
| --- | --- | --- |
| `--ops N` | encode/decode calls per timed sample | `FRICK_CODEC_OPS` |
| `--samples N` | timed samples per direction per payload | `FRICK_CODEC_SAMPLES` |
| `--page-events N` | packed events in the `streamPage`/`delta` shapes | `FRICK_CODEC_PAGE_EVENTS` |
| `--pretty` | indent the JSON output | — |

### Output shape

```jsonc
{
  "schemaVersion": 1,
  "tool": "frick-codec-bench",
  "startedAt": "2026-06-07T00:00:00.000Z",
  "config": { "ops": 2000, "samples": 30, "pageEvents": 32 },
  "env": { "node": "v24.x", "platform": "darwin" },
  "totalDurationMs": 123.45,
  "payloads": {
    "appendMessage": {
      "bytes": 235,
      "encode": { "operations": 60000, "bytes": 235, "perOpMicros": { /* … */ }, "opsPerSec": 0, "bytesPerSec": 0 },
      "decode": { /* … */ }
    },
    "objectUpsert": { /* … */ },
    "streamPage":   { /* … */ },
    "delta":        { /* … */ }
  }
}
```

```ts
import { runCodec } from "@fricken/bench";
const result = runCodec({ ops: 1000, samples: 10 });
```

### Cross-platform parity (Swift + Kotlin)

The same four payload shapes are benchmarked natively so results are
comparable across platforms. These run inside the existing native test gates
(no JMH or other heavy tooling) and **report** timing to stdout rather than
asserting an absolute speed (machine-dependent); they assert only that the
work completes and round-trips:

```bash
# Swift — Tests/FrickSwiftTests/FrickCodecBenchmarkTests.swift
cd packages/swift && swift test --filter FrickCodecBenchmarkTests

# Kotlin — apps/android/frick/.../FrickCodecBenchmarkTest.kt
cd apps/android && ./gradlew :frick:testDebugUnitTest --tests "dev.frick.client.FrickCodecBenchmarkTest"
```

Each prints lines like `[FR-99 codec] swift encode appendMessage: 235 bytes,
2.8 us/op, 354668 ops/sec`. The encoded byte sizes line up with the TS suite
(e.g. `appendMessage` 235 bytes, `objectUpsert` 178 bytes), confirming the
shapes are equivalent on the wire across TS / Swift / Kotlin.

## Performance budgets + trend tracking (FR-100)

The `budget` subcommand turns the measurement suites into a pass/fail gate. A
**budget** is a declarative set of thresholds over named metrics extracted from
the latency/throughput JSON results — a p99 latency ceiling per path, a minimum
sustained throughput, a memory-growth ceiling. The checker runs only the suites
a budget references (once each), pulls each metric out of the suite result by a
dot-path, judges it against its threshold, and emits a single machine-readable
PASS/FAIL verdict (`tool: "frick-budget-check"`). A missing metric fails closed.

It also records each verdict for **trend tracking**: every run appends one
NDJSON line to a history file, and the run reports per-metric deltas (signed +
percent change) against the most-recent prior entry. The first run just
establishes a baseline (null deltas).

```bash
# Check the built-in default budget; append to bench/.perf-history.ndjson and
# print the verdict (+ baseline deltas once history exists). Exits non-zero on FAIL.
pnpm bench:budget

# Non-blocking / opt-in CI mode: always exit 0, attach CI metadata, custom history file.
pnpm bench:budget --no-fail --history ci-history.ndjson --meta commit=$GITHUB_SHA --pretty

# Just judge, don't record:
pnpm bench:budget --no-history
```

### Flags

| Flag | Meaning |
| --- | --- |
| `--history PATH` | NDJSON trend-history file (default `bench/.perf-history.ndjson`, git-ignored) |
| `--no-history` | judge only; do not append to the history file |
| `--no-fail` | always exit 0 even on a FAILED budget (for non-blocking CI) |
| `--meta key=value` | attach metadata to the history entry (repeatable, e.g. commit sha) |
| `--pretty` | indent the JSON output |

### Verdict shape

```jsonc
{
  "schemaVersion": 1,
  "tool": "frick-budget-check",
  "budget": "frick-default",
  "startedAt": "2026-06-07T00:00:00.000Z",
  "env": { "node": "v24.x", "platform": "darwin" },
  "totalDurationMs": 1234.5,
  "pass": true,
  "metrics": [
    { "id": "latency.wsAppend.p99", "suite": "latency", "path": "paths.wsAppend.latencyMs.p99",
      "comparison": "max", "threshold": 250, "unit": "ms", "value": 4.3, "pass": true }
    // …
  ],
  "summary": { "total": 6, "passed": 6, "failed": 0 },
  // present unless --no-history: per-metric deltas vs. the latest prior history entry
  "baselineComparison": {
    "budget": "frick-default", "baselineAt": "2026-06-06T…",
    "deltas": [ { "id": "latency.wsAppend.p99", "baseline": 4.0, "current": 4.3, "delta": 0.3, "pctChange": 0.075 } ]
  }
}
```

The built-in `DEFAULT_BUDGET` ships **loose, sane initial thresholds** —
generous enough not to flake on shared CI runners while still catching gross
regressions. The point is the mechanism; tune the numbers over time against the
recorded trend history.

### CI

The `ts` job in `.github/workflows/ci.yml` has an **opt-in, non-blocking**
budget step. It runs only on a manual `workflow_dispatch` with
`run_perf_budget=true`, uses `--no-fail` + `continue-on-error`, and uploads the
verdict JSON + NDJSON history as an artifact. It is intentionally kept off the
PR/push path (shared runners are too noisy for a meaningful latency gate);
promote it to a blocking gate once thresholds are tuned against history.

### Programmatic use

```ts
import {
  runBudgetCheck, DEFAULT_BUDGET, appendHistory, readHistory, compareToBaseline,
} from "@fricken/bench";

const verdict = await runBudgetCheck(DEFAULT_BUDGET);
const baseline = (await readHistory("history.ndjson")).at(-1) ?? null;
const trend = compareToBaseline(verdict, baseline);
await appendHistory("history.ndjson", verdict, { commit: "abc123" });
```
