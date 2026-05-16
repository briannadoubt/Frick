import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { foundationSchema } from "@frick/protocol";
import { SseRegistry } from "../src/sync/sse.js";
import type { StoredEvent } from "../src/storage/stream-store.js";

class FakeResponse extends EventEmitter {
  status: number | undefined;
  headers: Record<string, string> | undefined;
  chunks: string[] = [];
  ended = false;

  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    this.headers = headers;
  }

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  end(): void {
    this.ended = true;
    this.emit("close");
  }
}

describe("SseRegistry", () => {
  it("uses the caller-provided hasMore flag on the initial page", () => {
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
});
