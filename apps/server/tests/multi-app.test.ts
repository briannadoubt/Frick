import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  FrameKind,
  decodeFrame,
  defaultClientCapabilities,
  encodeFrame,
  foundationSchema,
  type FrickFrame,
  type FrickSchema,
} from "@frick/protocol";

import { createFrickServer } from "../src/server.js";
import { FrickConfigError } from "../src/config.js";

// Two "apps" share the foundation schema shape but advertise distinct
// schemaIds/hashes — enough for the routing + hello-driven app resolution
// the multi-app server is responsible for. Storage layout is unchanged in
// v1; these schemas only flow through URL responses and Hello frames.
const chatSchema: FrickSchema = {
  ...foundationSchema,
  schemaId: "frick.chat",
  hash: "chat-schema-test-hash",
};
const docsSchema: FrickSchema = {
  ...foundationSchema,
  schemaId: "frick.docs",
  hash: "docs-schema-test-hash",
};

interface RunningServer {
  httpUrl: string;
  wsUrl: string;
  close: () => Promise<void>;
}

async function startServer(
  options: Parameters<typeof createFrickServer>[0] = {},
): Promise<RunningServer> {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    ...options,
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("no address");
  }
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}/_frick/sync`,
    close: server.close,
  };
}

async function helloFrames(
  wsUrl: string,
  schema: FrickSchema,
): Promise<FrickFrame[]> {
  const socket = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const collected: FrickFrame[] = [];
  const waiter = new Promise<FrickFrame[]>((resolve) => {
    const onMessage = (data: Buffer) => {
      collected.push(decodeFrame(data));
      // Hello flow either yields HelloAck+Schema (2 frames) or one Nack.
      if (
        collected.length === 2 ||
        (collected.length === 1 && collected[0]![0] === FrameKind.Nack)
      ) {
        socket.off("message", onMessage);
        resolve(collected);
      }
    };
    socket.on("message", onMessage);
  });
  socket.send(
    encodeFrame([
      FrameKind.Hello,
      {
        replicaId: "replica-multiapp-test",
        deviceId: "device-multiapp-test",
        schemaHash: schema.hash,
        knownCursors: {},
        clientCapabilities: defaultClientCapabilities({
          platform: "web",
          sdkVersion: "0.0.0-test",
          schema,
        }),
      },
    ]),
  );
  const frames = await waiter;
  socket.close();
  return frames;
}

describe("multi-app server", () => {
  let app: RunningServer | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("single-app default still serves /schema with the foundation schema", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/schema`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as FrickSchema;
    expect(body.schemaId).toBe(foundationSchema.schemaId);
  });

  it("routes <basePath>/schema to the owning app", async () => {
    app = await startServer({
      apps: [
        { id: "chat", schema: chatSchema, basePath: "/chat" },
        { id: "docs", schema: docsSchema, basePath: "/docs" },
      ],
    });

    const chatResponse = await fetch(`${app.httpUrl}/chat/schema`);
    expect(chatResponse.status).toBe(200);
    expect((await chatResponse.json()).schemaId).toBe("frick.chat");

    const docsResponse = await fetch(`${app.httpUrl}/docs/schema`);
    expect(docsResponse.status).toBe(200);
    expect((await docsResponse.json()).schemaId).toBe("frick.docs");
  });

  it("hello with an app's schemaId yields that app's schema in HelloAck", async () => {
    app = await startServer({
      apps: [
        { id: "chat", schema: chatSchema, basePath: "/chat" },
        { id: "docs", schema: docsSchema, basePath: "/docs" },
      ],
    });

    const frames = await helloFrames(app.wsUrl, chatSchema);
    expect(frames).toHaveLength(2);
    expect(frames[0]![0]).toBe(FrameKind.HelloAck);
    expect(frames[0]![1]).toMatchObject({
      schemaId: "frick.chat",
      schemaHash: chatSchema.hash,
    });
    expect(frames[1]).toEqual([FrameKind.Schema, chatSchema]);
  });

  it("hello with an unknown schemaId nacks with knownAppIds in details", async () => {
    app = await startServer({
      apps: [
        { id: "chat", schema: chatSchema, basePath: "/chat" },
        { id: "docs", schema: docsSchema, basePath: "/docs" },
      ],
    });

    const strangerSchema: FrickSchema = {
      ...foundationSchema,
      schemaId: "frick.unknown",
      hash: "unknown-hash",
    };
    const frames = await helloFrames(app.wsUrl, strangerSchema);
    expect(frames).toHaveLength(1);
    expect(frames[0]![0]).toBe(FrameKind.Nack);
    const payload = frames[0]![1] as {
      error: { code: string; details?: { knownAppIds?: string[] } };
    };
    expect(payload.error.code).toBe("schema.incompatible");
    expect(payload.error.details?.knownAppIds).toEqual(["chat", "docs"]);
  });

  it("rejects duplicate basePath at createFrickServer", () => {
    expect(() =>
      createFrickServer({
        port: 0,
        dbPath: ":memory:",
        apps: [
          { id: "chat", schema: chatSchema, basePath: "/dup" },
          { id: "docs", schema: docsSchema, basePath: "/dup" },
        ],
      }),
    ).toThrow(FrickConfigError);
  });

  it("/_frick/inspect/apps lists registered apps", async () => {
    app = await startServer({
      apps: [
        { id: "chat", schema: chatSchema, basePath: "/chat" },
        { id: "docs", schema: docsSchema, basePath: "/docs" },
      ],
    });

    const response = await fetch(`${app.httpUrl}/_frick/inspect/apps`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      apps: Array<{ id: string; basePath: string; schemaId: string }>;
    };
    expect(body.apps).toEqual([
      expect.objectContaining({ id: "chat", basePath: "/chat", schemaId: "frick.chat" }),
      expect.objectContaining({ id: "docs", basePath: "/docs", schemaId: "frick.docs" }),
    ]);
  });
});
