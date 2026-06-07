import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  FrameKind,
  decodeFrame,
  encodeFrame,
  foundationSchema,
  type FrickFrame,
  type HelloAckPayload,
} from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";

// FR-32: server-side device binding for sessions.
//
// The Principal's deviceId/replicaId are always derived from the
// `auth_sessions` row (never the client). This suite covers the *opt-in*
// re-auth-on-device-change enforcement at the Hello handshake:
//   - default OFF: a token presented from a different device still connects
//     (existing FrickSwift/web behavior is unchanged);
//   - flag ON: a Hello whose deviceId/replicaId differs from the session's
//     bound values is rejected with `auth.unauthenticated` and the socket is
//     closed (1008) so the client re-authenticates; a matching device still
//     connects.

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const BOUND_DEVICE = { deviceId: "device-bound", replicaId: "replica-bound" };
const OTHER_DEVICE = { deviceId: "device-other", replicaId: "replica-other" };

describe("FR-32 server-side device binding (opt-in)", () => {
  it("default OFF: a token presented from a different device still connects", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada", ...BOUND_DEVICE });

    // Hello advertises a *different* device than the session is bound to.
    const result = await connectAndHello(app.url, login.sessionToken, OTHER_DEVICE);
    expect(result.kind).toBe("open");
    if (result.kind === "open") result.socket.close();
  });

  it("flag ON: a matching device still connects", async () => {
    app = await startServer({ limits: { bindSessionDevice: true } });
    const login = await devLogin(app.httpUrl, { userId: "user-ada", ...BOUND_DEVICE });

    const result = await connectAndHello(app.url, login.sessionToken, BOUND_DEVICE);
    expect(result.kind).toBe("open");
    if (result.kind === "open") result.socket.close();
  });

  it("flag ON: a mismatched device is rejected and the socket is closed", async () => {
    app = await startServer({ limits: { bindSessionDevice: true } });
    const login = await devLogin(app.httpUrl, { userId: "user-ada", ...BOUND_DEVICE });

    const result = await connectAndHello(app.url, login.sessionToken, OTHER_DEVICE);
    expect(result.kind).toBe("nack");
    if (result.kind === "nack") {
      expect(result.frame[0]).toBe(FrameKind.Nack);
      expect(result.frame[1]).toMatchObject({
        requestId: "hello",
        code: "auth.unauthenticated",
      });
      expect(result.frame[1].error).toMatchObject({
        details: { reason: "sessionDeviceMismatch" },
      });
      // The connection is force-closed so the client re-authenticates.
      await expect(withTimeout(onceClosed(result.socket), "expected mismatch to close socket")).resolves.toEqual({
        code: 1008,
      });
    }
  });

  it("flag ON: a mismatched replicaId (same deviceId) is rejected", async () => {
    app = await startServer({ limits: { bindSessionDevice: true } });
    const login = await devLogin(app.httpUrl, { userId: "user-ada", ...BOUND_DEVICE });

    const result = await connectAndHello(app.url, login.sessionToken, {
      deviceId: BOUND_DEVICE.deviceId,
      replicaId: "replica-different",
    });
    expect(result.kind).toBe("nack");
    if (result.kind === "nack") {
      expect(result.frame[1]).toMatchObject({ requestId: "hello", code: "auth.unauthenticated" });
    }
  });
});

async function startServer(options: { limits?: Record<string, unknown> } = {}) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    ...(options.limits ? { limits: options.limits } : {}),
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    url: `ws://127.0.0.1:${address.port}/_frick/sync`,
    httpUrl: `http://127.0.0.1:${address.port}`,
    store: server.store,
    close: server.close,
  };
}

type HelloResult =
  | { kind: "open"; socket: WebSocket; ack: HelloAckPayload }
  | { kind: "nack"; socket: WebSocket; frame: FrickFrame };

/**
 * Connect over the WS Authorization header, send a Hello advertising the given
 * device identity, and resolve with either the HelloAck (success) or the first
 * Nack frame (rejection). Mirrors the harness in `ws-authz.test.ts`.
 */
async function connectAndHello(
  url: string,
  sessionToken: string,
  device: { deviceId: string; replicaId: string },
): Promise<HelloResult> {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${sessionToken}` } });
  await new Promise<void>((resolve) => socket.once("open", resolve));

  return await new Promise<HelloResult>((resolve, reject) => {
    const frames: FrickFrame[] = [];
    const onMessage = (data: Buffer) => {
      const frame = decodeFrame(data);
      if (frame[0] === FrameKind.Nack) {
        socket.off("message", onMessage);
        resolve({ kind: "nack", socket, frame });
        return;
      }
      frames.push(frame);
      // Success path: HelloAck followed by the schema frame.
      if (frames.length === 2) {
        socket.off("message", onMessage);
        resolve({ kind: "open", socket, ack: frames[0]![1] as HelloAckPayload });
      }
    };
    socket.on("message", onMessage);
    socket.once("error", reject);
    socket.send(
      encodeFrame([
        FrameKind.Hello,
        {
          replicaId: device.replicaId,
          deviceId: device.deviceId,
          schemaHash: foundationSchema.hash,
          knownCursors: {},
          sessionToken,
        },
      ]),
    );
  });
}

async function onceClosed(socket: WebSocket): Promise<{ code: number }> {
  return new Promise((resolve) => {
    socket.once("close", (code) => resolve({ code }));
  });
}

async function withTimeout<T>(promise: Promise<T>, message: string, timeoutMs = 2000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(message)), timeoutMs)),
  ]);
}

async function devLogin(
  httpUrl: string,
  body: { userId: string; tenantId?: string; deviceId?: string; replicaId?: string; platform?: string },
): Promise<{ sessionToken: string; deviceId: string; replicaId: string }> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { sessionToken: string; deviceId: string; replicaId: string };
}
