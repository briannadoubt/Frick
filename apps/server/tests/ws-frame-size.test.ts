import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  FrameKind,
  decodeFrame,
  encodeFrame,
  foundationSchema,
  type FrickFrame,
} from "@frick/protocol";
import { createFrickServer } from "../src/server.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("websocket inbound frame-size cap", () => {
  it("rejects frames larger than maxWebSocketFrameBytes before application decode", async () => {
    app = await startServer({ limits: { maxWebSocketFrameBytes: 1024 } });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connect(app.url, login.sessionToken);

    const frames: FrickFrame[] = [];
    socket.on("message", (data) => frames.push(decodeFrame(data as Buffer)));
    const closed = new Promise<{ code: number }>((resolve) =>
      socket.once("close", (code) => resolve({ code })),
    );

    // Build an oversized binary payload (2KB > 1024 cap). The contents do not
    // need to be a valid msgpack frame; the size check happens first.
    const oversized = Buffer.alloc(2048, 0xab);
    socket.send(oversized);

    const close = await Promise.race([
      closed,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("socket was not closed")), 2000),
      ),
    ]);
    expect(close).toEqual({ code: 1009 });
    expect(frames).toHaveLength(0);
  });

  it("accepts a frame at exactly the configured limit", async () => {
    // First boot a server just so we can devLogin and learn the real
    // replica/device ids — those determine the exact encoded hello size.
    const probe = await startServer();
    const probeLogin = await devLogin(probe.httpUrl, { userId: "user-ada" });
    await probe.close();

    const helloPayload = {
      replicaId: probeLogin.replicaId,
      deviceId: probeLogin.deviceId,
      schemaHash: foundationSchema.hash,
      knownCursors: {},
    };
    const helloBytes = encodeFrame([FrameKind.Hello, helloPayload]);

    app = await startServer({ limits: { maxWebSocketFrameBytes: helloBytes.byteLength } });
    const login = await devLogin(app.httpUrl, {
      userId: "user-ada",
      deviceId: probeLogin.deviceId,
      replicaId: probeLogin.replicaId,
    });
    const socket = await connect(app.url, login.sessionToken);

    const frames: FrickFrame[] = [];
    socket.on("message", (data) => frames.push(decodeFrame(data as Buffer)));

    socket.send(
      encodeFrame([
        FrameKind.Hello,
        {
          replicaId: login.replicaId,
          deviceId: login.deviceId,
          schemaHash: foundationSchema.hash,
          knownCursors: {},
        },
      ]),
    );
    // Hello triggers HelloAck + Schema frames — confirm no nack.
    await waitForFrameCount(frames, 2);
    expect(frames[0]![0]).toBe(FrameKind.HelloAck);
    expect(frames[1]![0]).toBe(FrameKind.Schema);

    socket.close();
  });

  it("accepts repeated frames slightly under the limit", async () => {
    app = await startServer({ limits: { maxWebSocketFrameBytes: 4096 } });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connect(app.url, login.sessionToken);

    const frames: FrickFrame[] = [];
    socket.on("message", (data) => frames.push(decodeFrame(data as Buffer)));

    socket.send(
      encodeFrame([
        FrameKind.Hello,
        {
          replicaId: login.replicaId,
          deviceId: login.deviceId,
          schemaHash: foundationSchema.hash,
          knownCursors: {},
        },
      ]),
    );
    await waitForFrameCount(frames, 2);

    // Send three pings — each is well under 4096 bytes.
    for (let i = 0; i < 3; i++) {
      socket.send(encodeFrame([FrameKind.Ping, { sentAt: Date.now() + i }]));
    }
    await waitForFrameCount(frames, 5);
    expect(frames.slice(2).every((f) => f[0] === FrameKind.Pong)).toBe(true);

    socket.close();
  });
});

async function startServer(options: { limits?: Parameters<typeof createFrickServer>[0]["limits"] } = {}) {
  const server = createFrickServer({ port: 0, dbPath: ":memory:", ...options });
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

async function connect(url: string, sessionToken?: string): Promise<WebSocket> {
  const socket = new WebSocket(
    url,
    sessionToken ? { headers: { authorization: `Bearer ${sessionToken}` } } : undefined,
  );
  await new Promise<void>((resolve) => socket.once("open", resolve));
  return socket;
}

async function waitForFrameCount(frames: FrickFrame[], target: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (frames.length < target) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${target} frames (got ${frames.length})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function devLogin(
  httpUrl: string,
  body: { userId: string; deviceId?: string; replicaId?: string; platform?: string },
): Promise<{
  schemaHash: string;
  sessionToken: string;
  userId: string;
  deviceId: string;
  replicaId: string;
  expiresAt: string;
}> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    schemaHash: string;
    sessionToken: string;
    userId: string;
    deviceId: string;
    replicaId: string;
    expiresAt: string;
  };
}
