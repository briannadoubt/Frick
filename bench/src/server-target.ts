import { WebSocket } from "ws";
import {
  FrameKind,
  decodeFrame,
  encodeFrame,
  productTestSchema,
  type FrickFrame,
  type FrickSchema,
} from "@fricken/protocol";
import { createFrickServer, createNoopLogger } from "@fricken/server";

/**
 * Shared server-spin-up + WS utilities for the benchmark suites (FR-97/FR-98).
 *
 * The FR-96 {@link runLoad} harness spins a server up privately and never hands
 * the caller its `store`. The latency (FR-97) and throughput/resource-growth
 * (FR-98) suites both need richer access — FR-97 awaits specific response
 * frames to measure round-trips, and FR-98 samples the live `store` for
 * DB/cache growth. This module centralizes that plumbing so neither suite
 * re-implements server boot, dev-login, or the Hello handshake.
 *
 * All correctness checks live in the regular test suites; these helpers only
 * support measurement and never assert product behavior.
 */

export type FrickServerHandle = ReturnType<typeof createFrickServer>;

export interface BenchTarget {
  readonly httpUrl: string;
  readonly wsUrl: string;
  /**
   * The in-process server handle, present only when this module spun one up.
   * FR-98 uses it to sample `store` resource gauges; FR-97 ignores it.
   */
  readonly server?: FrickServerHandle;
  /** Tear down the in-process server, if any. Idempotent. */
  close(): Promise<void>;
}

/**
 * Resolve a {@link BenchTarget}: either an externally-provided origin, or a
 * freshly-booted in-process server on an ephemeral port backed by an in-memory
 * SQLite store. The server's structured logger is silenced so stdout stays
 * reserved for the suite's single JSON result.
 */
export async function resolveTarget(
  external: { readonly httpUrl: string; readonly wsUrl: string } | undefined,
  schema: FrickSchema,
): Promise<BenchTarget> {
  if (external) {
    return {
      httpUrl: external.httpUrl,
      wsUrl: external.wsUrl,
      async close() {
        // External server is owned by the caller; nothing to tear down.
      },
    };
  }

  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    schema,
    logger: createNoopLogger(),
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind an ephemeral port");
  }
  const httpUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}/_frick/sync`;
  return {
    httpUrl,
    wsUrl,
    server,
    async close() {
      await server.close();
    },
  };
}

export interface DevLoginResult {
  readonly sessionToken: string;
  readonly tenantId: string;
}

export async function devLogin(httpUrl: string, userId: string): Promise<DevLoginResult> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (response.status !== 200) {
    throw new Error(`dev-login failed for ${userId}: HTTP ${response.status}`);
  }
  return (await response.json()) as DevLoginResult;
}

/** Resolve once the next frame of `kind` arrives; rejects on `timeoutMs`. */
export function waitForFrameKind(
  socket: WebSocket,
  kind: FrameKind,
  timeoutMs = 5000,
): Promise<FrickFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`timed out waiting for frame kind ${kind}`));
    }, timeoutMs);
    const onMessage = (data: Buffer) => {
      const frame = decodeFrame(data);
      if (frame[0] === kind) {
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(frame);
      }
    };
    socket.on("message", onMessage);
  });
}

/**
 * Resolve once an Ack/Nack frame matching `requestId` arrives. Used to time
 * append/upsert round-trips (send → durable confirmation). Rejects on timeout
 * or on a Nack for the request.
 */
export function waitForAck(
  socket: WebSocket,
  requestId: string,
  timeoutMs = 5000,
): Promise<FrickFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`timed out waiting for ack ${requestId}`));
    }, timeoutMs);
    const onMessage = (data: Buffer) => {
      const frame = decodeFrame(data);
      const [kind, payload] = frame;
      if (
        (kind === FrameKind.Ack || kind === FrameKind.Nack) &&
        (payload as { requestId?: string })?.requestId === requestId
      ) {
        clearTimeout(timer);
        socket.off("message", onMessage);
        if (kind === FrameKind.Nack) {
          reject(new Error(`nack for ${requestId}`));
          return;
        }
        resolve(frame);
      }
    };
    socket.on("message", onMessage);
  });
}

export interface ConnectedSocket {
  readonly socket: WebSocket;
  /** Wall-clock ms from `new WebSocket` to draining HelloAck + Schema. */
  readonly connectMs: number;
}

/**
 * Open a WS connection, send Hello, and drain the HelloAck. Returns the ready
 * socket plus the measured connect+handshake latency. Defaults the product
 * test schema fixture.
 */
export async function connectAndHello(
  wsUrl: string,
  sessionToken: string,
  schema: FrickSchema = productTestSchema,
  replicaId = "bench-replica",
): Promise<ConnectedSocket> {
  const start = performance.now();
  const socket = new WebSocket(wsUrl, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const helloAck = waitForFrameKind(socket, FrameKind.HelloAck);
  socket.send(
    encodeFrame([
      FrameKind.Hello,
      {
        replicaId,
        deviceId: "bench-device",
        schemaHash: schema.hash,
        knownCursors: {},
      },
    ]),
  );
  await helloAck;
  return { socket, connectMs: performance.now() - start };
}

export function closeSocket(socket: WebSocket): void {
  try {
    socket.close();
  } catch {
    // ignore
  }
}
