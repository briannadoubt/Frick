#!/usr/bin/env tsx
/**
 * End-to-end smoke test for Frick.
 *
 * Spins up a real server backed by a disk-backed SQLite database (not
 * :memory:), drives it through the HTTP + WebSocket surface that an
 * operator would touch on day one, then restarts the server against
 * the same database and re-checks that everything survives the
 * restart.
 *
 * Exercises gaps the unit tests don't cover:
 *   - 12 migrations applying cleanly to a fresh on-disk SQLite file
 *   - Server lifecycle on a real port (not in-process binding only)
 *   - Auth flow producing a session that survives across requests
 *   - HTTP append + stream read + inbox projection
 *   - WebSocket Hello / HelloAck / Schema / Subscribe / Delta round-trip
 *   - Graceful shutdown
 *   - Cold start against an existing DB: no migration re-run, no data loss
 *
 * Emits JSON Lines per check to stdout; exits 0 on full success and 1
 * with a final summary line on first failure.
 *
 * Run: `pnpm exec tsx scripts/e2e-smoke.ts`
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  FrameKind,
  decodeFrame,
  defaultClientCapabilities,
  encodeFrame,
  foundationSchema,
  type FrickFrame,
} from "../packages/protocol/src/index.js";
import { createFrickServer } from "../apps/server/src/server.js";

type StepResult =
  | { step: string; status: "ok"; detail?: Record<string, unknown> }
  | { step: string; status: "failed"; error: string; detail?: Record<string, unknown> };

const results: StepResult[] = [];
function record(step: string, fn: () => Promise<Record<string, unknown> | void> | Record<string, unknown> | void): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then((detail) => {
      const entry: StepResult = detail
        ? { step, status: "ok", detail }
        : { step, status: "ok" };
      results.push(entry);
      process.stdout.write(`${JSON.stringify(entry)}\n`);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const entry: StepResult = { step, status: "failed", error: message };
      results.push(entry);
      process.stdout.write(`${JSON.stringify(entry)}\n`);
      throw err;
    });
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // leave as string
  }
  return { status: response.status, body };
}

interface ServerHandle {
  port: number;
  baseUrl: string;
  wsUrl: string;
  close(): Promise<void>;
}

async function bootServer(dbPath: string): Promise<ServerHandle> {
  const server = createFrickServer({
    port: 0,
    dbPath,
    config: { env: "development" as const },
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind a port");
  }
  const port = address.port;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/_frick/sync`,
    async close() {
      await server.close();
    },
  };
}

/**
 * Frame queue for a WebSocket. Attaches a permanent listener at open
 * time so frames that arrive before `next()` is called are buffered
 * rather than dropped. This is what bites you when you write WS
 * tests against Node's spec-compliant WebSocket: it doesn't buffer
 * messages for you the way `ws`'s EventEmitter `.on('message')` does
 * if you attach quickly enough.
 */
function createFrameQueue(socket: WebSocket): { next(timeoutMs?: number): Promise<FrickFrame>; close(): void } {
  const buffered: FrickFrame[] = [];
  const waiters: Array<(frame: FrickFrame) => void> = [];
  let lastError: Error | undefined;

  const onMessage = (event: MessageEvent): void => {
    try {
      const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : (event.data as Uint8Array);
      const frame = decodeFrame(bytes);
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else buffered.push(frame);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  };
  const onError = (event: Event): void => {
    lastError = new Error(`WS error: ${(event as ErrorEvent).message ?? "unknown"}`);
  };
  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);

  return {
    next(timeoutMs = 2000): Promise<FrickFrame> {
      if (buffered.length > 0) return Promise.resolve(buffered.shift()!);
      if (lastError) return Promise.reject(lastError);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(resolve);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error("timeout waiting for WS frame"));
        }, timeoutMs);
        waiters.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      });
    },
    close(): void {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
    },
  };
}

async function main(): Promise<void> {
  const tmpRoot = mkdtempSync(join(tmpdir(), "frick-e2e-"));
  const dbPath = join(tmpRoot, "smoke.sqlite");
  let server: ServerHandle | undefined;
  let sessionToken = "";
  let appendedEventId = "";

  try {
    // ─── Phase 1: fresh server ───
    await record("phase1.boot", async () => {
      server = await bootServer(dbPath);
      return { port: server.port, dbPath };
    });

    await record("phase1.health", async () => {
      const r = await fetchJson(`${server!.baseUrl}/health`);
      if (r.status !== 200) throw new Error(`/health returned ${r.status}`);
      return { status: r.status };
    });

    await record("phase1.ready", async () => {
      const r = await fetchJson(`${server!.baseUrl}/ready`);
      if (r.status !== 200) throw new Error(`/ready returned ${r.status}: ${JSON.stringify(r.body)}`);
      const body = r.body as { appliedMigrations: number; schemaRevision: number };
      if (body.appliedMigrations !== 12) throw new Error(`expected 12 migrations, got ${body.appliedMigrations}`);
      return { appliedMigrations: body.appliedMigrations, schemaRevision: body.schemaRevision };
    });

    await record("phase1.devlogin", async () => {
      const r = await fetchJson(`${server!.baseUrl}/auth/dev-login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "user-ada" }),
      });
      if (r.status !== 200) throw new Error(`dev-login returned ${r.status}: ${JSON.stringify(r.body)}`);
      const body = r.body as { sessionToken: string; userId: string };
      sessionToken = body.sessionToken;
      return { userId: body.userId };
    });

    await record("phase1.append_http", async () => {
      const r = await fetchJson(`${server!.baseUrl}/append`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({
          requestId: "e2e-request-1",
          stream: "MessageStream",
          key: "conversation-general",
          event: "MessageSent",
          payload: {
            messageId: "e2e-msg-1",
            senderId: "user-ada",
            body: "hello from e2e smoke phase 1",
            createdAt: new Date().toISOString(),
          },
        }),
      });
      if (r.status !== 200) throw new Error(`append returned ${r.status}: ${JSON.stringify(r.body)}`);
      const body = r.body as { event: { eventId: string; sequence: number } };
      appendedEventId = body.event.eventId;
      return { eventId: body.event.eventId, sequence: body.event.sequence };
    });

    await record("phase1.stream_read_http", async () => {
      const r = await fetchJson(
        `${server!.baseUrl}/streams/MessageStream/conversation-general`,
        { headers: { authorization: `Bearer ${sessionToken}` } },
      );
      if (r.status !== 200) throw new Error(`stream read returned ${r.status}`);
      const body = r.body as { data: Array<{ eventId: string }> };
      const found = body.data.some((e) => e.eventId === appendedEventId);
      if (!found) throw new Error(`appended event ${appendedEventId} not in stream`);
      return { eventCount: body.data.length, found };
    });

    await record("phase1.inbox_projection", async () => {
      // The /inbox route only returns the requesting principal's own rows
      // (correct tenant + principal isolation). user-ada appended the
      // message above, so she should see her own inbox row for the
      // conversation she belongs to.
      const r = await fetchJson(
        `${server!.baseUrl}/inbox?userId=user-ada`,
        { headers: { authorization: `Bearer ${sessionToken}` } },
      );
      if (r.status !== 200) throw new Error(`inbox returned ${r.status}: ${JSON.stringify(r.body)}`);
      const body = r.body as { data: Array<{ conversationId: string; lastSequence: number }> };
      const general = body.data.find((row) => row.conversationId === "conversation-general");
      if (!general) throw new Error("no inbox row for conversation-general");
      return { rowCount: body.data.length, generalLastSequence: general.lastSequence };
    });

    await record("phase1.inspect_db", async () => {
      const r = await fetchJson(`${server!.baseUrl}/_frick/inspect/db`, {
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      if (r.status !== 200) throw new Error(`/_frick/inspect/db returned ${r.status}`);
      const body = r.body as { ready: boolean; applied: number; idempotencyCache: { size: number } };
      if (!body.ready) throw new Error("/_frick/inspect/db reports not ready");
      if (body.applied !== 12) throw new Error(`expected 12 applied, got ${body.applied}`);
      return { applied: body.applied, idempotencyCacheSize: body.idempotencyCache.size };
    });

    // WS round-trip: connect, Hello, expect HelloAck + Schema, subscribe,
    // expect StreamPage, append via HTTP, expect Delta.
    await record("phase1.ws_roundtrip", async () => {
      const ws = new WebSocket(server!.wsUrl);
      ws.binaryType = "arraybuffer";
      const queue = createFrameQueue(ws);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener(
          "error",
          (e) => reject(new Error(`open failed: ${(e as ErrorEvent).message ?? "unknown"}`)),
          { once: true },
        );
      });

      ws.send(
        encodeFrame([
          FrameKind.Hello,
          {
            replicaId: "e2e-replica",
            deviceId: "e2e-device",
            sessionToken,
            schemaHash: foundationSchema.hash,
            knownCursors: {},
            clientCapabilities: defaultClientCapabilities({
              platform: "test",
              sdkVersion: "0.0.0-e2e",
              schema: foundationSchema,
            }),
          },
        ]),
      );

      const helloAck = await queue.next();
      if (helloAck[0] !== FrameKind.HelloAck) throw new Error(`expected HelloAck, got ${helloAck[0]}`);
      const schemaFrame = await queue.next();
      if (schemaFrame[0] !== FrameKind.Schema) throw new Error(`expected Schema, got ${schemaFrame[0]}`);

      ws.send(
        encodeFrame([
          FrameKind.Subscribe,
          {
            subscriptionId: "sub-1",
            kind: "stream",
            name: "MessageStream",
            key: "conversation-general",
            cursor: 0,
          },
        ]),
      );

      const page = await queue.next();
      if (page[0] !== FrameKind.StreamPage) {
        throw new Error(`expected StreamPage after subscribe, got ${page[0]}`);
      }

      // Trigger a new append over HTTP; expect a Delta on the WS.
      const appendRes = await fetchJson(`${server!.baseUrl}/append`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({
          requestId: "e2e-request-ws-1",
          stream: "MessageStream",
          key: "conversation-general",
          event: "MessageSent",
          payload: {
            messageId: "e2e-msg-ws-1",
            senderId: "user-ada",
            body: "hello via WS subscribe",
            createdAt: new Date().toISOString(),
          },
        }),
      });
      if (appendRes.status !== 200) throw new Error(`WS-triggered append returned ${appendRes.status}`);

      let sawDelta = false;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const frame = await queue.next(500).catch(() => undefined);
        if (!frame) continue;
        if (frame[0] === FrameKind.Delta) {
          sawDelta = true;
          break;
        }
      }

      if (!sawDelta) throw new Error("did not observe a Delta frame after subscribe + append");

      queue.close();
      ws.close();
      return { sawHelloAck: true, sawSchema: true, sawStreamPage: true, sawDelta };
    });

    await record("phase1.shutdown", async () => {
      await server!.close();
      server = undefined;
      // Give the OS a tick to release the port.
      await sleep(100);
      return { closed: true };
    });

    // ─── Phase 2: cold start against the same DB ───
    await record("phase2.reboot", async () => {
      server = await bootServer(dbPath);
      return { port: server.port };
    });

    await record("phase2.ready_no_remigration", async () => {
      const r = await fetchJson(`${server!.baseUrl}/ready`);
      if (r.status !== 200) throw new Error(`/ready returned ${r.status}: ${JSON.stringify(r.body)}`);
      const body = r.body as { appliedMigrations: number };
      if (body.appliedMigrations !== 12) throw new Error(`expected 12 migrations after reboot, got ${body.appliedMigrations}`);
      return { appliedMigrations: body.appliedMigrations };
    });

    await record("phase2.devlogin_again", async () => {
      const r = await fetchJson(`${server!.baseUrl}/auth/dev-login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "user-ada" }),
      });
      if (r.status !== 200) throw new Error(`dev-login returned ${r.status}`);
      const body = r.body as { sessionToken: string };
      sessionToken = body.sessionToken;
      return {};
    });

    await record("phase2.stream_persisted", async () => {
      const r = await fetchJson(
        `${server!.baseUrl}/streams/MessageStream/conversation-general`,
        { headers: { authorization: `Bearer ${sessionToken}` } },
      );
      if (r.status !== 200) throw new Error(`stream read returned ${r.status}`);
      const body = r.body as { data: Array<{ eventId: string; payload?: { body?: string } }> };
      const phase1Found = body.data.some((e) => e.eventId === appendedEventId);
      const wsAppendFound = body.data.some(
        (e) => e.payload && typeof e.payload.body === "string" && e.payload.body.includes("WS subscribe"),
      );
      if (!phase1Found) throw new Error(`phase 1 append ${appendedEventId} did not survive restart`);
      if (!wsAppendFound) throw new Error(`WS-triggered append did not survive restart`);
      return { eventCount: body.data.length, phase1Found, wsAppendFound };
    });

    await record("phase2.inbox_persisted", async () => {
      const r = await fetchJson(
        `${server!.baseUrl}/inbox?userId=user-ada`,
        { headers: { authorization: `Bearer ${sessionToken}` } },
      );
      if (r.status !== 200) throw new Error(`inbox returned ${r.status}: ${JSON.stringify(r.body)}`);
      const body = r.body as { data: Array<{ conversationId: string; lastSequence: number }> };
      const general = body.data.find((row) => row.conversationId === "conversation-general");
      if (!general) throw new Error("inbox row missing after reboot");
      return { rowCount: body.data.length, generalLastSequence: general.lastSequence };
    });

    await record("phase2.shutdown", async () => {
      await server!.close();
      server = undefined;
      return { closed: true };
    });

    process.stdout.write(`${JSON.stringify({ summary: true, total: results.length, passed: results.length, failed: 0, dbPath })}\n`);
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed = results.filter((r) => r.status === "failed").length;
    process.stdout.write(
      `${JSON.stringify({ summary: true, total: results.length, passed: results.length - failed, failed, dbPath, error: message })}\n`,
    );
    if (server) {
      try {
        await server.close();
      } catch {
        /* best-effort */
      }
    }
    process.exit(1);
  } finally {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

void main();
