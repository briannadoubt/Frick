import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
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
  type ObjectUpsertPayload,
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
  assertCanWriteObject,
  AuthenticationError,
  AuthorizationError,
  tenantMembershipReader,
  type FrickPolicyHook,
  type Principal,
} from "../authz.js";
import { FrickObjectVersionConflictError } from "../storage/object-errors.js";
import type { FrickStore } from "../store.js";
import type { StoredEvent } from "../storage/stream-store.js";
import type {
  FrickProjectionRegistry,
  ProjectionDeltaNotice,
} from "../projections/registry.js";
import { routeSignal } from "./signal-router.js";
import { SubscriptionRegistry, type SyncClient } from "./subscriptions.js";
import { sendFrame } from "./wire.js";
import { DEFAULT_FRICK_LIMITS, clampTtlSeconds, type FrickLimits } from "../limits.js";
import { resolveTenantLimits } from "../tenant-config.js";
import type { FrickMetrics, Gauge } from "../metrics.js";
import { emitDevToolsEvent } from "../devtools/emit.js";
import type { FrickAppRegistry } from "../apps/registry.js";
import type { ClusterEnvelope, FrickClusterBus } from "../cluster/bus.js";

/**
 * Per-connection tracking for the DevTools `ws.disconnect` event. We synth a
 * `clientId` (the WS protocol doesn't define one) so the connect/disconnect
 * pair can be correlated in the developer console. `frameCounts` is keyed by
 * `FrameKind` enum name to match the existing `frick.ws.frames.total` metric
 * labels.
 */
interface DevToolsConnectionContext {
  readonly clientId: string;
  readonly connectedAtMs: number;
  readonly frameCounts: Record<string, number>;
}

export class SyncGateway {
  readonly #subscriptions = new SubscriptionRegistry();
  readonly #limits: FrickLimits;
  readonly #policyHooks: readonly FrickPolicyHook[];
  readonly #pendingAppendCounts = new WeakMap<SyncClient, number>();
  readonly #lastSeenAt = new WeakMap<SyncClient, number>();
  /**
   * Per-connection resolved {@link FrickLimits}. Populated once at attach
   * time when we know the principal's tenant id, then re-used across every
   * frame for the lifetime of the connection. Settings change infrequently
   * relative to frame rate, so caching at connection lifetime is the right
   * trade-off — operators that need a setting change to take effect
   * immediately can disconnect the affected client. Unauthenticated clients
   * (no principal at connect) fall back to the global limits.
   */
  readonly #clientLimits = new WeakMap<SyncClient, FrickLimits>();
  readonly #devtoolsContexts = new WeakMap<SyncClient, DevToolsConnectionContext>();
  readonly #heartbeatTimers = new Set<ReturnType<typeof setInterval>>();
  readonly #metrics: FrickMetrics | undefined;
  readonly #connectionsGauge: Gauge | undefined;
  #activeConnections = 0;

  readonly #projections: FrickProjectionRegistry | undefined;
  readonly #appRegistry: FrickAppRegistry | undefined;
  readonly #clusterBus: FrickClusterBus | undefined;
  #clusterUnsubscribe: (() => void) | undefined;

  constructor(
    private readonly wss: WebSocketServer,
    private readonly store: FrickStore,
    private readonly options: {
      onStreamEvent?: (event: StoredEvent) => void;
      limits?: FrickLimits;
      policyHooks?: readonly FrickPolicyHook[];
      metrics?: FrickMetrics;
      projections?: FrickProjectionRegistry;
      appRegistry?: FrickAppRegistry;
      /**
       * Optional cluster bus for horizontal-scale fan-out. When set,
       * every locally-published stream event / object delta is also
       * forwarded to peer nodes; envelopes received from peers are
       * fanned out locally without re-publishing back to the bus.
       */
      clusterBus?: FrickClusterBus;
    } = {},
  ) {
    this.#limits = options.limits ?? DEFAULT_FRICK_LIMITS;
    this.#policyHooks = options.policyHooks ?? [];
    this.#metrics = options.metrics;
    this.#connectionsGauge = this.#metrics?.gauge("frick.ws.connections.current");
    this.#projections = options.projections;
    this.#appRegistry = options.appRegistry;
    this.#clusterBus = options.clusterBus;
    if (this.#projections) {
      this.#projections.setDeltaListener((notice) => this.publishProjectionDelta(notice));
    }
    if (this.#clusterBus) {
      this.#clusterUnsubscribe = this.#clusterBus.subscribe((envelope) =>
        this.#handleClusterEnvelope(envelope),
      );
    }
  }

  attach(): void {
    this.wss.on("connection", (socket, request) => {
      const principal = this.#principalFromRequest(request);
      const client: SyncClient = { socket, subscriptions: new Map(), ...(principal ? { principal } : {}) };
      this.#subscriptions.addClient(client);
      this.#pendingAppendCounts.set(client, 0);
      this.#lastSeenAt.set(client, Date.now());
      // Resolve per-tenant limits once per connection; fall back to global
      // when no principal (e.g. pre-hello unauthenticated connect).
      const resolved = principal
        ? resolveTenantLimits(principal.tenantId, this.store, this.#limits)
        : this.#limits;
      this.#clientLimits.set(client, resolved);
      this.#activeConnections += 1;
      this.#connectionsGauge?.set(this.#activeConnections);

      // Record connect/disconnect into the DevTools feed. Synthesizing a
      // clientId here keeps the gateway the single source of truth for
      // connection identity — the protocol itself does not assign one.
      const devtoolsCtx: DevToolsConnectionContext = {
        clientId: randomUUID(),
        connectedAtMs: Date.now(),
        frameCounts: {},
      };
      this.#devtoolsContexts.set(client, devtoolsCtx);
      emitDevToolsEvent(this.store, {
        kind: "ws.connect",
        ...(principal ? { tenantId: principal.tenantId } : {}),
        fields: {
          clientId: devtoolsCtx.clientId,
          ...(principal ? { tenantId: principal.tenantId, userId: principal.userId } : {}),
        },
      });

      const heartbeat = this.#startHeartbeat(client, socket);

      socket.on("message", (payload) => {
        this.#lastSeenAt.set(client, Date.now());
        this.#handleRawFrame(client, socket, payload as Buffer);
      });
      socket.on("close", () => {
        clearInterval(heartbeat);
        this.#heartbeatTimers.delete(heartbeat);
        this.#subscriptions.removeClient(client);
        this.#activeConnections = Math.max(0, this.#activeConnections - 1);
        this.#connectionsGauge?.set(this.#activeConnections);
        emitDevToolsEvent(this.store, {
          kind: "ws.disconnect",
          ...(client.principal ? { tenantId: client.principal.tenantId } : {}),
          fields: {
            clientId: devtoolsCtx.clientId,
            durationMs: Date.now() - devtoolsCtx.connectedAtMs,
            frameCounts: devtoolsCtx.frameCounts,
          },
        });
      });
    });
  }

  close(): void {
    for (const timer of this.#heartbeatTimers) {
      clearInterval(timer);
    }
    this.#heartbeatTimers.clear();
    this.#projections?.setDeltaListener(undefined);
    this.#clusterUnsubscribe?.();
    this.#clusterUnsubscribe = undefined;
    this.#subscriptions.closeAll();
  }

  /**
   * Look up the per-tenant resolved limits for this client. Falls back to
   * the gateway-wide global limits when no per-connection resolution has
   * been performed (defensive — every attach() path populates the map).
   */
  #limitsFor(client: SyncClient): FrickLimits {
    return this.#clientLimits.get(client) ?? this.#limits;
  }

  publishProjectionDelta(notice: ProjectionDeltaNotice): void {
    for (const { client: subscriber } of this.#subscriptions.projectionSubscribers(notice.projection)) {
      // Only deliver to subscribers in the same tenant as the producing write.
      if (subscriber.principal && subscriber.principal.tenantId !== notice.tenantId) {
        continue;
      }
      sendFrame(subscriber.socket, [
        FrameKind.ProjectionDelta,
        { projection: notice.projection, changes: notice.changes },
      ]);
    }
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
    this.#fanOutStreamEvent(event, packed);
    if (this.#clusterBus) {
      this.#clusterBus.publish({
        kind: "streamEvent",
        originNodeId: this.#clusterBus.nodeId,
        tenantId: event.tenantId,
        stream: event.stream,
        streamId: event.streamId,
        sequence: event.sequence,
        packed,
      });
    }
  }

  publishObjects(type: string, objects: PlainObject[], tenantId?: string): void {
    this.#fanOutObjects(type, objects, tenantId);
    if (this.#clusterBus && tenantId !== undefined) {
      this.#clusterBus.publish({
        kind: "objects",
        originNodeId: this.#clusterBus.nodeId,
        tenantId,
        type,
        objects: [...objects],
      });
    }
  }

  /** Local-only stream-event fan-out, also reused by the cluster handler. */
  #fanOutStreamEvent(event: { tenantId: string; stream: string; streamId: string; sequence: number }, packed: ReturnType<typeof packStreamEvent>): void {
    for (const { client: subscriber } of this.#subscriptions.streamSubscribers(event.stream, event.streamId)) {
      if (subscriber.principal && subscriber.principal.tenantId !== event.tenantId) {
        continue;
      }
      sendFrame(subscriber.socket, [FrameKind.Delta, { objects: [], events: [packed], cursor: event.sequence }]);
    }
  }

  /** Local-only object fan-out, also reused by the cluster handler. */
  #fanOutObjects(type: string, objects: PlainObject[], tenantId?: string): void {
    const cursor = Date.now();
    for (const { client: subscriber } of this.#subscriptions.objectSubscribers(type)) {
      const principal = requirePrincipal(subscriber);
      if (tenantId !== undefined && principal.tenantId !== tenantId) {
        continue;
      }
      const visibleObjects = objects.filter((object) =>
        this.store.isObjectVisibleToUser(principal.tenantId, type, object, principal.userId),
      );
      if (visibleObjects.length === 0) {
        continue;
      }
      sendFrame(subscriber.socket, [
        FrameKind.Delta,
        { objects: packObjects(this.store, type, visibleObjects), events: [], cursor },
      ]);
    }
  }

  /**
   * Apply an envelope received from a peer node. Runs the same local
   * fan-out paths the originating node's `publish*` methods do, but
   * does NOT forward back to the bus — the originating node already
   * published it. Self-published envelopes are filtered upstream by
   * the bus implementation, so this only sees genuine peer traffic.
   *
   * v1 scope: stream events + object upserts. Signal + projection delta
   * cross-node fan-out is a known follow-up — those paths route through
   * `routeSignal` / the projection registry's delta listener, both of
   * which need a small refactor to skip re-publishing when handling a
   * peer envelope.
   */
  #handleClusterEnvelope(envelope: ClusterEnvelope): void {
    switch (envelope.kind) {
      case "streamEvent":
        this.#fanOutStreamEvent(
          {
            tenantId: envelope.tenantId,
            stream: envelope.stream,
            streamId: envelope.streamId,
            sequence: envelope.sequence,
          },
          envelope.packed,
        );
        return;
      case "objects":
        this.#fanOutObjects(envelope.type, envelope.objects as PlainObject[], envelope.tenantId);
        return;
      case "signal":
      case "projectionDelta":
      case "presenceDelta":
        // See JSDoc — known follow-up.
        return;
    }
  }

  publishSignal(name: string, key: string, value: PlainObject, tenantId: string, requestId = "http"): void {
    routeSignal(this.store, this.#subscriptions, { requestId, name, key, value }, tenantId);
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
      const decoded = decodeFrame(payload);
      const kindLabel = FrameKind[decoded[0]] ?? String(decoded[0]);
      if (this.#metrics) {
        this.#metrics
          .counter("frick.ws.frames.total", { kind: kindLabel })
          .inc();
      }
      // Track for the DevTools ws.disconnect event. Same label as the
      // metrics counter so an operator can correlate the two views.
      const devtoolsCtx = this.#devtoolsContexts.get(client);
      if (devtoolsCtx) {
        devtoolsCtx.frameCounts[kindLabel] = (devtoolsCtx.frameCounts[kindLabel] ?? 0) + 1;
      }
      this.#handleFrame(client, decoded);
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
      case FrameKind.Hello: {
        // Hello-driven app routing: when the client advertises a schemaId
        // matching a registered app, route this connection to that app's
        // schema. Falls back to the store's schema in single-app mode (no
        // registry) or when no app id matches — the compatibility check
        // below then surfaces the mismatch with the active app id.
        const clientCaps = frame[1].clientCapabilities;
        const advertisedSchemaId = clientCaps?.schema.schemaId;
        const matchedApp = advertisedSchemaId
          ? this.#appRegistry?.findBySchemaId(advertisedSchemaId)
          : undefined;
        const targetSchema = matchedApp?.schema ?? this.store.schema;
        const targetAppId = matchedApp?.id;

        if (!clientCaps) {
          try {
            rejectSchemaMismatch(frame[1].schemaHash, targetSchema.hash);
          } catch (error) {
            const envelope = createFrickErrorEnvelope({
              code: "schema.incompatible",
              message: error instanceof Error ? error.message : "Schema mismatch",
              requestId: "hello",
              retryable: false,
              ...(targetAppId !== undefined ? { details: { appId: targetAppId } } : {}),
              schemaHash: targetSchema.hash,
              schemaRevision: targetSchema.schemaRevision,
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
          this.#sendHelloSuccess(client, compareSchemaCompatibility(targetSchema, targetSchema), targetSchema);
          return;
        }

        const clientSchema = schemaFromClientCapabilities(clientCaps, targetSchema);
        const compatibility = compareSchemaCompatibility(clientSchema, targetSchema);
        if (!compatibility.compatible) {
          // When a registry is configured but no app matched the client's
          // schemaId, surface that as part of the nack so the client knows
          // it picked an unknown app. We list the known app ids to help the
          // user discover the correct id without leaking schema internals.
          const knownApps = this.#appRegistry?.list();
          const details: Record<string, unknown> = {};
          if (targetAppId !== undefined) {
            details.appId = targetAppId;
          } else if (knownApps && knownApps.length > 0) {
            details.knownAppIds = knownApps.map((app) => app.id);
          }
          const envelope = createFrickErrorEnvelope({
            code: "schema.incompatible",
            message: compatibility.message,
            requestId: "hello",
            retryable: false,
            ...(Object.keys(details).length > 0 ? { details } : {}),
            schemaHash: targetSchema.hash,
            schemaRevision: targetSchema.schemaRevision,
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

        const serverCapabilities = defaultServerCapabilities(targetSchema);
        const unsupportedCapabilities = unsupportedRequiredCapabilities(clientCaps, serverCapabilities);
        if (unsupportedCapabilities.length > 0) {
          const envelope = createFrickErrorEnvelope({
            code: "sync.protocolError",
            message: "Client requires unsupported capabilities",
            requestId: "hello",
            retryable: false,
            details: {
              unsupportedCapabilities,
              ...(targetAppId !== undefined ? { appId: targetAppId } : {}),
            },
            schemaHash: targetSchema.hash,
            schemaRevision: targetSchema.schemaRevision,
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

        this.#sendHelloSuccess(client, compatibility, targetSchema);
        return;
      }
      case FrameKind.Subscribe:
        this.#handleSubscribe(client, frame[1]);
        return;
      case FrameKind.Append:
        this.#handleAppend(client, frame[1]);
        return;
      case FrameKind.ObjectUpsert:
        this.#handleObjectUpsert(client, frame[1]);
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
    const clientLimits = this.#limitsFor(client);
    if (
      !client.subscriptions.has(payload.subscriptionId) &&
      client.subscriptions.size >= clientLimits.maxSubscriptionsPerConnection
    ) {
      const envelope = createFrickErrorEnvelope({
        code: "rateLimit.exceeded",
        message: "Maximum subscriptions per connection exceeded",
        requestId: payload.subscriptionId,
        retryable: false,
        details: {
          limit: "maxSubscriptionsPerConnection",
          configuredMax: clientLimits.maxSubscriptionsPerConnection,
        },
      });
      sendFrame(client.socket, [
        FrameKind.Nack,
        { requestId: payload.subscriptionId, error: envelope, code: envelope.code, message: envelope.message },
      ]);
      return;
    }
    if (payload.kind === "projection") {
      const projection = this.#projections?.get(payload.name);
      if (!projection) {
        const envelope = createFrickErrorEnvelope({
          code: "auth.forbidden",
          message: `Unknown projection ${payload.name}`,
          requestId: payload.subscriptionId,
          retryable: false,
          details: { reason: "projectionNotFound", projection: payload.name },
        });
        sendFrame(client.socket, [
          FrameKind.Nack,
          { requestId: payload.subscriptionId, error: envelope, code: envelope.code, message: envelope.message },
        ]);
        return;
      }
    }
    try {
      assertCanSubscribe(
        principal,
        payload.kind,
        payload.name,
        payload.key,
        tenantMembershipReader(this.store, principal.tenantId),
        this.#policyHooks,
      );
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
        .readEvents(principal.tenantId, payload.name, key, cursor)
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
      const objects = packObjects(
        this.store,
        payload.name,
        this.store.listObjectsForUser(principal.tenantId, payload.name, principal.userId),
      );
      sendFrame(client.socket, [FrameKind.Snapshot, { subscriptionId: payload.subscriptionId, objects, cursor: 0 }]);
    }
  }

  #sendHelloSuccess(
    client: SyncClient,
    schemaCompatibility: SchemaCompatibilityResult,
    schema: FrickSchema = this.store.schema,
  ): void {
    sendFrame(client.socket, [
      FrameKind.HelloAck,
      {
        schemaHash: schema.hash,
        schemaId: schema.schemaId,
        schemaRevision: schema.schemaRevision,
        schemaCompatibility,
        serverCapabilities: defaultServerCapabilities(schema),
      },
    ]);
    sendFrame(client.socket, [FrameKind.Schema, schema]);
  }

  #handleAppend(client: SyncClient, payload: AppendPayload): void {
    const principal = requirePrincipal(client);
    const clientLimits = this.#limitsFor(client);

    const pending = this.#pendingAppendCounts.get(client) ?? 0;
    if (pending >= clientLimits.maxPendingAppendsPerClient) {
      const envelope = createFrickErrorEnvelope({
        code: "rateLimit.exceeded",
        message: "Pending append queue is full",
        requestId: payload.requestId,
        retryable: true,
        details: {
          limit: "maxPendingAppendsPerClient",
          configuredMax: clientLimits.maxPendingAppendsPerClient,
        },
      });
      sendFrame(client.socket, [
        FrameKind.Nack,
        { requestId: payload.requestId, error: envelope, code: envelope.code, message: envelope.message },
      ]);
      return;
    }

    const encoded = msgpackEncode(payload.payload);
    if (encoded.byteLength > clientLimits.maxStreamAppendPayloadBytes) {
      const envelope = createFrickErrorEnvelope({
        code: "stream.appendRejected",
        message: "Append payload exceeds maximum size",
        requestId: payload.requestId,
        retryable: false,
        details: {
          reason: "payloadTooLarge",
          configuredMax: clientLimits.maxStreamAppendPayloadBytes,
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
          tenantMembershipReader(this.store, principal.tenantId),
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
        tenantId: principal.tenantId,
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

  #handleObjectUpsert(client: SyncClient, payload: ObjectUpsertPayload): void {
    if (!client.principal) {
      const envelope = createFrickErrorEnvelope({
        code: "auth.unauthenticated",
        message: "Missing session token",
        requestId: payload.requestId,
        retryable: false,
        details: { reason: "unauthenticated" },
      });
      sendFrame(client.socket, [
        FrameKind.Nack,
        { requestId: payload.requestId, error: envelope, code: envelope.code, message: envelope.message },
      ]);
      return;
    }
    const principal = client.principal;

    // Object upserts share the pending-append counter intentionally: both are
    // outstanding write intents and a single combined cap matches the limits
    // round (round 5). A separate cap would let a misbehaving client double
    // its in-flight budget by mixing frame kinds.
    const clientLimits = this.#limitsFor(client);
    const pending = this.#pendingAppendCounts.get(client) ?? 0;
    if (pending >= clientLimits.maxPendingAppendsPerClient) {
      const envelope = createFrickErrorEnvelope({
        code: "rateLimit.exceeded",
        message: "Pending write queue is full",
        requestId: payload.requestId,
        retryable: true,
        details: {
          limit: "maxPendingAppendsPerClient",
          configuredMax: clientLimits.maxPendingAppendsPerClient,
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
        assertCanWriteObject(
          principal,
          payload.objectType,
          payload.objectId,
          tenantMembershipReader(this.store, principal.tenantId),
          this.#policyHooks,
        );
      } catch (error) {
        if (this.#sendAuthNack(client, payload.requestId, error)) {
          return;
        }
        throw error;
      }

      const mergePolicy = this.store.objectMergePolicy(payload.objectType);
      try {
        const result = this.store.upsertObjectWithPolicy({
          tenantId: principal.tenantId,
          type: payload.objectType,
          id: payload.objectId,
          value: payload.value,
          ...(payload.expectedVersion !== undefined ? { expectedVersion: payload.expectedVersion } : {}),
        });
        sendFrame(client.socket, [
          FrameKind.Ack,
          { requestId: payload.requestId, version: result.nextVersion },
        ]);
        const written: PlainObject = { id: payload.objectId, ...withoutEnvelopeId(payload.value) };
        this.publishObjects(payload.objectType, [written], principal.tenantId);
      } catch (error) {
        if (error instanceof FrickObjectVersionConflictError) {
          const envelope = createFrickErrorEnvelope({
            code: "storage.conflict",
            message: error.message,
            requestId: payload.requestId,
            retryable: false,
            details: {
              ...(error.expectedVersion !== undefined ? { expectedVersion: error.expectedVersion } : {}),
              actualVersion: error.actualVersion,
              mergePolicy,
            },
            schemaHash: this.store.schema.hash,
            schemaRevision: this.store.schema.schemaRevision,
          });
          sendFrame(client.socket, [
            FrameKind.Nack,
            { requestId: payload.requestId, error: envelope, code: envelope.code, message: envelope.message },
          ]);
          return;
        }
        throw error;
      }
    } finally {
      this.#pendingAppendCounts.set(client, Math.max(0, (this.#pendingAppendCounts.get(client) ?? 1) - 1));
    }
  }

  #handlePresenceSet(client: SyncClient, payload: PresenceSetPayload): void {
    const principal = requirePrincipal(client);
    const presence = presenceByName(this.store.schema, payload.name);
    const ttlSeconds = presence.ttlMs / 1000;
    const clampedSeconds = clampTtlSeconds(
      ttlSeconds,
      this.#limits.presenceTtlMinSeconds,
      this.#limits.presenceTtlMaxSeconds,
      (from, to) => console.warn(`Clamped presence TTL for ${payload.name} from ${from}s to ${to}s`),
    );
    this.store.setPresence(principal.tenantId, payload.name, payload.key, payload.value, clampedSeconds * 1000);
    const packed = packPresenceRecord(this.store.schema, payload.name, payload.key, payload.value);
    for (const { client: subscriber, subscription } of this.#subscriptions.presenceSubscribers(payload.name, payload.key)) {
      if (subscriber.principal && subscriber.principal.tenantId !== principal.tenantId) {
        continue;
      }
      sendFrame(subscriber.socket, [
        FrameKind.PresenceDelta,
        { subscriptionId: subscription.subscriptionId, records: [packed], cleared: [] },
      ]);
    }
    sendFrame(client.socket, [FrameKind.Ack, { requestId: payload.requestId }]);
  }

  #handlePresenceClear(client: SyncClient, payload: PresenceClearPayload): void {
    const principal = requirePrincipal(client);
    this.store.clearPresence(principal.tenantId, payload.name, payload.key);
    for (const { client: subscriber, subscription } of this.#subscriptions.presenceSubscribers(payload.name, payload.key)) {
      if (subscriber.principal && subscriber.principal.tenantId !== principal.tenantId) {
        continue;
      }
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
      assertCanSignal(
        principal,
        payload.name,
        payload.key,
        tenantMembershipReader(this.store, principal.tenantId),
        this.#policyHooks,
      );
    } catch (error) {
      if (this.#sendAuthNack(client, payload.requestId, error)) {
        return;
      }
      throw error;
    }
    this.store.enqueueSignal(principal.tenantId, payload.name, payload.key, payload.value);
    routeSignal(this.store, this.#subscriptions, payload, principal.tenantId);
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
          tenantId: session.tenantId,
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

function withoutEnvelopeId(value: PlainObject): PlainObject {
  const { id: _id, ...rest } = value;
  return rest;
}

function schemaFromClientCapabilities(client: FrickClientCapabilities, serverSchema: FrickSchema): FrickSchema {
  return {
    ...serverSchema,
    schemaId: client.schema.schemaId,
    schemaRevision: client.schema.schemaRevision,
    hash: client.schema.schemaHash,
  };
}
