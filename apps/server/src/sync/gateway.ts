import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import {
  FrameKind,
  compareSchemaCompatibility,
  createFrickErrorEnvelope,
  decodeFrame,
  defaultServerCapabilities,
  packObjectRecord,
  packPresenceRecord,
  packStreamEvent,
  presenceByName,
  rejectSchemaMismatch,
  unsupportedRequiredCapabilities,
  type AppendPayload,
  type FrickClientCapabilities,
  type FrickFrame,
  type PresenceClearPayload,
  type PresenceSetPayload,
  type PlainObject,
  type FrickSchema,
  type SchemaCompatibilityResult,
  type SignalPayload,
  type SubscribePayload,
} from "@frick/protocol";
import {
  assertCanAppend,
  assertCanSignal,
  assertCanSubscribe,
  AuthenticationError,
  AuthorizationError,
  type FrickPolicyHook,
  type Principal,
} from "../authz.js";
import type { FrickStore } from "../store.js";
import type { StoredEvent } from "../storage/stream-store.js";
import { routeSignal } from "./signal-router.js";
import { SubscriptionRegistry, type SyncClient } from "./subscriptions.js";
import { sendFrame } from "./wire.js";
import { DEFAULT_FRICK_LIMITS, clampTtlSeconds, type FrickLimits } from "../limits.js";

export class SyncGateway {
  readonly #subscriptions = new SubscriptionRegistry();
  readonly #limits: FrickLimits;
  readonly #policyHooks: readonly FrickPolicyHook[];
  readonly #pendingAppendCounts = new WeakMap<SyncClient, number>();
  readonly #lastSeenAt = new WeakMap<SyncClient, number>();
  readonly #heartbeatTimers = new Set<ReturnType<typeof setInterval>>();

  constructor(
    private readonly wss: WebSocketServer,
    private readonly store: FrickStore,
    private readonly options: {
      onStreamEvent?: (event: StoredEvent) => void;
      limits?: FrickLimits;
      policyHooks?: readonly FrickPolicyHook[];
    } = {},
  ) {
    this.#limits = options.limits ?? DEFAULT_FRICK_LIMITS;
    this.#policyHooks = options.policyHooks ?? [];
  }

  attach(): void {
    this.wss.on("connection", (socket, request) => {
      const principal = this.#principalFromRequest(request);
      const client: SyncClient = { socket, subscriptions: new Map(), ...(principal ? { principal } : {}) };
      this.#subscriptions.addClient(client);
      this.#pendingAppendCounts.set(client, 0);
      this.#lastSeenAt.set(client, Date.now());

      const heartbeat = this.#startHeartbeat(client, socket);

      socket.on("message", (payload) => {
        this.#lastSeenAt.set(client, Date.now());
        this.#handleRawFrame(client, socket, payload as Buffer);
      });
      socket.on("close", () => {
        clearInterval(heartbeat);
        this.#heartbeatTimers.delete(heartbeat);
        this.#subscriptions.removeClient(client);
      });
    });
  }

  close(): void {
    for (const timer of this.#heartbeatTimers) {
      clearInterval(timer);
    }
    this.#heartbeatTimers.clear();
    this.#subscriptions.closeAll();
  }

  #startHeartbeat(client: SyncClient, socket: WebSocket): ReturnType<typeof setInterval> {
    const intervalMs = Math.max(50, this.#limits.heartbeatIntervalSeconds * 1000);
    const timeoutMs = Math.max(intervalMs, this.#limits.heartbeatTimeoutSeconds * 1000);
    const timer = setInterval(() => {
      const lastSeen = this.#lastSeenAt.get(client) ?? 0;
      if (Date.now() - lastSeen > timeoutMs) {
        socket.terminate();
        clearInterval(timer);
        this.#heartbeatTimers.delete(timer);
        return;
      }
      try {
        sendFrame(socket, [FrameKind.Ping, { sentAt: Date.now() }]);
      } catch {
        // socket already closing
      }
    }, intervalMs);
    this.#heartbeatTimers.add(timer);
    return timer;
  }

  publishStreamEvent(event: StoredEvent): void {
    const packed = packStreamEvent(this.store.schema, event);
    for (const { client: subscriber } of this.#subscriptions.streamSubscribers(event.stream, event.streamId)) {
      sendFrame(subscriber.socket, [FrameKind.Delta, { objects: [], events: [packed], cursor: event.sequence }]);
    }
  }

  publishObjects(type: string, objects: PlainObject[]): void {
    const cursor = Date.now();
    for (const { client: subscriber } of this.#subscriptions.objectSubscribers(type)) {
      const principal = requirePrincipal(subscriber);
      const visibleObjects = objects.filter((object) => this.store.isObjectVisibleToUser(type, object, principal.userId));
      if (visibleObjects.length === 0) {
        continue;
      }
      sendFrame(subscriber.socket, [
        FrameKind.Delta,
        { objects: packObjects(this.store, type, visibleObjects), events: [], cursor },
      ]);
    }
  }

  publishSignal(name: string, key: string, value: PlainObject, requestId = "http"): void {
    routeSignal(this.store, this.#subscriptions, { requestId, name, key, value });
  }

  #handleRawFrame(client: SyncClient, socket: WebSocket, payload: Buffer): void {
    const byteLength = measureByteLength(payload);
    if (byteLength > this.#limits.maxWebSocketFrameBytes) {
      const envelope = createFrickErrorEnvelope({
        code: "rateLimit.exceeded",
        message: "Inbound WebSocket frame exceeds maximum size",
        requestId: "frame",
        retryable: false,
        details: {
          limit: "maxWebSocketFrameBytes",
          configuredMax: this.#limits.maxWebSocketFrameBytes,
        },
      });
      sendFrame(socket, [
        FrameKind.Nack,
        {
          requestId: "frame",
          error: envelope,
          code: envelope.code,
          message: envelope.message,
        },
      ]);
      try {
        socket.close(1009, "frame too large");
      } catch {
        // socket already closing
      }
      return;
    }
    try {
      this.#handleFrame(client, decodeFrame(payload));
    } catch (error) {
      const envelope = createFrickErrorEnvelope({
        code: "sync.protocolError",
        message: error instanceof Error ? error.message : "Unknown frame error",
        requestId: "unknown",
        retryable: false,
      });
      sendFrame(socket, [
        FrameKind.Nack,
        {
          requestId: "unknown",
          error: envelope,
          code: envelope.code,
          message: envelope.message,
        },
      ]);
    }
  }

  #handleFrame(client: SyncClient, frame: FrickFrame): void {
    switch (frame[0]) {
      case FrameKind.Hello:
        if (!frame[1].clientCapabilities) {
          try {
            rejectSchemaMismatch(frame[1].schemaHash, this.store.schema.hash);
          } catch (error) {
            const envelope = createFrickErrorEnvelope({
              code: "schema.incompatible",
              message: error instanceof Error ? error.message : "Schema mismatch",
              requestId: "hello",
              retryable: false,
              schemaHash: this.store.schema.hash,
              schemaRevision: this.store.schema.schemaRevision,
            });
            sendFrame(client.socket, [
              FrameKind.Nack,
              {
                requestId: "hello",
                error: envelope,
                code: envelope.code,
                message: envelope.message,
              },
            ]);
            return;
          }
          this.#sendHelloSuccess(client, compareSchemaCompatibility(this.store.schema, this.store.schema));
          return;
        }

        const clientSchema = schemaFromClientCapabilities(frame[1].clientCapabilities, this.store.schema);
        const compatibility = compareSchemaCompatibility(clientSchema, this.store.schema);
        if (!compatibility.compatible) {
          const envelope = createFrickErrorEnvelope({
            code: "schema.incompatible",
            message: compatibility.message,
            requestId: "hello",
            retryable: false,
            schemaHash: this.store.schema.hash,
            schemaRevision: this.store.schema.schemaRevision,
          });
          sendFrame(client.socket, [
            FrameKind.Nack,
            {
              requestId: "hello",
              error: envelope,
              code: envelope.code,
              message: envelope.message,
            },
          ]);
          return;
        }

        const serverCapabilities = defaultServerCapabilities(this.store.schema);
        const unsupportedCapabilities = unsupportedRequiredCapabilities(frame[1].clientCapabilities, serverCapabilities);
        if (unsupportedCapabilities.length > 0) {
          const envelope = createFrickErrorEnvelope({
            code: "sync.protocolError",
            message: "Client requires unsupported capabilities",
            requestId: "hello",
            retryable: false,
            details: { unsupportedCapabilities },
            schemaHash: this.store.schema.hash,
            schemaRevision: this.store.schema.schemaRevision,
          });
          sendFrame(client.socket, [
            FrameKind.Nack,
            {
              requestId: "hello",
              error: envelope,
              code: envelope.code,
              message: envelope.message,
            },
          ]);
          return;
        }

        this.#sendHelloSuccess(client, compatibility);
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
    if (
      !client.subscriptions.has(payload.subscriptionId) &&
      client.subscriptions.size >= this.#limits.maxSubscriptionsPerConnection
    ) {
      const envelope = createFrickErrorEnvelope({
        code: "rateLimit.exceeded",
        message: "Maximum subscriptions per connection exceeded",
        requestId: payload.subscriptionId,
        retryable: false,
        details: {
          limit: "maxSubscriptionsPerConnection",
          configuredMax: this.#limits.maxSubscriptionsPerConnection,
        },
      });
      sendFrame(client.socket, [
        FrameKind.Nack,
        { requestId: payload.subscriptionId, error: envelope, code: envelope.code, message: envelope.message },
      ]);
      return;
    }
    try {
      assertCanSubscribe(principal, payload.kind, payload.name, payload.key, this.store, this.#policyHooks);
    } catch (error) {
      if (this.#sendAuthNack(client, payload.subscriptionId, error)) {
        return;
      }
      throw error;
    }
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
      const objects = packObjects(this.store, payload.name, this.store.listObjectsForUser(payload.name, principal.userId));
      sendFrame(client.socket, [FrameKind.Snapshot, { subscriptionId: payload.subscriptionId, objects, cursor: 0 }]);
    }
  }

  #sendHelloSuccess(client: SyncClient, schemaCompatibility: SchemaCompatibilityResult): void {
    sendFrame(client.socket, [
      FrameKind.HelloAck,
      {
        schemaHash: this.store.schema.hash,
        schemaId: this.store.schema.schemaId,
        schemaRevision: this.store.schema.schemaRevision,
        schemaCompatibility,
        serverCapabilities: defaultServerCapabilities(this.store.schema),
      },
    ]);
    sendFrame(client.socket, [FrameKind.Schema, this.store.schema]);
  }

  #handleAppend(client: SyncClient, payload: AppendPayload): void {
    const principal = requirePrincipal(client);

    const pending = this.#pendingAppendCounts.get(client) ?? 0;
    if (pending >= this.#limits.maxPendingAppendsPerClient) {
      const envelope = createFrickErrorEnvelope({
        code: "rateLimit.exceeded",
        message: "Pending append queue is full",
        requestId: payload.requestId,
        retryable: true,
        details: {
          limit: "maxPendingAppendsPerClient",
          configuredMax: this.#limits.maxPendingAppendsPerClient,
        },
      });
      sendFrame(client.socket, [
        FrameKind.Nack,
        { requestId: payload.requestId, error: envelope, code: envelope.code, message: envelope.message },
      ]);
      return;
    }

    const encoded = msgpackEncode(payload.payload);
    if (encoded.byteLength > this.#limits.maxStreamAppendPayloadBytes) {
      const envelope = createFrickErrorEnvelope({
        code: "stream.appendRejected",
        message: "Append payload exceeds maximum size",
        requestId: payload.requestId,
        retryable: false,
        details: {
          reason: "payloadTooLarge",
          configuredMax: this.#limits.maxStreamAppendPayloadBytes,
        },
      });
      sendFrame(client.socket, [
        FrameKind.Nack,
        { requestId: payload.requestId, error: envelope, code: envelope.code, message: envelope.message },
      ]);
      return;
    }

    this.#pendingAppendCounts.set(client, pending + 1);
    try {
      try {
        assertCanAppend(
          principal,
          payload.stream,
          payload.key,
          this.store,
          payload.event,
          payload.payload,
          this.#policyHooks,
        );
      } catch (error) {
        if (this.#sendAuthNack(client, payload.requestId, error)) {
          return;
        }
        throw error;
      }
      const result = this.store.appendEvent({
        requestId: payload.requestId,
        replicaId: principal.replicaId,
        stream: payload.stream,
        streamId: payload.key,
        event: payload.event,
        payload: payload.payload,
      });
      sendFrame(client.socket, [FrameKind.Ack, { requestId: payload.requestId, cursor: result.event.sequence }]);

      if (result.created) {
        this.publishStreamEvent(result.event);
        this.options.onStreamEvent?.(result.event);
      }
    } finally {
      this.#pendingAppendCounts.set(client, Math.max(0, (this.#pendingAppendCounts.get(client) ?? 1) - 1));
    }
  }

  #handlePresenceSet(client: SyncClient, payload: PresenceSetPayload): void {
    requirePrincipal(client);
    const presence = presenceByName(this.store.schema, payload.name);
    const ttlSeconds = presence.ttlMs / 1000;
    const clampedSeconds = clampTtlSeconds(
      ttlSeconds,
      this.#limits.presenceTtlMinSeconds,
      this.#limits.presenceTtlMaxSeconds,
      (from, to) => console.warn(`Clamped presence TTL for ${payload.name} from ${from}s to ${to}s`),
    );
    this.store.setPresence(payload.name, payload.key, payload.value, clampedSeconds * 1000);
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
    try {
      assertCanSignal(principal, payload.name, payload.key, this.store, this.#policyHooks);
    } catch (error) {
      if (this.#sendAuthNack(client, payload.requestId, error)) {
        return;
      }
      throw error;
    }
    this.store.enqueueSignal(payload.name, payload.key, payload.value);
    routeSignal(this.store, this.#subscriptions, payload);
    sendFrame(client.socket, [FrameKind.Ack, { requestId: payload.requestId }]);
  }

  #sendAuthNack(client: SyncClient, requestId: string, error: unknown): boolean {
    if (!(error instanceof AuthorizationError) && !(error instanceof AuthenticationError)) {
      return false;
    }
    const code = error instanceof AuthenticationError ? "auth.unauthenticated" : "auth.forbidden";
    const envelope = createFrickErrorEnvelope({
      code,
      message: error.decision.publicMessage,
      requestId,
      retryable: false,
      details: { reason: error.decision.reason },
    });
    sendFrame(client.socket, [
      FrameKind.Nack,
      { requestId, error: envelope, code: envelope.code, message: envelope.message },
    ]);
    return true;
  }

  #principalFromRequest(request: IncomingMessage): Principal | undefined {
    const url = new URL(request.url ?? "/", "ws://127.0.0.1");
    const token = url.searchParams.get("sessionToken");
    if (!token) {
      return undefined;
    }
    const session = this.store.readActiveSession(token);
    return session
      ? {
          userId: session.userId,
          deviceId: session.deviceId,
          replicaId: session.replicaId,
        }
      : undefined;
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

function packObjects(store: FrickStore, type: string, objects: PlainObject[]) {
  return objects.map((object) => {
    const id = object.id;
    if (typeof id !== "string") {
      throw new Error(`Object ${type} is missing string id`);
    }
    const { id: _id, ...value } = object;
    return packObjectRecord(store.schema, type, id, value);
  });
}

function measureByteLength(payload: unknown): number {
  if (payload instanceof ArrayBuffer) {
    return payload.byteLength;
  }
  if (ArrayBuffer.isView(payload)) {
    return payload.byteLength;
  }
  if (Array.isArray(payload)) {
    let total = 0;
    for (const chunk of payload) {
      total += measureByteLength(chunk);
    }
    return total;
  }
  if (typeof payload === "string") {
    return Buffer.byteLength(payload);
  }
  return 0;
}

function schemaFromClientCapabilities(client: FrickClientCapabilities, serverSchema: FrickSchema): FrickSchema {
  return {
    ...serverSchema,
    schemaId: client.schema.schemaId,
    schemaRevision: client.schema.schemaRevision,
    hash: client.schema.schemaHash,
  };
}
