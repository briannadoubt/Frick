import {
  FrameKind,
  decodeFrame,
  defaultClientCapabilities,
  encodeFrame,
  foundationSchema,
  unpackObjectRecord,
  unpackPresenceRecord,
  unpackSignalEnvelope,
  unpackStreamEvent,
  type FrickFrame,
  type FrickErrorEnvelope,
  type FrickObjectMergePolicy,
  type FrickSchema,
  type FrickServerCapabilities,
  type PlainObject,
  type SchemaCompatibilityResult,
  type StreamEventInput,
} from "@frick/protocol";
import {
  MemoryFrickCache,
  type FrickCacheScope,
  type FrickLocalCache,
  type PendingAppend,
} from "./cache.js";
import { Signal, objectKey, streamKey } from "./subscriptions.js";
import { resolveHttpEndpoint } from "./http.js";
import { OptimisticConflictError, OptimisticOverlay } from "./optimistic.js";
import {
  trackAnalyticsEvent,
  type AnalyticsTrackOptions,
  type AnalyticsTrackReceipt,
} from "./analytics.js";

const SOCKET_OPEN = 1;
const HELLO_ACK_FRAME_KIND = (FrameKind as typeof FrameKind & { HelloAck?: number }).HelloAck ?? 18;

type HelloAckFrame = [
  typeof HELLO_ACK_FRAME_KIND,
  {
    serverCapabilities: FrickServerCapabilities;
    schemaCompatibility: SchemaCompatibilityResult;
  },
];

export interface SyncStatus {
  connected: boolean;
  cursors: Record<string, number>;
  pendingMutations: number;
  authenticated: boolean;
  userId?: string | undefined;
  deviceId?: string | undefined;
  serverCapabilities?: FrickServerCapabilities;
  schemaCompatibility?: SchemaCompatibilityResult;
  lastError?: FrickErrorEnvelope | undefined;
}

export interface FrickSession {
  schemaHash: string;
  sessionToken: string;
  tenantId?: string;
  userId: string;
  deviceId: string;
  replicaId: string;
  expiresAt: string;
}

export interface FrickClientOptions {
  endpoint: string;
  /** Optional HTTP endpoint for REST/SSE helpers. Defaults to the WebSocket origin. */
  httpEndpoint?: string;
  schema?: FrickSchema;
  cache?: FrickLocalCache;
  /** Initial reconnect delay, in ms. Subsequent attempts back off up to {@link maxReconnectDelayMs}. */
  reconnectDelayMs?: number;
  /** Cap for the reconnect backoff. Defaults to 30_000ms. */
  maxReconnectDelayMs?: number;
  replicaId?: string;
  deviceId?: string;
  session?: FrickSession | null | undefined;
  sessionToken?: string | undefined;
  WebSocketImpl?: typeof WebSocket;
  /** Maximum number of unacknowledged appends queued before rejecting new ones. Defaults to 1_000. */
  maxPendingAppends?: number;
}

export class FrickClientLimitError extends Error {
  readonly envelope: FrickErrorEnvelope;
  constructor(envelope: FrickErrorEnvelope) {
    super(envelope.message);
    this.name = "FrickClientLimitError";
    this.envelope = envelope;
  }
}

export class FrickUserStateClearedError extends Error {
  constructor(message = "Frick user state was cleared") {
    super(message);
    this.name = "FrickUserStateClearedError";
  }
}

/**
 * Thrown when an upsertObject over the sync socket loses a versionPrecondition
 * race. `expectedVersion` echoes the value the client sent (omitted on
 * create-intent attempts); `actualVersion` reports the on-disk row's version.
 */
export class FrickObjectConflictError extends Error {
  readonly envelope: FrickErrorEnvelope;
  readonly expectedVersion: number | undefined;
  readonly actualVersion: number;
  readonly mergePolicy: FrickObjectMergePolicy;
  constructor(args: {
    envelope: FrickErrorEnvelope;
    expectedVersion: number | undefined;
    actualVersion: number;
    mergePolicy: FrickObjectMergePolicy;
  }) {
    super(args.envelope.message);
    this.name = "FrickObjectConflictError";
    this.envelope = args.envelope;
    this.expectedVersion = args.expectedVersion;
    this.actualVersion = args.actualVersion;
    this.mergePolicy = args.mergePolicy;
  }
}

interface PendingUpsert {
  requestId: string;
  objectType: string;
  objectId: string;
  value: PlainObject;
  expectedVersion?: number;
  resolve: (result: { version: number }) => void;
  reject: (error: Error) => void;
}

export class FrickClient {
  readonly schema: FrickSchema;
  readonly syncStatus = new Signal<SyncStatus>({
    connected: false,
    cursors: {},
    pendingMutations: 0,
    authenticated: false,
  });

  readonly #endpoint: string;
  readonly #httpEndpoint: string;
  readonly #cache: FrickLocalCache;
  #replicaId: string;
  #deviceId: string;
  #session: FrickSession | undefined;
  #sessionToken: string | undefined;
  readonly #reconnectDelayMs: number;
  readonly #maxReconnectDelayMs: number;
  readonly #maxPendingAppends: number;
  readonly #WebSocketImpl: typeof WebSocket | undefined;

  #socket: WebSocket | undefined;
  #manualDisconnect = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectAttempts = 0;
  #objects = new Map<string, PlainObject>();
  #streams = new Map<string, StreamEventInput[]>();
  #pendingAppends = new Map<string, PendingAppend>();
  #pendingUpserts = new Map<string, PendingUpsert>();
  #objectListSignals = new Map<string, Signal<PlainObject[]>>();
  #streamSignals = new Map<string, Signal<StreamEventInput[]>>();
  #presenceSignals = new Map<string, Signal<PlainObject | undefined>>();
  #signalSignals = new Map<string, Signal<PlainObject[]>>();
  #projectionRows = new Map<string, Map<string, PlainObject>>();
  #projectionSignals = new Map<string, Signal<Map<string, PlainObject>>>();

  /**
   * Per-mutation resolve/reject hooks. `append()` returns a Promise that the
   * runtime settles when the corresponding Ack or Nack arrives. Keeps the
   * existing fire-and-forget behavior as the default — callers that don't
   * await the returned Promise behave identically.
   */
  #appendResolvers = new Map<string, { resolve: () => void; reject: (err: unknown) => void }>();
  /** Optimistic overlay merged into stream + object signals at publish time. */
  readonly #overlay = new OptimisticOverlay();
  /**
   * Per-stream cleanups for overlay subscriptions. Keyed the same way as
   * `#streamSignals`; removed when a consumer drops their last reference
   * (not implemented yet — Signal has no unsubscribe API today).
   */
  #overlayDisposers = new Map<string, () => void>();

  constructor(options: FrickClientOptions) {
    this.#endpoint = options.endpoint;
    this.#httpEndpoint = options.httpEndpoint ?? resolveHttpEndpoint(options.endpoint);
    this.schema = options.schema ?? foundationSchema;
    this.#cache = options.cache ?? new MemoryFrickCache();
    this.#session = options.session ?? undefined;
    this.#sessionToken = options.session?.sessionToken ?? options.sessionToken;
    this.#replicaId = options.session?.replicaId ?? options.replicaId ?? `replica-${randomId()}`;
    this.#deviceId = options.session?.deviceId ?? options.deviceId ?? `device-${randomId()}`;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.#maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;
    this.#maxPendingAppends = options.maxPendingAppends ?? 1_000;
    this.#WebSocketImpl = options.WebSocketImpl;
    this.#setSessionStatus();
    this.#hydrateFromCache();
  }

  get session(): FrickSession | undefined {
    return this.#session;
  }

  get sessionToken(): string | undefined {
    return this.#sessionToken;
  }

  setSession(session: FrickSession | null | undefined): void {
    const shouldReconnect = Boolean(this.#socket);
    const nextSession = session ?? undefined;
    const scopeChanged = sessionScope(this.#session) !== sessionScope(nextSession);
    if (shouldReconnect) {
      this.disconnect();
    }
    if (scopeChanged) {
      this.clearUserState();
    }
    this.#session = nextSession;
    this.#sessionToken = nextSession?.sessionToken;
    if (nextSession) {
      this.#replicaId = nextSession.replicaId;
      this.#deviceId = nextSession.deviceId;
    }
    this.#setSessionStatus();
    if (shouldReconnect) {
      this.connect();
    }
  }

  clearUserState(): void {
    const clearedError = new FrickUserStateClearedError();
    for (const resolver of this.#appendResolvers.values()) {
      resolver.reject(clearedError);
    }
    for (const pending of this.#pendingUpserts.values()) {
      pending.reject(clearedError);
    }
    this.#appendResolvers.clear();
    this.#pendingUpserts.clear();
    this.#pendingAppends.clear();
    this.#overlay.clear();
    this.#objects.clear();
    this.#streams.clear();
    this.#projectionRows.clear();
    this.#cache.clear();

    for (const signal of this.#objectListSignals.values()) {
      signal.set([]);
    }
    for (const signal of this.#streamSignals.values()) {
      signal.set([]);
    }
    for (const signal of this.#presenceSignals.values()) {
      signal.set(undefined);
    }
    for (const signal of this.#signalSignals.values()) {
      signal.set([]);
    }
    for (const signal of this.#projectionSignals.values()) {
      signal.set(new Map());
    }
    this.#setStatus({
      cursors: {},
      pendingMutations: 0,
      lastError: undefined,
    });
  }

  connect(): void {
    this.#manualDisconnect = false;
    this.#clearReconnectTimer();
    if (this.#socket) {
      return;
    }

    const WebSocketCtor = this.#WebSocketImpl ?? WebSocket;
    const socket = new WebSocketCtor(this.#webSocketEndpoint());
    socket.binaryType = "arraybuffer";
    this.#socket = socket;

    addSocketListener(socket, "open", () => {
      if (this.#socket !== socket) {
        return;
      }
      this.#reconnectAttempts = 0;
      this.#send([
        FrameKind.Hello,
        {
          replicaId: this.#replicaId,
          deviceId: this.#deviceId,
          schemaHash: this.schema.hash,
          knownCursors: this.syncStatus.value.cursors,
          ...(this.#sessionToken ? { sessionToken: this.#sessionToken } : {}),
          clientCapabilities: defaultClientCapabilities({
            platform: "web",
            sdkVersion: "0.0.0-runtime",
            schema: this.schema,
          }),
        },
      ]);
      this.#setStatus({ connected: true });
      this.#resubscribe();
      this.#flushPendingAppends();
      this.#flushPendingUpserts();
    });

    addSocketListener(socket, "message", (event) => {
      const data = event && typeof event === "object" && "data" in event ? event.data : event;
      void this.#receive(data);
    });

    addSocketListener(socket, "close", () => {
      if (this.#socket !== socket) {
        return;
      }
      this.#socket = undefined;
      this.#setStatus({ connected: false });
      if (!this.#manualDisconnect) {
        this.#scheduleReconnect();
      }
    });
  }

  disconnect(): void {
    this.#manualDisconnect = true;
    this.#clearReconnectTimer();
    this.#socket?.close();
    this.#socket = undefined;
    this.#setStatus({ connected: false });
  }

  object(type: string, id: string): PlainObject | undefined {
    return this.#objects.get(objectKey(type, id));
  }

  objects(type: string): Signal<PlainObject[]> {
    const existing = this.#objectListSignals.get(type);
    if (existing) {
      return existing;
    }
    const signal = new Signal(this.#composeObjects(type));
    this.#objectListSignals.set(type, signal);
    // Re-emit whenever an optimistic upsert is added or removed.
    this.#overlay.subscribeObjectType(type, () => signal.set(this.#composeObjects(type)));
    if (this.syncStatus.value.connected) {
      this.#sendSubscribe({ kind: "object", name: type });
    }
    return signal;
  }

  stream(stream: string, key: string): Signal<StreamEventInput[]> {
    const id = streamKey(stream, key);
    const existing = this.#streamSignals.get(id);
    if (existing) {
      return existing;
    }
    const signal = new Signal(this.#composeStream(stream, key));
    this.#streamSignals.set(id, signal);
    // Re-emit whenever an optimistic event for this (stream, key) is added or removed.
    const dispose = this.#overlay.subscribeStream(stream, key, () =>
      signal.set(this.#composeStream(stream, key)),
    );
    this.#overlayDisposers.set(id, dispose);
    if (this.syncStatus.value.connected) {
      this.#sendSubscribe({ kind: "stream", name: stream, key });
    }
    return signal;
  }

  /** Merge cached objects with optimistic upserts for a given type. */
  #composeObjects(type: string): PlainObject[] {
    const base = this.#selectObjects(type);
    const overlay = this.#overlay.forObjectType(type);
    if (overlay.size === 0) return base;
    const byId = new Map<string, PlainObject>();
    for (const value of base) {
      const id = (value as { id?: string }).id;
      if (id) byId.set(id, value);
    }
    for (const [id, value] of overlay) {
      byId.set(id, { ...value, id });
    }
    return Array.from(byId.values());
  }

  /** Merge cached stream events with pending optimistic events. */
  #composeStream(stream: string, key: string): StreamEventInput[] {
    const id = streamKey(stream, key);
    const base = this.#streams.get(id) ?? [];
    const overlay = this.#overlay.forStream(stream, key);
    if (overlay.length === 0) return [...base];
    return [...base, ...overlay];
  }

  presence(name: string, key: string): Signal<PlainObject | undefined> {
    const id = streamKey(name, key);
    const existing = this.#presenceSignals.get(id);
    if (existing) {
      return existing;
    }
    const signal = new Signal<PlainObject | undefined>(undefined);
    this.#presenceSignals.set(id, signal);
    if (this.syncStatus.value.connected) {
      this.#sendSubscribe({ kind: "presence", name, key });
    }
    return signal;
  }

  /**
   * Subscribe to a projection by name. Returns a Signal whose value is a Map
   * from projection-defined row key to the latest row value. Updates arrive
   * via ProjectionDelta frames pushed by the server; `null` values delete
   * the corresponding key. Auto-subscribes on first access.
   */
  projection<T extends PlainObject = PlainObject>(name: string): Signal<Map<string, T>> {
    const existing = this.#projectionSignals.get(name);
    if (existing) {
      return existing as unknown as Signal<Map<string, T>>;
    }
    const rows = this.#projectionRows.get(name) ?? new Map<string, PlainObject>();
    this.#projectionRows.set(name, rows);
    const signal = new Signal<Map<string, PlainObject>>(new Map(rows));
    this.#projectionSignals.set(name, signal);
    if (this.syncStatus.value.connected) {
      this.#sendSubscribe({ kind: "projection", name });
    }
    return signal as unknown as Signal<Map<string, T>>;
  }

  signalChannel(name: string, key: string): Signal<PlainObject[]> {
    const id = streamKey(name, key);
    const existing = this.#signalSignals.get(id);
    if (existing) {
      return existing;
    }
    const signal = new Signal<PlainObject[]>([]);
    this.#signalSignals.set(id, signal);
    if (this.syncStatus.value.connected) {
      this.#sendSubscribe({ kind: "signal", name, key });
    }
    return signal;
  }

  /**
   * Append a stream event. Returns a Promise that resolves when the server
   * Acks the write and rejects when it Nacks. Pre-existing callers that
   * ignore the Promise behave identically to the original fire-and-forget
   * surface — the resolver is created either way but garbage-collected if
   * unobserved.
   *
   * Pass `options.optimistic` (a partial event payload) to surface the
   * write in `client.stream(...)` immediately, before the server ack. The
   * overlay event is removed on Ack (the real Delta takes over) or on Nack
   * (the Promise also rejects so the UI can roll back).
   */
  append(
    stream: string,
    key: string,
    event: string,
    payload: PlainObject,
    options?: { optimistic?: PlainObject },
  ): Promise<void> {
    if (this.#pendingAppends.size >= this.#maxPendingAppends) {
      const envelope: FrickErrorEnvelope = {
        code: "rateLimit.exceeded",
        message: "Pending append queue is full",
        requestId: "client",
        retryable: true,
        details: {
          limit: "maxPendingAppends",
          configuredMax: this.#maxPendingAppends,
        },
      };
      this.#setStatus({ lastError: envelope });
      return Promise.reject(new FrickClientLimitError(envelope));
    }
    const append: PendingAppend = {
      requestId: randomId(),
      stream,
      key,
      event,
      payload: { ...payload },
    };
    // Optimistic overlay: synthesize a display-only event so the consumer's
    // signal updates immediately. The overlay drops on Ack/Nack.
    const optimisticRequested = options?.optimistic !== undefined;
    if (optimisticRequested) {
      this.#overlay.addStreamEvent(append.requestId, {
        stream,
        key,
        event: {
          stream,
          streamId: key,
          sequence: Number.MAX_SAFE_INTEGER,
          eventId: `optimistic-${append.requestId}`,
          event,
          payload: { ...(options!.optimistic as PlainObject) },
        },
      });
    }
    // Resolve immediately by default — preserves the fire-and-forget surface
    // every existing caller depends on. When the consumer opts into
    // `optimistic`, the Promise instead settles on Ack/Nack so they can
    // await ack and catch typed `OptimisticConflictError`.
    if (!optimisticRequested) {
      this.#trackPendingAppend(append);
      this.#sendAppend(append);
      return Promise.resolve();
    }
    const promise = new Promise<void>((resolve, reject) => {
      this.#appendResolvers.set(append.requestId, { resolve, reject });
    });
    this.#trackPendingAppend(append);
    this.#sendAppend(append);
    return promise;
  }

  async setPresence(name: string, key: string, value: PlainObject): Promise<void> {
    this.#send([FrameKind.PresenceSet, { requestId: randomId(), name, key, value }]);
  }

  async clearPresence(name: string, key: string): Promise<void> {
    this.#send([FrameKind.PresenceClear, { requestId: randomId(), name, key }]);
  }

  async sendSignal(name: string, key: string, value: PlainObject): Promise<void> {
    this.#send([FrameKind.SignalSend, { requestId: randomId(), name, key, value }]);
  }

  track(
    name: string,
    properties: PlainObject = {},
    options: Omit<AnalyticsTrackOptions, "properties"> = {},
  ): Promise<AnalyticsTrackReceipt> {
    return trackAnalyticsEvent({
      ...options,
      httpEndpoint: this.#httpEndpoint,
      sessionToken: this.#sessionToken,
      name,
      properties,
    });
  }

  /**
   * Write an object over the sync WebSocket. Resolves with the new on-disk
   * version. When the schema's mergePolicy is `versionPrecondition`, supply
   * the row's current version as `expectedVersion`; the promise rejects with a
   * {@link FrickObjectConflictError} when the precondition fails. If the
   * socket is disconnected the upsert is queued in-memory and flushed on
   * reconnect, mirroring the pending-append behavior for stream writes.
   */
  upsertObject<T extends PlainObject = PlainObject>(
    objectType: string,
    objectId: string,
    value: T,
    expectedVersion?: number,
    options?: { optimistic?: boolean },
  ): Promise<{ version: number }> {
    if (this.#pendingUpserts.size + this.#pendingAppends.size >= this.#maxPendingAppends) {
      const envelope: FrickErrorEnvelope = {
        code: "rateLimit.exceeded",
        message: "Pending write queue is full",
        requestId: "client",
        retryable: true,
        details: {
          limit: "maxPendingAppends",
          configuredMax: this.#maxPendingAppends,
        },
      };
      this.#setStatus({ lastError: envelope });
      return Promise.reject(new FrickClientLimitError(envelope));
    }
    return new Promise<{ version: number }>((resolve, reject) => {
      const pending: PendingUpsert = {
        requestId: randomId(),
        objectType,
        objectId,
        value: { ...value },
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
        resolve,
        reject,
      };
      this.#pendingUpserts.set(pending.requestId, pending);
      if (options?.optimistic) {
        // Display the upserted value immediately. Real Delta on ack will
        // overwrite. On nack the overlay drops and an OptimisticConflictError
        // surfaces via the reject above.
        this.#overlay.addObjectUpsert(pending.requestId, {
          type: objectType,
          id: objectId,
          value: { ...value },
        });
      }
      this.#setStatus({ pendingMutations: this.#pendingAppends.size + this.#pendingUpserts.size });
      this.#sendUpsert(pending);
    });
  }

  #hydrateFromCache(): void {
    const scope = this.#cacheScope();
    if (!scope) {
      return;
    }
    const cached = this.#cache.load(this.schema, scope);
    for (const object of cached.objects) {
      this.#objects.set(objectKey(object.type, object.id), { ...object.value });
    }
    for (const event of cached.streamEvents) {
      this.#storeStreamEvent(event);
    }
    for (const append of cached.pendingAppends) {
      this.#pendingAppends.set(append.requestId, append);
    }
    this.#setStatus({
      cursors: cached.cursors,
      pendingMutations: this.#pendingAppends.size,
    });
  }

  #handleFrame(frame: FrickFrame): void {
    if (frame[0] === HELLO_ACK_FRAME_KIND) {
      const helloAck = frame as HelloAckFrame;
      this.#setStatus({
        serverCapabilities: helloAck[1].serverCapabilities,
        schemaCompatibility: helloAck[1].schemaCompatibility,
      });
      return;
    }

    switch (frame[0]) {
      case FrameKind.Schema:
        return;
      case FrameKind.Snapshot:
        for (const packed of frame[1].objects) {
          const unpacked = unpackObjectRecord(this.schema, packed);
          this.#storeObject(unpacked.type, unpacked.id, unpacked.value, frame[1].cursor);
        }
        this.#saveCursor(frame[1].subscriptionId, frame[1].cursor);
        return;
      case FrameKind.StreamPage:
        for (const packed of frame[1].events) {
          this.#storeStreamEvent(unpackStreamEvent(this.schema, packed));
        }
        this.#saveCursor(frame[1].subscriptionId, frame[1].cursor);
        return;
      case FrameKind.Delta:
        for (const packed of frame[1].objects) {
          const unpacked = unpackObjectRecord(this.schema, packed);
          this.#storeObject(unpacked.type, unpacked.id, unpacked.value, frame[1].cursor);
          this.#saveCursor(unpacked.type, frame[1].cursor);
        }
        for (const packed of frame[1].events) {
          const event = unpackStreamEvent(this.schema, packed);
          this.#storeStreamEvent(event);
          this.#saveCursor(streamKey(event.stream, event.streamId), Math.max(event.sequence, frame[1].cursor));
        }
        return;
      case FrameKind.PresenceDelta:
        for (const packed of frame[1].records) {
          const presence = unpackPresenceRecord(this.schema, packed);
          this.#presenceSignals.get(streamKey(presence.type, presence.key))?.set(presence.value);
        }
        for (const key of frame[1].cleared) {
          this.#presenceSignals.get(key)?.set(undefined);
        }
        return;
      case FrameKind.ProjectionDelta: {
        const { projection, changes } = frame[1];
        const rows = this.#projectionRows.get(projection) ?? new Map<string, PlainObject>();
        for (const change of changes) {
          if (change.value === null) {
            rows.delete(change.key);
          } else {
            rows.set(change.key, change.value);
          }
        }
        this.#projectionRows.set(projection, rows);
        // Replace the Map reference so listeners observe the change.
        this.#projectionSignals.get(projection)?.set(new Map(rows));
        return;
      }
      case FrameKind.SignalDeliver: {
        const signal = unpackSignalEnvelope(this.schema, frame[1].envelope);
        const id = streamKey(signal.type, signal.key);
        const channel = this.#signalSignals.get(id);
        channel?.set([...(channel.value ?? []), signal.value]);
        return;
      }
      case FrameKind.Ack: {
        const requestId = frame[1].requestId;
        const pendingUpsert = this.#pendingUpserts.get(requestId);
        if (pendingUpsert) {
          this.#pendingUpserts.delete(requestId);
          pendingUpsert.resolve({ version: frame[1].version ?? 0 });
        } else {
          this.#pendingAppends.delete(requestId);
          this.#cache.removePendingAppend(this.schema, requestId, this.#cacheScope());
          const resolver = this.#appendResolvers.get(requestId);
          if (resolver) {
            this.#appendResolvers.delete(requestId);
            resolver.resolve();
          }
        }
        this.#overlay.remove(requestId);
        this.#setStatus({ pendingMutations: this.#pendingAppends.size + this.#pendingUpserts.size });
        return;
      }
      case FrameKind.Nack: {
        const requestId = frame[1].requestId;
        const pendingUpsert = this.#pendingUpserts.get(requestId);
        if (pendingUpsert) {
          this.#pendingUpserts.delete(requestId);
          const envelope = frame[1].error;
          if (envelope.code === "storage.conflict") {
            const details = (envelope.details ?? {}) as {
              expectedVersion?: number;
              actualVersion?: number;
              mergePolicy?: FrickObjectMergePolicy;
            };
            const conflictInput = {
              envelope,
              actualVersion: details.actualVersion ?? 0,
              mergePolicy: details.mergePolicy ?? "lastWriteWins",
              expectedVersion: details.expectedVersion,
            };
            // If this upsert was registered with an optimistic overlay,
            // surface the typed `OptimisticConflictError` so consumers can
            // pattern-match for rollback.
            const hadOverlay = this.#overlay.forObjectType(pendingUpsert.objectType).has(pendingUpsert.objectId);
            pendingUpsert.reject(
              hadOverlay
                ? new OptimisticConflictError({ ...conflictInput, rolledBack: true })
                : new FrickObjectConflictError(conflictInput),
            );
          } else {
            pendingUpsert.reject(new FrickClientLimitError(envelope));
          }
        } else {
          this.#pendingAppends.delete(requestId);
          this.#cache.removePendingAppend(this.schema, requestId, this.#cacheScope());
          const resolver = this.#appendResolvers.get(requestId);
          if (resolver) {
            this.#appendResolvers.delete(requestId);
            resolver.reject(new FrickClientLimitError(frame[1].error));
          }
        }
        this.#overlay.remove(requestId);
        this.#setStatus({
          pendingMutations: this.#pendingAppends.size + this.#pendingUpserts.size,
          lastError: frame[1].error,
        });
        return;
      }
      default:
        return;
    }
  }

  async #receive(payload: unknown): Promise<void> {
    const data = payload instanceof Blob ? await payload.arrayBuffer() : payload;
    this.#handleFrame(decodeFrame(data as ArrayBuffer | Uint8Array));
  }

  #storeObject(type: string, id: string, value: PlainObject, version: number): void {
    this.#objects.set(objectKey(type, id), { ...value });
    this.#cache.saveObject(this.schema, type, id, value, version, this.#cacheScope());
    this.#objectListSignals.get(type)?.set(this.#selectObjects(type));
  }

  #storeStreamEvent(event: StreamEventInput): void {
    const id = streamKey(event.stream, event.streamId);
    const events = this.#streams.get(id) ?? [];
    const existing = events.findIndex((candidate) => candidate.eventId === event.eventId);
    if (existing === -1) {
      events.push(event);
    } else {
      events[existing] = event;
    }
    events.sort((left, right) => left.sequence - right.sequence);
    this.#streams.set(id, events);
    this.#cache.saveStreamEvent(this.schema, event, this.#cacheScope());
    this.#streamSignals.get(id)?.set([...events]);
  }

  #trackPendingAppend(append: PendingAppend): void {
    this.#pendingAppends.set(append.requestId, append);
    this.#cache.savePendingAppend(this.schema, append, this.#cacheScope());
    this.#setStatus({ pendingMutations: this.#pendingAppends.size });
  }

  #sendAppend(append: PendingAppend): void {
    this.#send([
      FrameKind.Append,
      {
        requestId: append.requestId,
        stream: append.stream,
        key: append.key,
        event: append.event,
        payload: append.payload,
      },
    ]);
  }

  #flushPendingAppends(): void {
    for (const append of this.#pendingAppends.values()) {
      this.#sendAppend(append);
    }
  }

  #sendUpsert(pending: PendingUpsert): void {
    this.#send([
      FrameKind.ObjectUpsert,
      {
        requestId: pending.requestId,
        objectType: pending.objectType,
        objectId: pending.objectId,
        value: pending.value,
        ...(pending.expectedVersion !== undefined ? { expectedVersion: pending.expectedVersion } : {}),
      },
    ]);
  }

  #flushPendingUpserts(): void {
    for (const upsert of this.#pendingUpserts.values()) {
      this.#sendUpsert(upsert);
    }
  }

  #resubscribe(): void {
    for (const type of this.#objectListSignals.keys()) {
      this.#sendSubscribe({ kind: "object", name: type });
    }
    for (const id of this.#streamSignals.keys()) {
      const [name, key] = splitSubscriptionKey(id);
      this.#sendSubscribe({ kind: "stream", name, key });
    }
    for (const id of this.#presenceSignals.keys()) {
      const [name, key] = splitSubscriptionKey(id);
      this.#sendSubscribe({ kind: "presence", name, key });
    }
    for (const id of this.#signalSignals.keys()) {
      const [name, key] = splitSubscriptionKey(id);
      this.#sendSubscribe({ kind: "signal", name, key });
    }
    for (const name of this.#projectionSignals.keys()) {
      this.#sendSubscribe({ kind: "projection", name });
    }
  }

  #sendSubscribe(input: { kind: "object" | "stream" | "presence" | "signal" | "projection"; name: string; key?: string }): void {
    const subscriptionId = input.key ? streamKey(input.name, input.key) : input.name;
    const payload = {
      subscriptionId,
      kind: input.kind,
      name: input.name,
      cursor: this.syncStatus.value.cursors[subscriptionId] ?? 0,
      ...(input.key ? { key: input.key } : {}),
    };
    this.#send([FrameKind.Subscribe, payload]);
  }

  #send(frame: FrickFrame): void {
    if (this.#socket?.readyState === SOCKET_OPEN) {
      this.#socket.send(encodeFrame(frame));
    }
  }

  #selectObjects(type: string): PlainObject[] {
    return Array.from(this.#objects.entries())
      .filter(([key]) => key.startsWith(`${type}:`))
      .map(([, value]) => value)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  }

  #saveCursor(key: string, cursor: number): void {
    this.#cache.saveCursor(this.schema, key, cursor, this.#cacheScope());
    this.#setStatus({
      cursors: {
        ...this.syncStatus.value.cursors,
        [key]: Math.max(this.syncStatus.value.cursors[key] ?? 0, cursor),
      },
    });
  }

  #setStatus(patch: Partial<SyncStatus>): void {
    this.syncStatus.set({ ...this.syncStatus.value, ...patch });
  }

  #setSessionStatus(): void {
    this.#setStatus({
      authenticated: Boolean(this.#sessionToken),
      userId: this.#session?.userId,
      deviceId: this.#session?.deviceId ?? this.#deviceId,
    });
  }

  #cacheScope(): FrickCacheScope | undefined {
    if (!this.#session) {
      return undefined;
    }
    return {
      ...(this.#session.tenantId !== undefined ? { tenantId: this.#session.tenantId } : {}),
      userId: this.#session.userId,
    };
  }

  #webSocketEndpoint(): string {
    return stripSessionTokenQuery(this.#endpoint);
  }

  /** HTTP endpoint used by REST helpers such as `loadOlder`. */
  get httpEndpoint(): string {
    return this.#httpEndpoint;
  }

  /**
   * Backwards-paginated read for scrollback: returns up to `count` events
   * whose `sequence` is strictly less than `before`. Events are returned
   * oldest-first so callers can `[...older, ...current]` without reversing.
   * Pure HTTP — does not disturb any open WebSocket subscription.
   */
  async loadOlder(
    stream: string,
    key: string,
    count: number,
    before?: number,
  ): Promise<StreamEventInput[]> {
    const url = new URL(
      `${this.httpEndpoint.replace(/\/$/, "")}/streams/${encodeURIComponent(stream)}/${encodeURIComponent(key)}`,
    );
    if (before !== undefined && before > 0) {
      url.searchParams.set("before", String(Math.floor(before)));
    } else {
      url.searchParams.set("before", String(Number.MAX_SAFE_INTEGER));
    }
    url.searchParams.set("limit", String(Math.max(1, Math.min(500, Math.floor(count)))));
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.#sessionToken) headers.authorization = `Bearer ${this.#sessionToken}`;
    const response = await fetch(url.toString(), { headers });
    if (!response.ok) {
      throw new Error(`loadOlder failed: ${response.status}`);
    }
    const body = (await response.json()) as { data?: StreamEventInput[] };
    return body.data ?? [];
  }

  #scheduleReconnect(): void {
    this.#clearReconnectTimer();
    this.#reconnectAttempts += 1;
    const delay = this.#nextReconnectDelayMs();
    this.#reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  #nextReconnectDelayMs(): number {
    const exponent = Math.min(this.#reconnectAttempts - 1, 16);
    const exponential = this.#reconnectDelayMs * Math.pow(2, exponent);
    return Math.min(this.#maxReconnectDelayMs, exponential);
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
  }
}

function addSocketListener(socket: WebSocket, event: string, listener: (event: any) => void): void {
  if ("addEventListener" in socket) {
    socket.addEventListener(event, listener as EventListener);
    return;
  }
  (socket as never as { on(name: string, listener: (event: any) => void): void }).on(event, listener);
}

function splitSubscriptionKey(id: string): [name: string, key: string] {
  const separator = id.indexOf(":");
  return [id.slice(0, separator), id.slice(separator + 1)];
}

function sessionScope(session: FrickSession | undefined): string | undefined {
  if (!session) {
    return undefined;
  }
  return `${session.tenantId ?? ""}\x00${session.userId}`;
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

function stripSessionTokenQuery(endpoint: string): string {
  const url = new URL(endpoint);
  if (!url.searchParams.has("sessionToken")) {
    return endpoint;
  }
  url.searchParams.delete("sessionToken");
  return url.toString();
}
