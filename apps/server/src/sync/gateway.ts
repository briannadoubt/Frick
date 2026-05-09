import { WebSocketServer, type WebSocket } from "ws";
import {
  FrameKind,
  decodeFrame,
  packObjectRecord,
  packPresenceRecord,
  packStreamEvent,
  presenceByName,
  rejectSchemaMismatch,
  type AppendPayload,
  type FrickFrame,
  type PresenceClearPayload,
  type PresenceSetPayload,
  type SignalPayload,
  type SubscribePayload,
} from "@frick/protocol";
import {
  assertCanAppend,
  assertCanSignal,
  assertCanSubscribe,
  principalFromHello,
} from "../authz.js";
import type { FrickStore } from "../store.js";
import { routeSignal } from "./signal-router.js";
import { SubscriptionRegistry, type SyncClient } from "./subscriptions.js";
import { sendFrame } from "./wire.js";

export class SyncGateway {
  readonly #subscriptions = new SubscriptionRegistry();

  constructor(
    private readonly wss: WebSocketServer,
    private readonly store: FrickStore,
  ) {}

  attach(): void {
    this.wss.on("connection", (socket) => {
      const client: SyncClient = { socket, subscriptions: new Map() };
      this.#subscriptions.addClient(client);

      socket.on("message", (payload) => {
        this.#handleRawFrame(client, socket, payload as Buffer);
      });
      socket.on("close", () => {
        this.#subscriptions.removeClient(client);
      });
    });
  }

  close(): void {
    this.#subscriptions.closeAll();
  }

  #handleRawFrame(client: SyncClient, socket: WebSocket, payload: Buffer): void {
    try {
      this.#handleFrame(client, decodeFrame(payload));
    } catch (error) {
      sendFrame(socket, [
        FrameKind.Nack,
        {
          requestId: "unknown",
          code: "frame_rejected",
          message: error instanceof Error ? error.message : "Unknown frame error",
        },
      ]);
    }
  }

  #handleFrame(client: SyncClient, frame: FrickFrame): void {
    switch (frame[0]) {
      case FrameKind.Hello:
        try {
          rejectSchemaMismatch(frame[1].schemaHash, this.store.schema.hash);
        } catch (error) {
          sendFrame(client.socket, [
            FrameKind.Nack,
            {
              requestId: "hello",
              code: "schema_mismatch",
              message: error instanceof Error ? error.message : "Schema mismatch",
            },
          ]);
          return;
        }
        client.principal = principalFromHello(frame[1].replicaId, frame[1].deviceId);
        sendFrame(client.socket, [FrameKind.Schema, this.store.schema]);
        return;
      case FrameKind.Subscribe:
        this.#handleSubscribe(client, frame[1]);
        return;
      case FrameKind.Append:
        this.#handleAppend(client, frame[1]);
        return;
      case FrameKind.PresenceSet:
        this.#handlePresenceSet(client, frame[1]);
        return;
      case FrameKind.PresenceClear:
        this.#handlePresenceClear(client, frame[1]);
        return;
      case FrameKind.SignalSend:
        this.#handleSignal(client, frame[1]);
        return;
      case FrameKind.CursorCommit:
        sendFrame(client.socket, [FrameKind.Ack, { requestId: frame[1].subscriptionId, cursor: frame[1].cursor }]);
        return;
      case FrameKind.Ping:
        sendFrame(client.socket, [FrameKind.Pong, { sentAt: frame[1].sentAt, receivedAt: Date.now() }]);
        return;
      default:
        return;
    }
  }

  #handleSubscribe(client: SyncClient, payload: SubscribePayload): void {
    const principal = requirePrincipal(client);
    assertCanSubscribe(principal, payload.kind, payload.name, payload.key);
    this.#subscriptions.addSubscription(client, payload);

    if (payload.kind === "stream") {
      const key = requireKey(payload);
      const cursor = payload.cursor ?? 0;
      const events = this.store
        .readEvents(payload.name, key, cursor)
        .map((event) => packStreamEvent(this.store.schema, event));
      sendFrame(client.socket, [
        FrameKind.StreamPage,
        {
          subscriptionId: payload.subscriptionId,
          events,
          cursor: events.at(-1)?.[2] ?? cursor,
          hasMore: false,
        },
      ]);
      return;
    }

    if (payload.kind === "object") {
      const objects = this.store.listObjects(payload.name).map((object) => {
        const id = object.id;
        if (typeof id !== "string") {
          throw new Error(`Object ${payload.name} is missing string id`);
        }
        const { id: _id, ...value } = object;
        return packObjectRecord(this.store.schema, payload.name, id, value);
      });
      sendFrame(client.socket, [FrameKind.Snapshot, { subscriptionId: payload.subscriptionId, objects, cursor: 0 }]);
    }
  }

  #handleAppend(client: SyncClient, payload: AppendPayload): void {
    const principal = requirePrincipal(client);
    assertCanAppend(principal, payload.stream, payload.key);
    const event = this.store.appendEvent({
      requestId: payload.requestId,
      replicaId: principal.replicaId,
      stream: payload.stream,
      streamId: payload.key,
      event: payload.event,
      payload: payload.payload,
    });
    sendFrame(client.socket, [FrameKind.Ack, { requestId: payload.requestId, cursor: event.sequence }]);

    const packed = packStreamEvent(this.store.schema, event);
    for (const { client: subscriber } of this.#subscriptions.streamSubscribers(payload.stream, payload.key)) {
      sendFrame(subscriber.socket, [FrameKind.Delta, { objects: [], events: [packed], cursor: event.sequence }]);
    }
  }

  #handlePresenceSet(client: SyncClient, payload: PresenceSetPayload): void {
    requirePrincipal(client);
    const presence = presenceByName(this.store.schema, payload.name);
    this.store.setPresence(payload.name, payload.key, payload.value, presence.ttlMs);
    const packed = packPresenceRecord(this.store.schema, payload.name, payload.key, payload.value);
    for (const { client: subscriber, subscription } of this.#subscriptions.presenceSubscribers(payload.name, payload.key)) {
      sendFrame(subscriber.socket, [
        FrameKind.PresenceDelta,
        { subscriptionId: subscription.subscriptionId, records: [packed], cleared: [] },
      ]);
    }
    sendFrame(client.socket, [FrameKind.Ack, { requestId: payload.requestId }]);
  }

  #handlePresenceClear(client: SyncClient, payload: PresenceClearPayload): void {
    requirePrincipal(client);
    this.store.clearPresence(payload.name, payload.key);
    for (const { client: subscriber, subscription } of this.#subscriptions.presenceSubscribers(payload.name, payload.key)) {
      sendFrame(subscriber.socket, [
        FrameKind.PresenceDelta,
        { subscriptionId: subscription.subscriptionId, records: [], cleared: [payload.key] },
      ]);
    }
    sendFrame(client.socket, [FrameKind.Ack, { requestId: payload.requestId }]);
  }

  #handleSignal(client: SyncClient, payload: SignalPayload): void {
    const principal = requirePrincipal(client);
    assertCanSignal(principal, payload.name, payload.key);
    this.store.enqueueSignal(payload.name, payload.key, payload.value);
    routeSignal(this.store, this.#subscriptions, payload);
    sendFrame(client.socket, [FrameKind.Ack, { requestId: payload.requestId }]);
  }
}

function requirePrincipal(client: SyncClient) {
  if (!client.principal) {
    throw new Error("Client must send hello before realtime operations");
  }
  return client.principal;
}

function requireKey(payload: SubscribePayload): string {
  if (!payload.key) {
    throw new Error(`${payload.kind} subscription ${payload.name} requires key`);
  }
  return payload.key;
}
