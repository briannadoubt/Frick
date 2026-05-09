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

  it("fans out HTTP appends to WebSocket stream subscribers", async () => {
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
    await nextFrame(socket);

    const deltaFrame = nextFrame(socket);
    await postAppend(app.httpUrl, "request-http-ws", "hello from http");

    const frame = await withTimeout(deltaFrame, "expected websocket delta from HTTP append");
    expect(frame[0]).toBe(FrameKind.Delta);
    socket.close();
  });

  it("does not fan out idempotent HTTP append retries", async () => {
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
    await nextFrame(socket);

    const firstDelta = nextFrame(socket);
    await postAppend(app.httpUrl, "request-http-retry", "first delivery");
    expect((await withTimeout(firstDelta, "expected first HTTP append delta"))[0]).toBe(FrameKind.Delta);

    const retryDelta = nextFrame(socket);
    await postAppend(app.httpUrl, "request-http-retry", "first delivery");
    await expect(withTimeout(retryDelta, "unexpected retry delta")).rejects.toThrow("unexpected retry delta");
    socket.close();
  });

  it("streams HTTP appends over SSE", async () => {
    app = await startServer();
    const abort = new AbortController();
    const response = await fetch(`${app.httpUrl}/streams/MessageStream/conversation-general/events?after=0`, {
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.body).toBeTruthy();

    const reader = response.body!.getReader();
    const page = await readSseEvent(reader);
    expect(page.event).toBe("stream-page");
    expect(JSON.parse(page.data)).toMatchObject({
      schemaHash: foundationSchema.hash,
      stream: "MessageStream",
      key: "conversation-general",
      data: [],
    });

    const deltaEvent = readSseEvent(reader);
    await postAppend(app.httpUrl, "request-http-sse", "hello over sse");

    const delta = await withTimeout(deltaEvent, "expected SSE delta from HTTP append");
    expect(delta.event).toBe("delta");
    expect(JSON.parse(delta.data).data[0].payload.body).toBe("hello over sse");
    abort.abort();
  });

  it("keeps quiet SSE connections alive with comments", async () => {
    app = await startServer({ sseHeartbeatMs: 10 });
    const abort = new AbortController();
    const response = await fetch(`${app.httpUrl}/streams/MessageStream/conversation-general/events?after=999999`, {
      signal: abort.signal,
    });
    expect(response.body).toBeTruthy();

    const reader = response.body!.getReader();
    expect((await readSseEvent(reader)).event).toBe("stream-page");

    const keepAlive = await withTimeout(readRawSseBlock(reader), "expected SSE keep-alive");
    expect(keepAlive).toContain(": keep-alive");
    abort.abort();
  });
});

async function startServer(options: { sseHeartbeatMs?: number } = {}) {
  const server = createFrickServer({ port: 0, dbPath: ":memory:", ...options });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    url: `ws://127.0.0.1:${address.port}/_frick/sync`,
    httpUrl: `http://127.0.0.1:${address.port}`,
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

async function postAppend(httpUrl: string, requestId: string, body: string): Promise<void> {
  const response = await fetch(`${httpUrl}/append`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId,
      replicaId: "http-test",
      stream: "MessageStream",
      key: "conversation-general",
      event: "MessageSent",
      payload: {
        messageId: `message-${requestId}`,
        senderId: "user-ada",
        body,
        createdAt: "2026-05-09T00:00:00.000Z",
      },
    }),
  });
  expect(response.status).toBe(200);
}

interface SseEvent {
  event: string;
  data: string;
}

async function readRawSseBlock(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const delimiter = buffer.indexOf("\n\n");
    if (delimiter !== -1) {
      return buffer.slice(0, delimiter);
    }

    const { value, done } = await reader.read();
    if (done) {
      throw new Error("SSE stream ended before the next block");
    }
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
  }
}

async function readSseEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const delimiter = buffer.indexOf("\n\n");
    if (delimiter !== -1) {
      const rawEvent = buffer.slice(0, delimiter);
      buffer = buffer.slice(delimiter + 2);
      const parsed = parseSseEvent(rawEvent);
      if (parsed) {
        return parsed;
      }
    }

    const { value, done } = await reader.read();
    if (done) {
      throw new Error("SSE stream ended before the next event");
    }
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
  }
}

function parseSseEvent(rawEvent: string): SseEvent | undefined {
  let event = "message";
  const data: string[] = [];
  for (const line of rawEvent.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    }
    if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trim());
    }
  }
  return data.length > 0 ? { event, data: data.join("\n") } : undefined;
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 500);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
