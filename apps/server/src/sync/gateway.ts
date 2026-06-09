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
  type CallCommandPayload,
  type CallCommandResultPayload,
} from "@fricken/protocol";
import {
  CallControlPlane,
  CallAuthzError,
  CallStateError,
  CallMediaUnsupportedError,
  type CallActor,
  type DtlsParameters,
} from "../calls/index.js";
import {
  assertCanAppend,
  assertCanCreateCall,
  assertCanSignal,
  assertCanSubscribe,
  assertCanWriteObject,
  assertCanWritePresence,
  canSubscriberReadObjectRecord,
  AuthenticationError,
  AuthorizationError,
  SessionExpiredError,
  tenantMembershipReader,
  type CallSignalAuthorizer,
  type FrickCascadeGrantLookup,
  type FrickGrantLookup,
  type FrickPolicyHook,
  type Principal,
} from "../authz.js";
import { FrickObjectVersionConflictError } from "../storage/object-errors.js";
import type { FrickStore, FrickStoreWriteEvent } from "../store.js";
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
import { DEFAULT_APP_ID } from "../app-id.js";
import type { ClusterEnvelope, FrickClusterBus } from "../cluster/bus.js";
import type {
  FrickTelemetryRuntime,
  FrickWebSocketCloseCategory,
  FrickWebSocketConnectionTelemetrySpan,
  FrickWebSocketFrameTelemetry,
} from "../telemetry/runtime.js";

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
  readonly #grantLookup: FrickGrantLookup;
  readonly #cascadeGrantLookup: FrickCascadeGrantLookup;
  readonly #pendingAppendCounts = new WeakMap<SyncClient, number>();
  readonly #lastSeenAt = new WeakMap<SyncClient, number>();
  readonly #completedHandshakes = new WeakSet<SyncClient>();
  readonly #clientsBySessionToken = new Map<string, Set<SyncClient>>();
  /**
   * In-process per-principal concurrent-connection counters, keyed by
   * `(tenantId, userId)` (see {@link SyncGateway.#principalConnectionKey}).
   * Consistent with the single-node model — counters are not persisted and
   * reset on restart. `#reservedPrincipalKey` records the key each client
   * currently holds a reservation against, so we release exactly the slot we
   * reserved even after the connection's principal is rebound by a later
   * Hello frame.
   */
  readonly #connectionsByPrincipal = new Map<string, number>();
  readonly #reservedPrincipalKey = new WeakMap<SyncClient, string>();
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
  readonly #telemetryConnections = new WeakMap<SyncClient, FrickWebSocketConnectionTelemetrySpan>();
  readonly #heartbeatTimers = new Set<ReturnType<typeof setInterval>>();
  readonly #metrics: FrickMetrics | undefined;
  readonly #connectionsGauge: Gauge | undefined;
  readonly #telemetry:
    | Pick<FrickTelemetryRuntime, "startWebSocketConnection" | "recordWebSocketFrame">
    | undefined;
  #activeConnections = 0;

  readonly #projections: FrickProjectionRegistry | undefined;
  readonly #appRegistry: FrickAppRegistry | undefined;
  /** FR-15 — call control plane; undefined when calls are disabled. */
  readonly #callControlPlane: CallControlPlane | undefined;
  readonly #clusterBus: FrickClusterBus | undefined;
  #clusterUnsubscribe: (() => void) | undefined;
  // Refcount of currently-connected clients per tenant. Used to push
  // the active tenant set down to a `FrickClusterBus` that supports
  // `setSubscribedTenants`, so peer nodes can drop envelopes addressed
  // to tenants we don't serve before they hit the dispatch path.
  readonly #tenantSubscriberCounts = new Map<string, number>();

  constructor(
    private readonly wss: WebSocketServer,
    private readonly store: FrickStore,
    private readonly options: {
      onStreamEvent?: (event: StoredEvent) => void;
      limits?: FrickLimits;
      policyHooks?: readonly FrickPolicyHook[];
      metrics?: FrickMetrics;
      telemetry?: Pick<FrickTelemetryRuntime, "startWebSocketConnection" | "recordWebSocketFrame">;
      projections?: FrickProjectionRegistry;
      appRegistry?: FrickAppRegistry;
      /**
       * FR-15 — call control plane. When set, the gateway accepts
       * {@link FrameKind.CallCommand} frames and routes them to this plane,
       * replying with a {@link FrameKind.CallCommandResult} on success or a
       * {@link FrameKind.Nack} on a state/authz failure.
       */
      callControlPlane?: CallControlPlane;
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
    this.#grantLookup = (args) => this.store.grants.hasActiveGrantFor(args);
    this.#cascadeGrantLookup = (args) =>
      this.store.grants.hasActiveGrantForRecordId(args);
    this.#metrics = options.metrics;
    this.#connectionsGauge = this.#metrics?.gauge("frick.ws.connections.current");
    this.#telemetry = options.telemetry;
    this.#projections = options.projections;
    this.#appRegistry = options.appRegistry;
    this.#callControlPlane = options.callControlPlane;
    this.#clusterBus = options.clusterBus;
    if (this.#projections) {
      this.#projections.setDeltaListener((notice) => this.publishProjectionDelta(notice));
    }
    // Single broadcast funnel for object/stream writes. Every successful
    // object upsert and stream append — whether driven by a client WS frame,
    // an HTTP route, or a server-side job/route calling the store directly —
    // flows through this one listener and out to subscribers (FR-114). The
    // gateway is the *only* broadcaster of these deltas: the WS frame handlers
    // and HTTP routes no longer publish inline, so a single write never
    // double-fires. `publishObjects`/`publishStreamEvent` also forward to the
    // cluster bus, so server-originated writes reach peer nodes with the same
    // parity client mutations already had.
    this.store.setWriteListener((event) => this.#handleStoreWrite(event));
    if (this.#clusterBus) {
      this.#clusterUnsubscribe = this.#clusterBus.subscribe((envelope) =>
        this.#handleClusterEnvelope(envelope),
      );
    }
  }

  attach(): void {
    this.wss.on("connection", (socket, request) => {
      void this.#handleConnection(socket, request);
    });
  }

  async #handleConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
      socket.on("error", () => {
        // Protocol-level closes (for example ws maxPayload violations) are
        // expected to emit on the socket before the close event finishes the
        // normal cleanup path.
      });
      if (this.#activeConnections >= this.#limits.maxWebSocketConnections) {
        try {
          socket.close(1013, "WebSocket connection limit exceeded");
        } catch {
          socket.terminate();
        }
        return;
      }
      const sessionToken = bearerTokenFromRequest(request);
      const principal = sessionToken ? await this.#principalFromSessionToken(sessionToken) : undefined;
      const client: SyncClient = {
        socket,
        subscriptions: new Map(),
        ...(principal ? { principal } : {}),
        ...(principal && sessionToken ? { sessionToken } : {}),
      };
      // Resolve per-tenant limits once per connection; fall back to global
      // when no principal (e.g. pre-hello unauthenticated connect).
      const resolved = principal
        ? await resolveTenantLimits(principal.tenantId, this.store, this.#limits)
        : this.#limits;
      // Per-principal connection cap: when this connection authenticates at
      // connect (bearer token), reserve a slot before any other registration
      // so an over-cap principal is rejected without touching shared state.
      // The reservation is keyed by `(tenantId, userId)`, so it isolates one
      // principal's abuse from every other principal. Connections that
      // authenticate later (via the Hello frame) are reserved in
      // `#setClientSession` instead.
      if (principal && !this.#tryReservePrincipalConnection(client, principal, resolved)) {
        this.#rejectPrincipalConnection(client, resolved);
        return;
      }
      this.#subscriptions.addClient(client);
      if (principal && sessionToken) this.#addSessionClient(sessionToken, client);
      if (principal) this.#bumpTenantCount(principal.tenantId, +1);
      this.#pendingAppendCounts.set(client, 0);
      this.#lastSeenAt.set(client, Date.now());
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
      const telemetryConnection = this.#startWebSocketTelemetryConnection(devtoolsCtx, principal);
      this.#telemetryConnections.set(client, telemetryConnection);
      emitDevToolsEvent(this.store, {
        kind: "ws.connect",
        ...(principal ? { tenantId: principal.tenantId } : {}),
        fields: {
          clientId: devtoolsCtx.clientId,
          ...(principal ? { tenantId: principal.tenantId, userId: principal.userId } : {}),
        },
      });

      const heartbeat = this.#startHeartbeat(client, socket);

      // Frame handlers are async (the storage seam is async). Serialize them
      // per connection through a promise chain so frames from one client are
      // processed strictly in arrival order — interleaving them at await
      // points could reorder appends or races a write against its own ack.
      let frameChain: Promise<void> = Promise.resolve();
      socket.on("message", (payload) => {
        this.#lastSeenAt.set(client, Date.now());
        frameChain = frameChain.then(() =>
          this.#handleRawFrame(client, socket, payload as Buffer),
        );
      });
      socket.on("close", (code) => {
        clearInterval(heartbeat);
        this.#heartbeatTimers.delete(heartbeat);
        this.#subscriptions.removeClient(client);
        this.#removeSessionClient(client);
        this.#releasePrincipalConnection(client);
        this.#telemetryConnections.delete(client);
        if (client.principal) this.#bumpTenantCount(client.principal.tenantId, -1);
        this.#activeConnections = Math.max(0, this.#activeConnections - 1);
        this.#connectionsGauge?.set(this.#activeConnections);
        this.#finishWebSocketTelemetryConnection(telemetryConnection, {
          durationMs: Date.now() - devtoolsCtx.connectedAtMs,
          frameCounts: devtoolsCtx.frameCounts,
          closeCode: code,
          closeCategory: webSocketCloseCategory(code),
        });
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
  }

  close(): void {
    for (const timer of this.#heartbeatTimers) {
      clearInterval(timer);
    }
    this.#heartbeatTimers.clear();
    this.#clientsBySessionToken.clear();
    this.#projections?.setDeltaListener(undefined);
    this.store.setWriteListener(undefined);
    this.#clusterUnsubscribe?.();
    this.#clusterUnsubscribe = undefined;
    this.#subscriptions.closeAll();
  }

  closeSession(sessionToken: string): void {
    const clients = this.#clientsBySessionToken.get(sessionToken);
    if (!clients) {
      return;
    }
    for (const client of [...clients]) {
      try {
        client.socket.close(1008, "Session revoked");
      } catch {
        client.socket.terminate();
      }
    }
    this.#clientsBySessionToken.delete(sessionToken);
  }

  /**
   * Live-disconnect every connected client belonging to `userId` — the
   * companion to {@link closeSession} for admin revocation that operates on a
   * user rather than a single token (the admin never sees the raw tokens).
   * Optionally scoped to one tenant so a multi-tenant user keeps sessions in
   * other tenants. Returns the number of connections actually closed.
   */
  closeSessionsForUser(userId: string, tenantId?: string): number {
    let closed = 0;
    for (const [token, clients] of [...this.#clientsBySessionToken.entries()]) {
      for (const client of [...clients]) {
        const principal = client.principal;
        if (!principal || principal.userId !== userId) {
          continue;
        }
        if (tenantId !== undefined && principal.tenantId !== tenantId) {
          continue;
        }
        try {
          client.socket.close(1008, "Session revoked");
        } catch {
          client.socket.terminate();
        }
        clients.delete(client);
        closed += 1;
      }
      if (clients.size === 0) {
        this.#clientsBySessionToken.delete(token);
      }
    }
    return closed;
  }

  #startWebSocketTelemetryConnection(
    devtoolsCtx: DevToolsConnectionContext,
    principal: Principal | undefined,
  ): FrickWebSocketConnectionTelemetrySpan {
    try {
      return (
        this.#telemetry?.startWebSocketConnection?.({
          clientId: devtoolsCtx.clientId,
          tenantId: principal?.tenantId,
          userId: principal?.userId,
        }) ?? { end: () => {} }
      );
    } catch {
      return { end: () => {} };
    }
  }

  #finishWebSocketTelemetryConnection(
    span: FrickWebSocketConnectionTelemetrySpan,
    result: Parameters<FrickWebSocketConnectionTelemetrySpan["end"]>[0],
  ): void {
    try {
      span.end(result);
    } catch {
      // Telemetry must never affect WebSocket cleanup.
    }
  }

  #authenticateWebSocketTelemetryConnection(client: SyncClient, principal: Principal): void {
    try {
      this.#telemetryConnections.get(client)?.authenticate?.({
        tenantId: principal.tenantId,
        userId: principal.userId,
      });
    } catch {
      // Telemetry must never affect session binding.
    }
  }

  #recordWebSocketFrameTelemetry(input: FrickWebSocketFrameTelemetry): void {
    try {
      this.#telemetry?.recordWebSocketFrame?.(input);
    } catch {
      // Telemetry must never affect frame dispatch.
    }
  }

  /**
   * Look up the per-tenant resolved limits for this client. Falls back to
   * the gateway-wide global limits when no per-connection resolution has
   * been performed (defensive — every attach() path populates the map).
   */
  #limitsFor(client: SyncClient): FrickLimits {
    return this.#clientLimits.get(client) ?? this.#limits;
  }

  #sendFrame(client: SyncClient, frame: FrickFrame): boolean {
    return sendFrame(client.socket, frame, {
      maxBufferedAmount: this.#limitsFor(client).maxWebSocketOutboundBufferedBytes,
    });
  }

  /**
   * Adjust the per-tenant subscriber refcount and, when a tenant
   * transitions between absent and present, push the updated set down
   * to a cluster bus that supports filtering. Adapters without
   * `setSubscribedTenants` are skipped — they keep the original
   * "every envelope to every node" semantics.
   */
  #bumpTenantCount(tenantId: string, delta: 1 | -1): void {
    const current = this.#tenantSubscriberCounts.get(tenantId) ?? 0;
    const next = current + delta;
    const transitioned = (current === 0) !== (next === 0);
    if (next <= 0) {
      this.#tenantSubscriberCounts.delete(tenantId);
    } else {
      this.#tenantSubscriberCounts.set(tenantId, next);
    }
    if (transitioned) {
      this.#clusterBus?.setSubscribedTenants?.(new Set(this.#tenantSubscriberCounts.keys()));
    }
  }

  /**
   * Connection-counter key for a principal. Tenant-scoped so the same
   * `userId` in two tenants is counted independently. Uses a NUL separator
   * (matching `authAttemptKey`) so ids containing other delimiters can't
   * collide across the two key components.
   */
  /**
   * Storage app id for a connection (FR-153). Resolved at Hello and pinned on
   * the client; reads/writes this connection makes are partitioned by it.
   * Defaults to {@link DEFAULT_APP_ID} for pre-Hello frames and single-app
   * servers, so a single-app deployment behaves byte-for-byte as before.
   */
  #appIdFor(client: SyncClient): string {
    return client.appId ?? DEFAULT_APP_ID;
  }

  /**
   * Build the WebRTC call-signal membership gate for a client (calls-signal-1).
   * Returns undefined when calls are disabled (no plane) — the signal relay then
   * keeps its default policy. The gate is tenant + app scoped to the connection.
   */
  #callSignalAuthorizerFor(
    client: SyncClient,
    principal: Principal,
  ): CallSignalAuthorizer | undefined {
    const plane = this.#callControlPlane;
    if (!plane) {
      return undefined;
    }
    const tenantId = principal.tenantId;
    const appId = this.#appIdFor(client);
    return {
      signalName: plane.webrtcSignalName,
      isCallMember: (callId, userId) => plane.isSignalMember(tenantId, callId, userId, appId),
    };
  }

  /**
   * Map a matched app definition's id to its *storage* app id. A genuine
   * multi-app server (registry with more than one app) partitions storage by
   * the app's `id`; a single-app server (zero or one registered app) keeps
   * every write under {@link DEFAULT_APP_ID} so existing rows and callers are
   * unaffected.
   */
  #storageAppId(matchedAppId: string | undefined): string {
    if (matchedAppId === undefined) {
      return DEFAULT_APP_ID;
    }
    const apps = this.#appRegistry?.list() ?? [];
    return apps.length > 1 ? matchedAppId : DEFAULT_APP_ID;
  }

  #principalConnectionKey(principal: Principal): string {
    return `${principal.tenantId} ${principal.userId}`;
  }

  /**
   * Try to reserve one per-principal connection slot for `client`. Returns
   * `false` (without mutating any counter) when the principal is already at
   * `limits.maxConnectionsPerPrincipal`. On success the reservation is
   * recorded so {@link SyncGateway.#releasePrincipalConnection} can release
   * exactly this slot. Idempotent per client: a client that already holds a
   * reservation for the same key keeps it without double-counting.
   */
  #tryReservePrincipalConnection(client: SyncClient, principal: Principal, limits: FrickLimits): boolean {
    const key = this.#principalConnectionKey(principal);
    if (this.#reservedPrincipalKey.get(client) === key) {
      return true;
    }
    // The principal changed (Hello rebind); drop the prior reservation first.
    this.#releasePrincipalConnection(client);
    const current = this.#connectionsByPrincipal.get(key) ?? 0;
    if (current >= limits.maxConnectionsPerPrincipal) {
      return false;
    }
    this.#connectionsByPrincipal.set(key, current + 1);
    this.#reservedPrincipalKey.set(client, key);
    return true;
  }

  /** Release the per-principal connection slot held by `client`, if any. */
  #releasePrincipalConnection(client: SyncClient): void {
    const key = this.#reservedPrincipalKey.get(client);
    if (key === undefined) {
      return;
    }
    this.#reservedPrincipalKey.delete(client);
    const current = this.#connectionsByPrincipal.get(key) ?? 0;
    const next = current - 1;
    if (next <= 0) {
      this.#connectionsByPrincipal.delete(key);
    } else {
      this.#connectionsByPrincipal.set(key, next);
    }
  }

  /**
   * Reject an over-cap connection: send a structured `rateLimit.exceeded`
   * Nack envelope, then close with code 1013 ("try again later"), mirroring
   * the global {@link FrickLimits.maxWebSocketConnections} close code. The
   * client was never registered, so no shared state needs unwinding.
   */
  #rejectPrincipalConnection(client: SyncClient, limits: FrickLimits): void {
    const envelope = createFrickErrorEnvelope({
      code: "rateLimit.exceeded",
      message: "Per-principal connection limit exceeded",
      requestId: "connect",
      retryable: true,
      details: {
        limit: "maxConnectionsPerPrincipal",
        configuredMax: limits.maxConnectionsPerPrincipal,
      },
    });
    sendFrame(client.socket, [
      FrameKind.Nack,
      { requestId: "connect", error: envelope, code: envelope.code, message: envelope.message },
    ], { maxBufferedAmount: limits.maxWebSocketOutboundBufferedBytes });
    try {
      client.socket.close(1013, "Per-principal connection limit exceeded");
    } catch {
      client.socket.terminate();
    }
  }

  publishProjectionDelta(notice: ProjectionDeltaNotice): void {
    this.#fanOutProjectionDelta(notice);
    if (this.#clusterBus) {
      this.#clusterBus.publish({
        kind: "projectionDelta",
        originNodeId: this.#clusterBus.nodeId,
        tenantId: notice.tenantId,
        projection: notice.projection,
        // Notice changes carry `value: PlainObject | null`; the
        // envelope's typing is intentionally loose so adapters can
        // serialize over whatever transport they wrap.
        changes: notice.changes as ReadonlyArray<{ key: string; value: PlainObject | null }>,
      });
    }
  }

  /** Local-only projection-delta fan-out, also reused by the cluster handler. */
  #fanOutProjectionDelta(notice: { tenantId: string; appId?: string; projection: string; changes: ProjectionDeltaNotice["changes"] }): void {
    const scopedAppId = notice.appId ?? DEFAULT_APP_ID;
    for (const { client: subscriber } of this.#subscriptions.projectionSubscribers(notice.projection)) {
      const principal = subscriber.principal;
      if (!principal || !this.#isPrincipalActive(principal)) {
        continue;
      }
      if (principal.tenantId !== notice.tenantId) {
        continue;
      }
      // App scoping (FR-153): app A's projection deltas never reach app B.
      if (this.#appIdFor(subscriber) !== scopedAppId) {
        continue;
      }
      const changes = filterProjectionChangesForPrincipal(notice.projection, notice.changes, principal);
      if (changes.length === 0) {
        continue;
      }
      this.#sendFrame(subscriber, [
        FrameKind.ProjectionDelta,
        { projection: notice.projection, changes },
      ]);
    }
  }

  /**
   * Fan out a store-level write notification (FR-114). Routes object upserts
   * to {@link publishObjects} and stream appends to {@link publishStreamEvent}
   * — the exact same wire frames and cluster-bus forwarding used for
   * client-originated mutations. Because this is the single broadcast source
   * for these writes, the value here is the *stored* (post-merge) object state
   * the store already read back, which is the correct snapshot to push to
   * other replicas regardless of merge policy.
   */
  #handleStoreWrite(event: FrickStoreWriteEvent): void {
    if (event.kind === "objectUpsert") {
      this.publishObjects(event.objectType, [event.object], event.tenantId, event.appId);
      return;
    }
    if (event.kind === "objectDelete") {
      this.publishObjectDeletes(event.objectType, [event.objectId], event.tenantId, event.appId);
      return;
    }
    this.publishStreamEvent(event.event);
    // Keep the SSE bridge fed from the same single funnel so EventSource
    // subscribers see server-originated appends too, not just client ones.
    this.options.onStreamEvent?.(event.event);
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
        this.#sendFrame(client, [FrameKind.Ping, { sentAt: Date.now() }]);
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

  publishObjects(type: string, objects: PlainObject[], tenantId?: string, appId?: string): void {
    void this.#fanOutObjects(type, objects, tenantId, appId);
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

  /**
   * Broadcast object deletions to subscribers of `type` (FR-142). Mirrors
   * {@link publishObjects}: fan out locally, then forward over the cluster bus
   * so peer nodes drop the rows for their own subscribers too.
   */
  publishObjectDeletes(type: string, ids: string[], tenantId?: string, appId?: string): void {
    this.#fanOutObjectDeletes(type, ids, tenantId, appId);
    if (this.#clusterBus && tenantId !== undefined) {
      this.#clusterBus.publish({
        kind: "objectDeletes",
        originNodeId: this.#clusterBus.nodeId,
        tenantId,
        type,
        ids: [...ids],
      });
    }
  }

  /** Local-only delete fan-out, also reused by the cluster handler. */
  #fanOutObjectDeletes(type: string, ids: string[], tenantId?: string, appId?: string): void {
    if (ids.length === 0) {
      return;
    }
    const scopedAppId = appId ?? DEFAULT_APP_ID;
    const cursor = Date.now();
    // Emit each removed id two ways in one Delta frame: as a tombstone object
    // record (an id-only object — the current SDKs decode the delta and
    // refetch, which drops the now-absent row) and as a clean `removed` list
    // (a forward-looking client drops the ids directly, no refetch). The row
    // is already gone, so there's no object state to run per-record read authz
    // against; tenant scoping is the boundary, matching the upsert path's
    // tenant filter.
    const tombstones = packObjects(
      this.store,
      type,
      ids.map((id) => ({ id })),
    );
    const removed = ids.map((id) => ({ type, id }));
    for (const { client: subscriber } of this.#subscriptions.objectSubscribers(type)) {
      const principal = subscriber.principal;
      if (!principal || !this.#isPrincipalActive(principal)) {
        continue;
      }
      if (tenantId !== undefined && principal.tenantId !== tenantId) {
        continue;
      }
      // App scoping (FR-153): only the originating app's subscribers.
      if (this.#appIdFor(subscriber) !== scopedAppId) {
        continue;
      }
      this.#sendFrame(subscriber, [
        FrameKind.Delta,
        { objects: tombstones, events: [], removed, cursor },
      ]);
    }
  }

  /** Local-only stream-event fan-out, also reused by the cluster handler. */
  #fanOutStreamEvent(event: { tenantId: string; appId?: string; stream: string; streamId: string; sequence: number }, packed: ReturnType<typeof packStreamEvent>): void {
    const appId = event.appId ?? DEFAULT_APP_ID;
    for (const { client: subscriber } of this.#subscriptions.streamSubscribers(event.stream, event.streamId)) {
      const principal = subscriber.principal;
      if (!principal || !this.#isPrincipalActive(principal) || principal.tenantId !== event.tenantId) {
        continue;
      }
      // App scoping (FR-153): a subscriber only sees stream events from its own
      // app. Single-app servers are all `_default`, so this is a no-op there.
      if (this.#appIdFor(subscriber) !== appId) {
        continue;
      }
      this.#sendFrame(subscriber, [FrameKind.Delta, { objects: [], events: [packed], cursor: event.sequence }]);
    }
  }

  /** Local-only object fan-out, also reused by the cluster handler. */
  async #fanOutObjects(type: string, objects: PlainObject[], tenantId?: string, appId?: string): Promise<void> {
    const cursor = Date.now();
    const scopedAppId = appId ?? DEFAULT_APP_ID;
    // Short-circuit: per-record read authz only changes the row set when an
    // app registered a policy hook OR a grant has ever been issued. With
    // neither, the baseline decision allows every in-tenant row, so existing
    // deployments pay no per-row decide() cost (FR-116).
    const perRecordActive = await this.#perRecordReadAuthzActive();
    for (const { client: subscriber } of this.#subscriptions.objectSubscribers(type)) {
      const principal = subscriber.principal;
      if (!principal || !this.#isPrincipalActive(principal)) {
        continue;
      }
      if (tenantId !== undefined && principal.tenantId !== tenantId) {
        continue;
      }
      // App scoping (FR-153): a subscriber only receives objects from its own
      // app. Single-app servers are all `_default`, so this never filters.
      if (this.#appIdFor(subscriber) !== scopedAppId) {
        continue;
      }
      // Tenant scoping is already applied above. The store-level visibility
      // hook (currently allow-all) is the first cut; FR-116 then adds the
      // per-record layer per subscriber: the same decide() + policy-hook +
      // grant pipeline the HTTP object read path uses for `object.read`, so a
      // denied row is never fanned out and a grant on a record makes it
      // visible to its grantee.
      const tenantVisible = objects.filter((object) =>
        this.store.isObjectVisibleToUser(principal.tenantId, type, object, principal.userId),
      );
      let visibleObjects: PlainObject[];
      if (perRecordActive) {
        visibleObjects = [];
        for (const object of tenantVisible) {
          if (await this.#canSubscriberReadObject(principal, type, object)) {
            visibleObjects.push(object);
          }
        }
      } else {
        visibleObjects = tenantVisible;
      }
      if (visibleObjects.length === 0) {
        continue;
      }
      this.#sendFrame(subscriber, [
        FrameKind.Delta,
        { objects: packObjects(this.store, type, visibleObjects), events: [], cursor },
      ]);
    }
  }

  /**
   * `true` when per-record read authorization can change the row set a
   * subscriber sees — i.e. an app registered a policy hook, or a sharing grant
   * has ever been issued. When `false`, the framework's baseline `object.read`
   * decision allows every in-tenant row, so the snapshot/fan-out paths skip
   * per-row `decide()` entirely and keep the original allow-all behavior with
   * zero per-row cost (FR-116). Cheap: a length read plus a single EXISTS probe.
   */
  async #perRecordReadAuthzActive(): Promise<boolean> {
    return this.#policyHooks.length > 0 || !(await this.store.grants.isEmptyAsync());
  }

  /**
   * Per-record read visibility for one subscriber, using the exact authz the
   * HTTP object read path uses: `object.read` baseline + app policy hooks +
   * grant relaxation. Tenant scoping is already enforced by the caller, so the
   * resource tenant matches the principal's tenant here. Objects missing a
   * string `id` are treated as readable — they cannot be keyed for a grant or
   * policy decision and the original fan-out delivered them.
   */
  async #canSubscriberReadObject(principal: Principal, type: string, object: PlainObject): Promise<boolean> {
    const id = object.id;
    if (typeof id !== "string") {
      return true;
    }
    return canSubscriberReadObjectRecord(
      principal,
      type,
      id,
      tenantMembershipReader(this.store, principal.tenantId),
      this.#policyHooks,
      this.#grantLookup,
    );
  }

  /**
   * Apply an envelope received from a peer node. Runs the same local
   * fan-out paths the originating node's `publish*` methods do, but
   * does NOT forward back to the bus — the originating node already
   * published it. Self-published envelopes are filtered upstream by
   * the bus implementation, so this only sees genuine peer traffic.
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
        void this.#fanOutObjects(envelope.type, envelope.objects as PlainObject[], envelope.tenantId);
        return;
      case "objectDeletes":
        this.#fanOutObjectDeletes(envelope.type, envelope.ids as string[], envelope.tenantId);
        return;
      case "signal":
        // Don't re-broadcast to the bus — the originating node already
        // did. `routeSignal` is the same path the local handler takes.
        routeSignal(
          this.store,
          this.#subscriptions,
          { requestId: envelope.requestId, name: envelope.name, key: envelope.key, value: envelope.value },
          envelope.tenantId,
          { maxBufferedAmount: this.#limits.maxWebSocketOutboundBufferedBytes },
        );
        return;
      case "projectionDelta":
        this.#fanOutProjectionDelta({
          tenantId: envelope.tenantId,
          projection: envelope.projection,
          changes: envelope.changes as ProjectionDeltaNotice["changes"],
        });
        return;
      case "presenceDelta":
        // Pick the "primary" key for the local-subscriber lookup. The
        // envelope carries every record + cleared key with the same
        // presence type; we fan out once per envelope under the union
        // of keys (single key in the common case).
        const key = envelope.records[0]?.key ?? envelope.cleared[0];
        if (key === undefined) return;
        this.#fanOutPresenceDelta(
          envelope.tenantId,
          envelope.name,
          key,
          envelope.records,
          envelope.cleared,
        );
        return;
    }
  }

  publishSignal(
    name: string,
    key: string,
    value: PlainObject,
    tenantId: string,
    appId: string = DEFAULT_APP_ID,
    requestId = "http",
  ): void {
    routeSignal(
      this.store,
      this.#subscriptions,
      { requestId, name, key, value },
      tenantId,
      { maxBufferedAmount: this.#limits.maxWebSocketOutboundBufferedBytes },
      appId,
    );
    if (this.#clusterBus) {
      this.#clusterBus.publish({
        kind: "signal",
        originNodeId: this.#clusterBus.nodeId,
        tenantId,
        name,
        key,
        value,
        requestId,
      });
    }
  }

  async #handleRawFrame(client: SyncClient, socket: WebSocket, payload: Buffer): Promise<void> {
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
      this.#sendFrame(client, [
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
      const kindLabel = webSocketFrameKindLabel(decoded[0]);
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
      this.#recordWebSocketFrameTelemetry({
        kind: kindLabel,
        byteLength,
        tenantId: client.principal?.tenantId,
        userId: client.principal?.userId,
      });
      await this.#handleFrame(client, decoded);
    } catch (error) {
      const envelope = createFrickErrorEnvelope({
        code: "sync.protocolError",
        message: error instanceof Error ? error.message : "Unknown frame error",
        requestId: "unknown",
        retryable: false,
      });
      this.#sendFrame(client, [
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

  async #handleFrame(client: SyncClient, frame: FrickFrame): Promise<void> {
    if (
      !this.#completedHandshakes.has(client) &&
      frame[0] !== FrameKind.Hello &&
      frame[0] !== FrameKind.Ping
    ) {
      const requestId = requestIdForPreHelloFrame(frame);
      const envelope = createFrickErrorEnvelope({
        code: "sync.protocolError",
        message: "Hello handshake required before sync frames",
        requestId,
        retryable: false,
        details: { reason: "handshakeRequired" },
        schemaHash: this.store.schema.hash,
        schemaRevision: this.store.schema.schemaRevision,
      });
      this.#sendFrame(client, [
        FrameKind.Nack,
        { requestId, error: envelope, code: envelope.code, message: envelope.message },
      ]);
      return;
    }

    switch (frame[0]) {
      case FrameKind.Hello: {
        if (
          !(await this.#authenticateHelloSession(client, frame[1].sessionToken, {
            deviceId: frame[1].deviceId,
            replicaId: frame[1].replicaId,
          }))
        ) {
          return;
        }

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
        // Pin the storage app id for this connection (FR-153). In single-app
        // mode this stays `_default`; in a genuine multi-app server it is the
        // matched app's id, so every store read/write this connection makes is
        // partitioned by the originating app.
        client.appId = this.#storageAppId(targetAppId);

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
            this.#sendFrame(client, [
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
          this.#sendFrame(client, [
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
          this.#sendFrame(client, [
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
        await this.#handleSubscribe(client, frame[1]);
        return;
      case FrameKind.Append:
        await this.#handleAppend(client, frame[1]);
        return;
      case FrameKind.ObjectUpsert:
        await this.#handleObjectUpsert(client, frame[1]);
        return;
      case FrameKind.PresenceSet:
        await this.#handlePresenceSet(client, frame[1]);
        return;
      case FrameKind.PresenceClear:
        await this.#handlePresenceClear(client, frame[1]);
        return;
      case FrameKind.SignalSend:
        await this.#handleSignal(client, frame[1]);
        return;
      case FrameKind.CallCommand:
        await this.#handleCallCommand(client, frame[1]);
        return;
      case FrameKind.CursorCommit:
        this.#sendFrame(client, [FrameKind.Ack, { requestId: frame[1].subscriptionId, cursor: frame[1].cursor }]);
        return;
      case FrameKind.Ping:
        this.#sendFrame(client, [FrameKind.Pong, { sentAt: frame[1].sentAt, receivedAt: Date.now() }]);
        return;
      default:
        return;
    }
  }

  async #handleSubscribe(client: SyncClient, payload: SubscribePayload): Promise<void> {
    const principal = await this.#activePrincipalForFrame(client, payload.subscriptionId);
    if (!principal) {
      return;
    }
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
      this.#sendFrame(client, [
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
        this.#sendFrame(client, [
          FrameKind.Nack,
          { requestId: payload.subscriptionId, error: envelope, code: envelope.code, message: envelope.message },
        ]);
        return;
      }
    }
    try {
      await assertCanSubscribe(
        principal,
        payload.kind,
        payload.name,
        payload.key,
        tenantMembershipReader(this.store, principal.tenantId),
        this.#policyHooks,
        this.#cascadeGrantLookup,
        this.#callSignalAuthorizerFor(client, principal),
      );
    } catch (error) {
      if (this.#sendAuthNack(client, payload.subscriptionId, error)) {
        return;
      }
      throw error;
    }
    this.#subscriptions.addSubscription(client, payload);

    if (payload.kind === "projection") {
      // Deliver an initial snapshot of the projection's current rows scoped
      // to this principal's tenant. The wire shape is a ProjectionDelta frame
      // whose changes each upsert one row — the client applies them exactly
      // like an incremental delta, so no separate snapshot frame is needed.
      // Cross-tenant rows are never included because `snapshot()` is
      // tenant-keyed; we still run the per-principal change filter to mirror
      // the live fan-out path.
      const rows = this.#projections?.snapshot(payload.name, principal.tenantId) ?? [];
      const changes = filterProjectionChangesForPrincipal(payload.name, rows, principal);
      this.#sendFrame(client, [
        FrameKind.ProjectionDelta,
        { projection: payload.name, changes },
      ]);
      return;
    }

    if (payload.kind === "stream") {
      const key = requireKey(payload);
      const cursor = payload.cursor ?? 0;
      const pageLimit = clientLimits.maxStreamPageSize;
      const page = await this.store.readEvents(principal.tenantId, payload.name, key, cursor, pageLimit + 1, this.#appIdFor(client));
      const hasMore = page.length > pageLimit;
      const events = page.slice(0, pageLimit).map((event) => packStreamEvent(this.store.schema, event));
      this.#sendFrame(client, [
        FrameKind.StreamPage,
        {
          subscriptionId: payload.subscriptionId,
          events,
          cursor: events.at(-1)?.[2] ?? cursor,
          hasMore,
        },
      ]);
      return;
    }

    if (payload.kind === "object") {
      // The initial snapshot is tenant-scoped at the store layer
      // (listObjectsForUser), then filtered per-record for THIS subscriber with
      // the same decide() + policy-hook + grant pipeline the live delta fan-out
      // and the HTTP object read path use (FR-116). Rows the subscriber is not
      // authorized to read are omitted; a grant on a record makes it visible to
      // the grantee. Skipped entirely (allow-all) when no policy hook or grant
      // is configured — see #perRecordReadAuthzActive / #fanOutObjects.
      const tenantRows = await this.store.listObjectsForUser(
        principal.tenantId,
        payload.name,
        principal.userId,
        this.#appIdFor(client),
      );
      let visibleRows: PlainObject[];
      if (await this.#perRecordReadAuthzActive()) {
        visibleRows = [];
        for (const object of tenantRows) {
          if (await this.#canSubscriberReadObject(principal, payload.name, object)) {
            visibleRows.push(object);
          }
        }
      } else {
        visibleRows = tenantRows;
      }
      const objects = packObjects(this.store, payload.name, visibleRows);
      this.#sendFrame(client, [FrameKind.Snapshot, { subscriptionId: payload.subscriptionId, objects, cursor: 0 }]);
    }
  }

  #sendHelloSuccess(
    client: SyncClient,
    schemaCompatibility: SchemaCompatibilityResult,
    schema: FrickSchema = this.store.schema,
  ): void {
    this.#sendFrame(client, [
      FrameKind.HelloAck,
      {
        schemaHash: schema.hash,
        schemaId: schema.schemaId,
        schemaRevision: schema.schemaRevision,
        schemaCompatibility,
        serverCapabilities: defaultServerCapabilities(schema),
      },
    ]);
    this.#completedHandshakes.add(client);
    this.#sendFrame(client, [FrameKind.Schema, schema]);
  }

  async #handleAppend(client: SyncClient, payload: AppendPayload): Promise<void> {
    const principal = await this.#activePrincipalForFrame(client, payload.requestId);
    if (!principal) {
      return;
    }
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
      this.#sendFrame(client, [
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
      this.#sendFrame(client, [
        FrameKind.Nack,
        { requestId: payload.requestId, error: envelope, code: envelope.code, message: envelope.message },
      ]);
      return;
    }

    this.#pendingAppendCounts.set(client, pending + 1);
    try {
      try {
        await assertCanAppend(
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
      const result = await this.store.appendEvent({
        tenantId: principal.tenantId,
        appId: this.#appIdFor(client),
        requestId: payload.requestId,
        replicaId: principal.replicaId,
        stream: payload.stream,
        streamId: payload.key,
        event: payload.event,
        payload: payload.payload,
      });
      this.#sendFrame(client, [FrameKind.Ack, { requestId: payload.requestId, cursor: result.event.sequence }]);

      // No inline broadcast here: `appendEvent` fires the store write listener
      // on a created event, which fans it out to gateway subscribers, the SSE
      // bridge, and the cluster bus through the single funnel in
      // `#handleStoreWrite`. Broadcasting here too would double-fire (FR-114).
    } finally {
      this.#pendingAppendCounts.set(client, Math.max(0, (this.#pendingAppendCounts.get(client) ?? 1) - 1));
    }
  }

  async #handleObjectUpsert(client: SyncClient, payload: ObjectUpsertPayload): Promise<void> {
    const principal = await this.#activePrincipalForFrame(client, payload.requestId);
    if (!principal) {
      return;
    }

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
      this.#sendFrame(client, [
        FrameKind.Nack,
        { requestId: payload.requestId, error: envelope, code: envelope.code, message: envelope.message },
      ]);
      return;
    }

    this.#pendingAppendCounts.set(client, pending + 1);
    try {
      try {
        await assertCanWriteObject(
          principal,
          payload.objectType,
          payload.objectId,
          tenantMembershipReader(this.store, principal.tenantId),
          this.#policyHooks,
          payload.value,
          this.#grantLookup,
        );
      } catch (error) {
        if (this.#sendAuthNack(client, payload.requestId, error)) {
          return;
        }
        throw error;
      }

      const mergePolicy = this.store.objectMergePolicy(payload.objectType);
      try {
        const result = await this.store.upsertObjectWithPolicy({
          tenantId: principal.tenantId,
          appId: this.#appIdFor(client),
          type: payload.objectType,
          id: payload.objectId,
          value: payload.value,
          ...(payload.expectedVersion !== undefined ? { expectedVersion: payload.expectedVersion } : {}),
        });
        this.#sendFrame(client, [
          FrameKind.Ack,
          { requestId: payload.requestId, version: result.nextVersion },
        ]);
        // No inline broadcast here: `upsertObjectWithPolicy` fires the store
        // write listener, which fans this upsert out (and onto the cluster
        // bus) through the single funnel in `#handleStoreWrite`. Broadcasting
        // here too would deliver the delta twice (FR-114).
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
          this.#sendFrame(client, [
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

  async #handlePresenceSet(client: SyncClient, payload: PresenceSetPayload): Promise<void> {
    const principal = await this.#activePrincipalForFrame(client, payload.requestId);
    if (!principal) {
      return;
    }
    try {
      await assertCanWritePresence(
        principal,
        payload.name,
        payload.key,
        tenantMembershipReader(this.store, principal.tenantId),
        this.#policyHooks,
        payload.value,
      );
    } catch (error) {
      if (this.#sendAuthNack(client, payload.requestId, error)) {
        return;
      }
      throw error;
    }
    const presence = presenceByName(this.store.schema, payload.name);
    const ttlSeconds = presence.ttlMs / 1000;
    const clampedSeconds = clampTtlSeconds(
      ttlSeconds,
      this.#limits.presenceTtlMinSeconds,
      this.#limits.presenceTtlMaxSeconds,
      (from, to) => console.warn(`Clamped presence TTL for ${payload.name} from ${from}s to ${to}s`),
    );
    const presenceAppId = this.#appIdFor(client);
    await this.store.setPresence(
      principal.tenantId,
      payload.name,
      payload.key,
      payload.value,
      clampedSeconds * 1000,
      presenceAppId,
    );
    this.#fanOutPresenceDelta(principal.tenantId, payload.name, payload.key, [
      { key: payload.key, value: payload.value },
    ], [], presenceAppId);
    if (this.#clusterBus) {
      this.#clusterBus.publish({
        kind: "presenceDelta",
        originNodeId: this.#clusterBus.nodeId,
        tenantId: principal.tenantId,
        name: payload.name,
        records: [{ key: payload.key, value: payload.value }],
        cleared: [],
      });
    }
    this.#sendFrame(client, [FrameKind.Ack, { requestId: payload.requestId }]);
  }

  async #handlePresenceClear(client: SyncClient, payload: PresenceClearPayload): Promise<void> {
    const principal = await this.#activePrincipalForFrame(client, payload.requestId);
    if (!principal) {
      return;
    }
    try {
      await assertCanWritePresence(
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
    const clearAppId = this.#appIdFor(client);
    await this.store.clearPresence(principal.tenantId, payload.name, payload.key, clearAppId);
    this.#fanOutPresenceDelta(principal.tenantId, payload.name, payload.key, [], [payload.key], clearAppId);
    if (this.#clusterBus) {
      this.#clusterBus.publish({
        kind: "presenceDelta",
        originNodeId: this.#clusterBus.nodeId,
        tenantId: principal.tenantId,
        name: payload.name,
        records: [],
        cleared: [payload.key],
      });
    }
    this.#sendFrame(client, [FrameKind.Ack, { requestId: payload.requestId }]);
  }

  /**
   * Local-only presence-delta fan-out, also reused by the cluster
   * handler. The wire form carries packed records per subscription —
   * the subscription id comes from the local subscriber, not the
   * envelope, so this is a per-node operation.
   */
  #fanOutPresenceDelta(
    tenantId: string,
    name: string,
    key: string,
    records: ReadonlyArray<{ key: string; value: PlainObject | null }>,
    cleared: readonly string[],
    appId: string = DEFAULT_APP_ID,
  ): void {
    const packed = records
      .filter((r): r is { key: string; value: PlainObject } => r.value !== null)
      .map((r) => packPresenceRecord(this.store.schema, name, r.key, r.value));
    for (const { client: subscriber, subscription } of this.#subscriptions.presenceSubscribers(name, key)) {
      const principal = subscriber.principal;
      if (!principal || !this.#isPrincipalActive(principal) || principal.tenantId !== tenantId) {
        continue;
      }
      // App isolation (FR-153): a presence delta produced under one app must
      // never reach a subscriber pinned to a different app.
      if (this.#appIdFor(subscriber) !== appId) {
        continue;
      }
      this.#sendFrame(subscriber, [
        FrameKind.PresenceDelta,
        { subscriptionId: subscription.subscriptionId, records: packed, cleared: [...cleared] },
      ]);
    }
  }

  async #handleSignal(client: SyncClient, payload: SignalPayload): Promise<void> {
    const principal = await this.#activePrincipalForFrame(client, payload.requestId);
    if (!principal) {
      return;
    }
    try {
      await assertCanSignal(
        principal,
        payload.name,
        payload.key,
        tenantMembershipReader(this.store, principal.tenantId),
        this.#policyHooks,
        this.#callSignalAuthorizerFor(client, principal),
      );
    } catch (error) {
      if (this.#sendAuthNack(client, payload.requestId, error)) {
        return;
      }
      throw error;
    }
    const signalAppId = this.#appIdFor(client);
    await this.store.enqueueSignal(
      principal.tenantId,
      payload.name,
      payload.key,
      payload.value,
      undefined,
      signalAppId,
    );
    await routeSignal(
      this.store,
      this.#subscriptions,
      payload,
      principal.tenantId,
      { maxBufferedAmount: this.#limitsFor(client).maxWebSocketOutboundBufferedBytes },
      signalAppId,
    );
    this.#sendFrame(client, [FrameKind.Ack, { requestId: payload.requestId }]);
  }

  /**
   * FR-15 — route a call control-plane command to the {@link CallControlPlane}.
   *
   * The principal supplies the {@link CallActor} (tenant + user + device), so
   * the control plane enforces its own tenant-scoped authz on top of the
   * connection's authentication. Success replies with a typed
   * {@link FrameKind.CallCommandResult}; a `CallStateError`/`CallAuthzError`
   * comes back as a {@link FrameKind.Nack} keyed by the same `requestId`, so
   * clients reuse their existing Ack/Nack correlation. Calls disabled →
   * `auth.forbidden` nack.
   */
  async #handleCallCommand(client: SyncClient, payload: CallCommandPayload): Promise<void> {
    const principal = await this.#activePrincipalForFrame(client, payload.requestId);
    if (!principal) {
      return;
    }
    const plane = this.#callControlPlane;
    if (!plane) {
      const envelope = createFrickErrorEnvelope({
        code: "auth.forbidden",
        message: "Calls are not enabled on this server",
        requestId: payload.requestId,
        retryable: false,
        details: { reason: "callsDisabled" },
      });
      this.#sendFrame(client, [
        FrameKind.Nack,
        { requestId: payload.requestId, error: envelope, code: envelope.code, message: envelope.message },
      ]);
      return;
    }
    const actor: CallActor = {
      tenantId: principal.tenantId,
      userId: principal.userId,
      deviceId: principal.deviceId,
      // FR-153 app isolation: scope every call record/event to the connection's
      // app so calls are app-partitioned like objects/streams/presence
      // (calls-isolation-1).
      appId: this.#appIdFor(client),
    };
    const command = payload.command;
    try {
      let result: CallCommandResultPayload;
      switch (command.op) {
        case "create": {
          // calls-authz-1: gate creation on tenant-membership of creator +
          // invitees and any app conversation-membership policy hook, reusing
          // the same machinery the object/signal paths use.
          await assertCanCreateCall(
            principal,
            command.conversationId,
            command.inviteeUserIds,
            tenantMembershipReader(this.store, principal.tenantId),
            this.#policyHooks,
          );
          const created = await plane.createCall(actor, {
            conversationId: command.conversationId,
            inviteeUserIds: command.inviteeUserIds,
            ...(command.kind !== undefined ? { kind: command.kind } : {}),
            ...(command.regionHint !== undefined ? { regionHint: command.regionHint } : {}),
          });
          result = { requestId: payload.requestId, op: "create", room: created.room, invites: created.invites };
          break;
        }
        case "join": {
          const joined = await plane.joinCall(actor, command.callId);
          result = {
            requestId: payload.requestId,
            op: "join",
            room: joined.room,
            participant: joined.participant,
            mediaGrant: joined.mediaGrant,
          };
          break;
        }
        case "accept": {
          const invite = await plane.acceptInvite(actor, command.callId);
          result = { requestId: payload.requestId, op: "accept", invite };
          break;
        }
        case "leave": {
          const room = await plane.leaveCall(actor, command.callId);
          result = { requestId: payload.requestId, op: "leave", room };
          break;
        }
        case "end": {
          const room = await plane.endCall(actor, command.callId);
          result = { requestId: payload.requestId, op: "end", room };
          break;
        }
        case "setMediaState": {
          const participant = await plane.setMediaState(actor, command.callId, command.media);
          result = { requestId: payload.requestId, op: "setMediaState", participant };
          break;
        }
        case "sfuConnectTransport": {
          // FR-155: forward DTLS handshake to the SFU media plane. Non-SFU
          // planes throw CallMediaUnsupportedError → Nack.
          await plane.sfuConnectTransport(
            actor,
            command.callId,
            command.token,
            command.transportId,
            // Opaque client-supplied DTLS params, forwarded verbatim to mediasoup.
            command.dtlsParameters as unknown as DtlsParameters,
          );
          result = { requestId: payload.requestId, op: "sfuConnectTransport" };
          break;
        }
        case "sfuProduce": {
          const producer = await plane.sfuProduce(
            actor,
            command.callId,
            command.token,
            command.transportId,
            command.kind,
            command.rtpParameters,
          );
          result = {
            requestId: payload.requestId,
            op: "sfuProduce",
            producer: { producerId: producer.id, kind: producer.kind },
          };
          break;
        }
        case "sfuConsume": {
          const consumer = await plane.sfuConsume(
            actor,
            command.callId,
            command.token,
            command.transportId,
            command.producerId,
            command.rtpCapabilities,
          );
          result = {
            requestId: payload.requestId,
            op: "sfuConsume",
            consumer: {
              consumerId: consumer.id,
              producerId: consumer.producerId,
              kind: consumer.kind,
              rtpParameters: consumer.rtpParameters,
            },
          };
          break;
        }
        default: {
          const _exhaustive: never = command;
          void _exhaustive;
          return;
        }
      }
      this.#sendFrame(client, [FrameKind.CallCommandResult, result]);
    } catch (error) {
      this.#sendCallCommandNack(client, payload.requestId, error);
    }
  }

  /**
   * Map a call control-plane failure to a {@link FrameKind.Nack}. State errors
   * (`callNotFound`, `callEnded`, ...) and authz errors (`notCreator`,
   * `notInvitee`, ...) carry a stable `reason` in `details` so the client can
   * branch without parsing the message. Unexpected errors re-throw so the
   * frame loop's outer catch surfaces them.
   */
  #sendCallCommandNack(client: SyncClient, requestId: string, error: unknown): void {
    // Authorization/authentication failures from the call-creation membership
    // gate (calls-authz-1) map to the standard auth nack shape.
    if (this.#sendAuthNack(client, requestId, error)) {
      return;
    }
    if (error instanceof CallAuthzError) {
      const envelope = createFrickErrorEnvelope({
        code: "auth.forbidden",
        message: error.message,
        requestId,
        retryable: false,
        details: { reason: error.reason },
      });
      this.#sendFrame(client, [
        FrameKind.Nack,
        { requestId, error: envelope, code: envelope.code, message: envelope.message },
      ]);
      return;
    }
    if (error instanceof CallStateError || error instanceof CallMediaUnsupportedError) {
      const envelope = createFrickErrorEnvelope({
        code: "sync.protocolError",
        message: error.message,
        requestId,
        retryable: false,
        details: { reason: error.reason },
      });
      this.#sendFrame(client, [
        FrameKind.Nack,
        { requestId, error: envelope, code: envelope.code, message: envelope.message },
      ]);
      return;
    }
    throw error;
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
    this.#sendFrame(client, [
      FrameKind.Nack,
      { requestId, error: envelope, code: envelope.code, message: envelope.message },
    ]);
    return true;
  }

  async #activePrincipalForFrame(client: SyncClient, requestId: string): Promise<Principal | undefined> {
    let principal = client.principal;
    if (!principal) {
      this.#sendAuthNack(client, requestId, new AuthenticationError("Missing session token"));
      return undefined;
    }
    if (client.sessionToken) {
      const active = await this.#principalFromActiveSessionToken(client.sessionToken);
      if (active instanceof AuthenticationError) {
        this.#sendAuthNack(client, requestId, active);
        try {
          client.socket.close(1008, active.message);
        } catch {
          // socket already closing
        }
        return undefined;
      }
      if (!samePrincipal(principal, active)) {
        this.#sendAuthNack(
          client,
          requestId,
          new AuthorizationError({
            allow: false,
            reason: "notAuthorizedForResource",
            publicMessage: "Session principal changed",
          }),
        );
        try {
          client.socket.close(1008, "Session principal changed");
        } catch {
          // socket already closing
        }
        return undefined;
      }
      client.principal = active;
      principal = active;
    }
    if (!this.#isPrincipalActive(principal)) {
      this.#sendAuthNack(client, requestId, new AuthenticationError("Tenant is archived"));
      try {
        client.socket.close(1008, "Tenant is archived");
      } catch {
        // socket already closing
      }
      return undefined;
    }
    return principal;
  }

  async #authenticateHelloSession(
    client: SyncClient,
    sessionToken: string | undefined,
    helloDevice?: { deviceId: string; replicaId: string },
  ): Promise<boolean> {
    if (!sessionToken) {
      return true;
    }
    const principal = await this.#principalFromSessionToken(sessionToken);
    if (!principal) {
      this.#sendHelloAuthNack(client, {
        code: "auth.unauthenticated",
        message: "Invalid session token",
        reason: "unauthenticated",
      });
      return false;
    }
    // Server-side device binding (FR-32, opt-in). The principal's
    // `deviceId`/`replicaId` are derived from the `auth_sessions` ROW, not from
    // the client. When binding is enabled, a Hello that presents a valid token
    // from a *different* device (or replica) is rejected so the client is
    // forced to re-authenticate and mint a session bound to its own device.
    // Default-off keeps existing FrickSwift/web flows unchanged.
    if (this.#limits.bindSessionDevice && helloDevice && !this.#helloMatchesBoundDevice(principal, helloDevice)) {
      this.#sendHelloAuthNack(client, {
        code: "auth.unauthenticated",
        message: "Session is bound to a different device; re-authenticate",
        reason: "sessionDeviceMismatch",
      });
      return false;
    }
    if (client.principal && !samePrincipal(client.principal, principal)) {
      this.#sendHelloAuthNack(client, {
        code: "auth.forbidden",
        message: "Hello session token does not match the connection principal",
        reason: "notAuthorizedForResource",
      });
      return false;
    }

    // Enforce the per-principal connection cap for Hello-authenticated
    // connections. Connections that authenticated at connect already hold a
    // reservation for this principal — the reserve call is idempotent for the
    // same `(tenantId, userId)` key, so it returns true without re-counting.
    const reservationLimits = await resolveTenantLimits(principal.tenantId, this.store, this.#limits);
    if (!this.#tryReservePrincipalConnection(client, principal, reservationLimits)) {
      this.#rejectHelloPrincipalConnection(client, reservationLimits);
      return false;
    }

    await this.#setClientSession(client, sessionToken, principal);
    return true;
  }

  /**
   * FR-32: does the device claimed in the Hello frame match the device the
   * session token is bound to? `principal` carries the bound `deviceId`/
   * `replicaId` read from the `auth_sessions` row. Both must match.
   */
  #helloMatchesBoundDevice(
    principal: Principal,
    helloDevice: { deviceId: string; replicaId: string },
  ): boolean {
    return (
      principal.deviceId === helloDevice.deviceId &&
      principal.replicaId === helloDevice.replicaId
    );
  }

  /**
   * Reject a Hello whose principal is over the per-principal connection cap.
   * Sends a structured `rateLimit.exceeded` Nack keyed to the `hello` request
   * id, then closes with 1013 — mirroring the connect-time rejection.
   */
  #rejectHelloPrincipalConnection(client: SyncClient, limits: FrickLimits): void {
    const envelope = createFrickErrorEnvelope({
      code: "rateLimit.exceeded",
      message: "Per-principal connection limit exceeded",
      requestId: "hello",
      retryable: true,
      details: {
        limit: "maxConnectionsPerPrincipal",
        configuredMax: limits.maxConnectionsPerPrincipal,
      },
    });
    this.#sendFrame(client, [
      FrameKind.Nack,
      { requestId: "hello", error: envelope, code: envelope.code, message: envelope.message },
    ]);
    try {
      client.socket.close(1013, "Per-principal connection limit exceeded");
    } catch {
      // socket already closing
    }
  }

  #sendHelloAuthNack(
    client: SyncClient,
    input: {
      code: "auth.unauthenticated" | "auth.forbidden";
      message: string;
      reason: "unauthenticated" | "notAuthorizedForResource" | "sessionDeviceMismatch";
    },
  ): void {
    const envelope = createFrickErrorEnvelope({
      code: input.code,
      message: input.message,
      requestId: "hello",
      retryable: false,
      details: { reason: input.reason },
    });
    this.#sendFrame(client, [
      FrameKind.Nack,
      { requestId: "hello", error: envelope, code: envelope.code, message: envelope.message },
    ]);
    try {
      client.socket.close(1008, input.message);
    } catch {
      // socket already closing
    }
  }

  async #principalFromSessionToken(token: string): Promise<Principal | undefined> {
    const principal = await this.#principalFromActiveSessionToken(token);
    return principal instanceof AuthenticationError ? undefined : principal;
  }

  async #principalFromActiveSessionToken(token: string): Promise<Principal | AuthenticationError> {
    const session = await this.store.readActiveSession(token);
    if (!session) {
      const stale = await this.store.readAnySession(token);
      if (stale && Date.parse(stale.expiresAt) <= Date.now()) {
        return new SessionExpiredError();
      }
      return new AuthenticationError("Invalid or expired session token");
    }
    if (!await this.#isTenantActive(session.tenantId)) {
      return new AuthenticationError("Tenant is archived");
    }
    return {
      userId: session.userId,
      deviceId: session.deviceId,
      replicaId: session.replicaId,
      tenantId: session.tenantId,
    };
  }

  async #setClientSession(client: SyncClient, sessionToken: string, principal: Principal): Promise<void> {
    if (!client.principal) {
      this.#bumpTenantCount(principal.tenantId, +1);
    }
    if (client.sessionToken !== sessionToken) {
      this.#removeSessionClient(client);
      client.sessionToken = sessionToken;
      this.#addSessionClient(sessionToken, client);
    }
    client.principal = principal;
    this.#clientLimits.set(client, await resolveTenantLimits(principal.tenantId, this.store, this.#limits));
    this.#authenticateWebSocketTelemetryConnection(client, principal);
  }

  #addSessionClient(sessionToken: string, client: SyncClient): void {
    let clients = this.#clientsBySessionToken.get(sessionToken);
    if (!clients) {
      clients = new Set();
      this.#clientsBySessionToken.set(sessionToken, clients);
    }
    clients.add(client);
  }

  #removeSessionClient(client: SyncClient): void {
    const token = client.sessionToken;
    if (!token) {
      return;
    }
    const clients = this.#clientsBySessionToken.get(token);
    clients?.delete(client);
    if (clients && clients.size === 0) {
      this.#clientsBySessionToken.delete(token);
    }
    delete client.sessionToken;
  }

  #isPrincipalActive(principal: Principal): boolean {
    return principal.scope === "admin" || !principal.tenantId.startsWith("_archived_");
  }

  async #isTenantActive(tenantId: string): Promise<boolean> {
    return (await this.store.tenants.get(tenantId))?.archivedAt === undefined;
  }
}

function samePrincipal(left: Principal, right: Principal): boolean {
  return (
    left.userId === right.userId &&
    left.deviceId === right.deviceId &&
    left.replicaId === right.replicaId &&
    left.tenantId === right.tenantId
  );
}

function bearerTokenFromRequest(request: IncomingMessage): string | undefined {
  const raw = request.headers.authorization;
  const auth = Array.isArray(raw) ? raw[0] : raw;
  return /^Bearer\s+(.+)$/i.exec(auth ?? "")?.[1];
}

function requestIdForPreHelloFrame(frame: FrickFrame): string {
  switch (frame[0]) {
    case FrameKind.Subscribe:
    case FrameKind.CursorCommit:
      return frame[1].subscriptionId;
    case FrameKind.Append:
    case FrameKind.ObjectUpsert:
    case FrameKind.PresenceSet:
    case FrameKind.PresenceClear:
    case FrameKind.SignalSend:
      return frame[1].requestId;
    default:
      return "pre-hello";
  }
}

function webSocketFrameKindLabel(kind: unknown): string {
  if (typeof kind !== "number" || !Number.isInteger(kind)) {
    return "unknown";
  }
  const label = FrameKind[kind];
  return typeof label === "string" ? label : "unknown";
}

function webSocketCloseCategory(code: number | undefined): FrickWebSocketCloseCategory {
  switch (code) {
    case 1000:
      return "normal";
    case 1001:
      return "going_away";
    case 1002:
      return "protocol_error";
    case 1003:
      return "unsupported_data";
    case 1005:
      return "no_status";
    case 1006:
      return "abnormal";
    case 1007:
      return "invalid_payload";
    case 1008:
      return "policy_violation";
    case 1009:
      return "too_large";
    case 1010:
      return "mandatory_extension";
    case 1011:
      return "internal_error";
    case 1012:
      return "service_restart";
    case 1013:
      return "try_again_later";
    case 1014:
      return "bad_gateway";
    case 1015:
      return "tls_handshake";
    default:
      if (code !== undefined && code >= 4000 && code <= 4999) {
        return "private";
      }
      return "unknown";
  }
}

function filterProjectionChangesForPrincipal(
  projection: string,
  changes: ProjectionDeltaNotice["changes"],
  principal: Principal,
): ProjectionDeltaNotice["changes"] {
  void projection;
  void principal;
  return changes;
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
