import { WebSocket } from "ws";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FrameKind,
  decodeFrame,
  encodeFrame,
  foundationSchema,
  type FrickFrame,
} from "@frick/protocol";
import { createFrickServer, defaultDatabasePath } from "../src/server.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("foundation sync gateway", () => {
  it("resolves the default database path from the server package", () => {
    const dbPath = defaultDatabasePath();

    expect(path.isAbsolute(dbPath)).toBe(true);
    expect(dbPath.endsWith(path.join("apps", "server", "data", "frick.sqlite"))).toBe(true);
    expect(dbPath).not.toContain(path.join("apps", "server", "apps", "server"));
  });

  it("hard rejects schema hash mismatch", async () => {
    app = await startServer();
    const socket = await connect(app.url);

    socket.send(
      encodeFrame([
        FrameKind.Hello,
        {
          replicaId: "replica-1",
          deviceId: "device-1",
          schemaHash: "wrong",
          knownCursors: {},
        },
      ]),
    );

    const frame = await nextFrame(socket);
    expect(frame[0]).toBe(FrameKind.Nack);
    expect(frame[1].code).toBe("schema_mismatch");
    socket.close();
  });

  it("subscribes to message stream and receives appended events", async () => {
    app = await startServer();
    const socket = await connect(app.url);

    socket.send(
      encodeFrame([
        FrameKind.Hello,
        {
          replicaId: "replica-1",
          deviceId: "device-1",
          schemaHash: foundationSchema.hash,
          knownCursors: {},
        },
      ]),
    );
    await nextFrame(socket);

    socket.send(
      encodeFrame([
        FrameKind.Subscribe,
        {
          subscriptionId: "sub-messages",
          kind: "stream",
          name: "MessageStream",
          key: "conversation-general",
          cursor: 0,
        },
      ]),
    );

    const page = await nextFrame(socket);
    expect(page[0]).toBe(FrameKind.StreamPage);

    const appendFrames = collectFrames(socket, 2);
    socket.send(
      encodeFrame([
        FrameKind.Append,
        {
          requestId: "request-1",
          stream: "MessageStream",
          key: "conversation-general",
          event: "MessageSent",
          payload: {
            messageId: "message-1",
            senderId: "user-ada",
            body: "hello",
            createdAt: "2026-05-09T00:00:00.000Z",
          },
        },
      ]),
    );

    const frames = await appendFrames;
    expect(frames.map((frame) => frame[0])).toEqual([FrameKind.Ack, FrameKind.Delta]);
    socket.close();
  });
});

async function startServer() {
  const server = createFrickServer({ port: 0, dbPath: ":memory:" });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    url: `ws://127.0.0.1:${address.port}/_frick/sync`,
    close: server.close,
  };
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve) => socket.once("open", resolve));
  return socket;
}

async function nextFrame(socket: WebSocket): Promise<FrickFrame> {
  return new Promise((resolve) => {
    socket.once("message", (data) => {
      resolve(decodeFrame(data as Buffer));
    });
  });
}

async function collectFrames(socket: WebSocket, count: number): Promise<FrickFrame[]> {
  return new Promise((resolve) => {
    const frames: FrickFrame[] = [];
    const onMessage = (data: Buffer) => {
      frames.push(decodeFrame(data));
      if (frames.length === count) {
        socket.off("message", onMessage);
        resolve(frames);
      }
    };
    socket.on("message", onMessage);
  });
}
