import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { foundationSchema } from "@fricken/protocol";
import { SseRegistry } from "../src/sync/sse.js";
import type { StoredEvent } from "../src/storage/stream-store.js";

class FakeResponse extends EventEmitter {
  status: number | undefined;
  headers: Record<string, string> | undefined;
  chunks: string[] = [];
  ended = false;
  destroyed = false;
  writableLength = 0;
  writeResults: boolean[] = [];

  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    this.headers = headers;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    this.writableLength += Buffer.byteLength(chunk);
    return this.writeResults.shift() ?? true;
  }

  end(): void {
    this.ended = true;
    this.emit("close");
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }
}

describe("SseRegistry", () => {
  it("uses the caller-provided hasMore flag on the initial page", async () => {
    const registry = new SseRegistry(foundationSchema, { heartbeatMs: 0 });
    const response = new FakeResponse();
    const event: StoredEvent = {
      tenantId: "_default",
      stream: "MessageStream",
      streamId: "conversation-general",
      sequence: 2,
      eventId: "event-2",
      event: "MessageSent",
      payload: {
        messageId: "message-2",
        senderId: "user-ada",
        body: "second",
        createdAt: "2026-05-09T00:00:00.000Z",
      },
    };

    registry.open(response as never, {
      tenantId: "_default",
      stream: "MessageStream",
      key: "conversation-general",
      events: [event],
      cursor: 1,
      hasMore: true,
    });

    expect(response.status).toBe(200);
    const payload = JSON.parse(response.chunks.join("").match(/data: (.*)\n\n/)![1]!);
    expect(payload.cursor).toBe(2);
    expect(payload.hasMore).toBe(true);
    registry.closeAll();
  });

  it("closes an SSE client when write reports backpressure", async () => {
    const registry = new SseRegistry(foundationSchema, { heartbeatMs: 0, maxBufferedBytes: 1_000 });
    const response = new FakeResponse();
    response.writeResults = [false];

    registry.open(response as never, {
      tenantId: "_default",
      stream: "MessageStream",
      key: "conversation-general",
      events: [],
      cursor: 0,
    });

    expect(registry.connectionCount).toBe(0);
    expect(response.ended || response.destroyed).toBe(true);
  });

  it("closes an SSE client when writableLength exceeds the configured cap", async () => {
    const registry = new SseRegistry(foundationSchema, { heartbeatMs: 0, maxBufferedBytes: 8 });
    const response = new FakeResponse();

    registry.open(response as never, {
      tenantId: "_default",
      stream: "MessageStream",
      key: "conversation-general",
      events: [],
      cursor: 0,
    });

    expect(registry.connectionCount).toBe(0);
    expect(response.ended || response.destroyed).toBe(true);
  });
});
