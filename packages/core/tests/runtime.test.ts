import { describe, expect, test } from "vitest";
import { FrameKind, demoManifest, packObject } from "@frick/protocol";
import { FrickClient } from "../src/index.js";

describe("FrickClient runtime store", () => {
  test("notifies query subscribers when snapshots arrive", () => {
    const client = new FrickClient({
      endpoint: "ws://example.invalid/_frick/sync",
      manifest: demoManifest,
    });
    const signal = client.query({
      entity: "Task",
      index: "byProject",
      args: { projectId: "demo-project" },
    });
    const seen: unknown[] = [];
    signal.subscribe((value) => seen.push(value));

    client.applySnapshot("Task:byProject:{\"projectId\":\"demo-project\"}", [
      packObject(demoManifest, "Task", {
        id: "task-1",
        projectId: "demo-project",
        tenantId: "demo-tenant",
        title: "Arrived from server",
        done: false,
        updatedAt: "2026-05-08T00:00:00.000Z",
      }),
    ]);

    expect(seen.at(-1)).toEqual([
      expect.objectContaining({ id: "task-1", title: "Arrived from server" }),
    ]);
  });

  test("applies packed deltas and refreshes derived query results", () => {
    const client = new FrickClient({
      endpoint: "ws://example.invalid/_frick/sync",
      manifest: demoManifest,
    });
    const signal = client.query({
      entity: "Task",
      index: "byProject",
      args: { projectId: "demo-project" },
    });

    client.applySnapshot("Task:byProject:{\"projectId\":\"demo-project\"}", [
      packObject(demoManifest, "Task", {
        id: "task-1",
        projectId: "demo-project",
        tenantId: "demo-tenant",
        title: "Sync me",
        done: false,
        updatedAt: "2026-05-08T00:00:00.000Z",
      }),
    ]);
    client.applyDelta({
      seq: 7,
      opId: "op-7",
      mutation: "task.toggle",
      entityId: 2,
      entityName: "Task",
      objectId: "task-1",
      fields: [
        [5, true],
        [6, "2026-05-08T00:00:01.000Z"],
      ],
    });

    expect(signal.value[0]).toMatchObject({ id: "task-1", done: true });
    expect(client.syncStatus.value.lastSeq).toBe(7);
    expect(FrameKind.Delta).toBe(5);
  });

  test("sends hello and existing subscriptions when the socket opens", () => {
    const sent: unknown[] = [];
    FakeWebSocket.sent = sent;
    FakeWebSocket.instances = [];
    const client = new FrickClient({
      endpoint: "ws://example.invalid/_frick/sync",
      manifest: demoManifest,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    client.query({
      entity: "Task",
      index: "byProject",
      args: { projectId: "demo-project" },
    });
    client.connect();
    FakeWebSocket.instances[0]?.open();

    expect(sent).toHaveLength(2);
  });

  test("ignores stale socket open events created before a reconnect", () => {
    const sent: unknown[] = [];
    FakeWebSocket.sent = sent;
    FakeWebSocket.instances = [];
    const client = new FrickClient({
      endpoint: "ws://example.invalid/_frick/sync",
      manifest: demoManifest,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    client.query({
      entity: "Task",
      index: "byProject",
      args: { projectId: "demo-project" },
    });
    client.connect();
    const stale = FakeWebSocket.instances[0]!;
    client.disconnect();
    client.connect();
    stale.open();
    FakeWebSocket.instances[1]?.open();

    expect(sent).toHaveLength(2);
  });
});

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: FakeWebSocket[] = [];
  static sent: unknown[] = [];

  readonly url: string;
  binaryType = "arraybuffer";
  readyState = FakeWebSocket.CONNECTING;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  send(payload: unknown): void {
    FakeWebSocket.sent.push(payload);
  }
}
