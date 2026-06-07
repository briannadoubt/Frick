# `@fricken/bench` — Load harness (FR-96)

A reusable synthetic load harness for Frick. It drives configurable load against
a Frick server and emits a single machine-readable JSON result to stdout so CI
and trend tooling can consume it. This is the foundation for the later benchmark
stories (FR-97–100) — it is reusable, not a one-off.

It is kept deliberately separate from the correctness tests: the harness only
**measures** throughput/latency and never asserts product behavior.

## What it does

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

## Running

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

## Output shape

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

## Programmatic use

```ts
import { runLoad, parseLoadConfig } from "@fricken/bench";

const result = await runLoad({ users: 5, appendsPerUser: 10 });
```
