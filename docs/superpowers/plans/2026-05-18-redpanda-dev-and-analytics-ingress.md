# Redpanda Dev and Analytics Ingress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first standard Redpanda-backed Frick local runtime profile and the first authenticated product analytics ingestion surface.

**Architecture:** Keep deployment infrastructure outside app source code. The CLI exposes a JSON-first `frick dev --profile sqlite|redpanda` command that either prints a runnable plan or starts Docker Compose for the Redpanda profile. Product analytics enters the existing platform event pipeline through one authenticated server route and one TypeScript client helper.

**Tech Stack:** pnpm monorepo, TypeScript, Vitest, Docker Compose, Redpanda/Kafka, existing platform event pipeline.

---

## File Structure

- `ops/local/redpanda.compose.yaml`: local Redpanda service definition used by the CLI and humans.
- `apps/cli/src/commands/dev.ts`: JSON-first CLI command for local Frick runtime profiles.
- `apps/cli/src/index.ts`: register the `dev` command.
- `apps/cli/tests/cli.test.ts`: black-box CLI tests for help, dry-run, and invalid profile behavior.
- `apps/server/src/server.ts`: authenticated analytics event route that publishes `analytics.user_event` platform events.
- `apps/server/tests/analytics-events.test.ts`: server route tests for auth, tenant scoping, payload validation, and idempotency.
- `packages/core/src/analytics.ts`: UI-agnostic `trackAnalyticsEvent(...)` helper.
- `packages/core/src/runtime.ts`: `FrickClient.track(...)` convenience method.
- `packages/core/src/index.ts`: export analytics helper.
- `packages/core/tests/analytics.test.ts`: core helper tests.
- `packages/react/src/analytics.tsx`: `useTrackEvent()` React hook.
- `packages/react/src/index.tsx`: export React hook.
- `packages/react/src/index.test.tsx`: provider/hook auth wiring test if needed.
- `apps/cli/README.md`, `docs/operations.md`, `docs/status.md`, `CHANGELOG.md`: public docs for runtime profiles and analytics ingress.

## Task 1: Standard Redpanda Local Runtime Profile

- [ ] **Step 1: Write failing CLI tests**

Add tests in `apps/cli/tests/cli.test.ts`:

```ts
describe("frick dev", () => {
  it("appears in top-level help", async () => {
    const result = await runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    const body = parseFirstJson(result.stdout) as { commands: Array<{ name: string }> };
    expect(body.commands.map((command) => command.name)).toContain("dev");
  });

  it("prints the Redpanda profile plan without starting Docker", async () => {
    const result = await runCli(["dev", "--profile", "redpanda", "--dry-run"]);
    expect(result.exitCode).toBe(0);
    const body = parseFirstJson(result.stdout) as {
      ok: boolean;
      command: string;
      profile: string;
      composeFile: string;
      env: Record<string, string>;
      steps: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.command).toBe("dev");
    expect(body.profile).toBe("redpanda");
    expect(body.composeFile).toContain("ops/local/redpanda.compose.yaml");
    expect(body.env.FRICK_PLATFORM_EVENTS_DRIVER).toBe("kafka");
    expect(body.env.FRICK_PLATFORM_EVENTS_KAFKA_BROKERS).toBe("127.0.0.1:19092");
    expect(body.steps).toContain("docker compose up -d redpanda");
  });

  it("rejects unknown dev profiles", async () => {
    const result = await runCli(["dev", "--profile", "nope", "--dry-run"]);
    expect(result.exitCode).toBe(2);
    const err = parseLastJson(result.stderr) as { error: { code: string; message: string } };
    expect(err.error.code).toBe("cli.usage");
    expect(err.error.message).toContain("--profile");
  });
});
```

- [ ] **Step 2: Run tests red**

Run:

```bash
pnpm --filter @frick/cli test -- tests/cli.test.ts
```

Expected: FAIL because `dev` is not registered.

- [ ] **Step 3: Add Redpanda Compose file**

Create `ops/local/redpanda.compose.yaml`:

```yaml
name: frick-local-redpanda

services:
  redpanda:
    image: docker.redpanda.com/redpandadata/redpanda:v24.3.7
    command:
      - redpanda
      - start
      - --overprovisioned
      - --smp=1
      - --memory=512M
      - --reserve-memory=0M
      - --node-id=0
      - --check=false
      - --kafka-addr=internal://0.0.0.0:9092,external://0.0.0.0:19092
      - --advertise-kafka-addr=internal://redpanda:9092,external://127.0.0.1:19092
    ports:
      - "19092:19092"
      - "19644:9644"
    healthcheck:
      test: ["CMD-SHELL", "rpk cluster health | grep -q 'Healthy:.*true'"]
      interval: 5s
      timeout: 5s
      retries: 12
```

- [ ] **Step 4: Implement `frick dev`**

Create `apps/cli/src/commands/dev.ts` with:

- `--profile sqlite|redpanda`, default `sqlite`
- `--dry-run` to emit a plan without spawning Docker
- for `redpanda`, spawn `docker compose -f ops/local/redpanda.compose.yaml up -d redpanda`
- emit JSON with profile, env, compose file, steps, and started flag
- do not start server/web yet; document that users run `FRICK_PLATFORM_EVENTS_KAFKA_BROKERS=127.0.0.1:19092 pnpm server` after the profile starts

Register it in `apps/cli/src/index.ts`.

- [ ] **Step 5: Run CLI tests green**

Run:

```bash
pnpm --filter @frick/cli test -- tests/cli.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ops/local/redpanda.compose.yaml apps/cli/src/commands/dev.ts apps/cli/src/index.ts apps/cli/tests/cli.test.ts
git commit -m "feat(cli): add redpanda dev profile"
```

## Task 2: Authenticated Analytics Ingestion Route

- [ ] **Step 1: Write failing server route tests**

Create `apps/server/tests/analytics-events.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { createFrickServer } from "../src/server.js";

let app: ReturnType<typeof createFrickServer> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("analytics event ingestion", () => {
  it("requires auth", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/analytics/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "screen.viewed" }),
    });
    expect(response.status).toBe(401);
  });

  it("publishes a tenant-scoped platform analytics event", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada", tenantId: "tenant-analytics" });
    const response = await fetch(`${app.httpUrl}/analytics/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${login.sessionToken}` },
      body: JSON.stringify({
        name: "screen.viewed",
        properties: { route: "/dashboard", count: 1, beta: true },
        idempotencyKey: "screen-view-1",
      }),
    });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.ok).toBe(true);

    const [delivery] = await app.platformEvents.claim("analytics-test");
    expect(delivery?.event).toMatchObject({
      family: "analytics.user_event",
      name: "screen.viewed",
      source: "frick.analytics",
      tenantId: "tenant-analytics",
      subjectId: "user-ada",
      idempotencyKey: "screen-view-1",
      payload: { properties: { route: "/dashboard", count: 1, beta: true } },
    });
  });
});
```

- [ ] **Step 2: Implement route**

In `apps/server/src/server.ts`, after protected principal resolution and before app data routes, add:

- `POST /analytics/events`
- read body with tenant limits
- require `name` string
- optional `properties` object, `occurredAt`, `idempotencyKey`, `traceId`
- call `platformEvents.publish({ family: "analytics.user_event", name, source: "frick.analytics", tenantId: principal.tenantId, subjectId: principal.userId, ... })`
- respond `202` with `{ ok, eventId, duplicate }`
- rely on platform event validation for event-name and payload JSON object validation

- [ ] **Step 3: Run server tests**

Run:

```bash
pnpm --filter @frick/server exec vitest run tests/analytics-events.test.ts tests/platform-events-runtime.test.ts tests/platform-events-routes.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/server.ts apps/server/tests/analytics-events.test.ts
git commit -m "feat(server): ingest product analytics events"
```

## Task 3: TypeScript Client Analytics API

- [ ] **Step 1: Write failing core tests**

Create `packages/core/tests/analytics.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { trackAnalyticsEvent } from "../src/analytics.js";

describe("trackAnalyticsEvent", () => {
  it("posts to /analytics/events with bearer auth", async () => {
    const calls: Array<{ input: URL; init?: RequestInit }> = [];
    await trackAnalyticsEvent({
      httpEndpoint: "http://127.0.0.1:4099/",
      sessionToken: "session-token",
      name: "screen.viewed",
      properties: { route: "/" },
      fetchImpl: async (input, init) => {
        calls.push({ input: input as URL, init });
        return new Response(JSON.stringify({ ok: true, eventId: "evt-1", duplicate: false }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      },
    });
    expect(calls[0]?.input.toString()).toBe("http://127.0.0.1:4099/analytics/events");
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: "Bearer session-token",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      name: "screen.viewed",
      properties: { route: "/" },
    });
  });
});
```

- [ ] **Step 2: Implement helper and client method**

Create `packages/core/src/analytics.ts`:

- export `TrackAnalyticsEventOptions`
- export `TrackAnalyticsEventResult`
- export `trackAnalyticsEvent(options)`

Add `FrickClient.track(name, properties?, options?)` to `packages/core/src/runtime.ts`, using the client HTTP endpoint/session token and global `fetch`.

Export from `packages/core/src/index.ts`.

- [ ] **Step 3: Add React hook**

Create `packages/react/src/analytics.tsx`:

```ts
import { useCallback } from "react";
import { useFrick } from "./index.js";

export function useTrackEvent() {
  const client = useFrick();
  return useCallback(
    (name: string, properties?: Record<string, unknown>) => client.track(name, properties),
    [client],
  );
}
```

Export it from `packages/react/src/index.tsx`.

- [ ] **Step 4: Run client tests**

Run:

```bash
pnpm --filter @frick/core test -- tests/analytics.test.ts tests/runtime.test.ts
pnpm --filter @frick/react test -- src/index.test.tsx
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/analytics.ts packages/core/src/runtime.ts packages/core/src/index.ts packages/core/tests/analytics.test.ts packages/react/src/analytics.tsx packages/react/src/index.tsx
git commit -m "feat(core): add product analytics tracking helper"
```

## Task 4: Docs, Review, and Verification

- [ ] **Step 1: Update docs**

Update:

- `apps/cli/README.md` with `frick dev --profile redpanda --dry-run`
- `docs/operations.md` with Redpanda profile, live Kafka conformance command, and `POST /analytics/events`
- `docs/status.md` stable surface for initial analytics ingress
- `CHANGELOG.md` under CLI/server/client bullets

- [ ] **Step 2: Run final checks**

Run:

```bash
pnpm test
pnpm typecheck
pnpm verify:generated
git diff --check
```

Expected: PASS.

- [ ] **Step 3: Final review and commit**

Ask for subagent spec/code-quality review. Try `claude -p` if local auth works. Commit:

```bash
git add apps/cli/README.md docs/operations.md docs/status.md CHANGELOG.md
git commit -m "docs: document redpanda dev and analytics ingress"
```

