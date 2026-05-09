import {
  FrameKind,
  decodeFrame,
  encodeFrame,
  foundationSchema,
  unpackObjectRecord,
  unpackPresenceRecord,
  unpackSignalEnvelope,
  unpackStreamEvent,
  type FrickFrame,
  type FrickSchema,
  type PlainObject,
  type StreamEventInput,
} from "@frick/protocol";
import {
  MemoryFrickCache,
  type FrickLocalCache,
  type PendingAppend,
} from "./cache.js";
import { Signal, objectKey, streamKey } from "./subscriptions.js";

const SOCKET_OPEN = 1;

export interface SyncStatus {
  connected: boolean;
  cursors: Record<string, number>;
  pendingMutations: number;
}

export interface FrickClientOptions {
  endpoint: string;
  schema?: FrickSchema;
  cache?: FrickLocalCache;
  reconnectDelayMs?: number;
  replicaId?: string;
  deviceId?: string;
  WebSocketImpl?: typeof WebSocket;
}

export class FrickClient {
  readonly schema: FrickSchema;
  readonly syncStatus = new Signal<SyncStatus>({
    connected: false,
    cursors: {},
    pendingMutations: 0,
  });

  readonly #endpoint: string;
  readonly #cache: FrickLocalCache;
  readonly #replicaId: string;
  readonly #deviceId: string;
  readonly #reconnectDelayMs: number;
  readonly #WebSocketImpl: typeof WebSocket | undefined;

  #socket: WebSocket | undefined;
  #manualDisconnect = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #objects = new Map<string, PlainObject>();
  #streams = new Map<string, StreamEventInput[]>();
  #pendingAppends = new Map<string, PendingAppend>();
  #objectListSignals = new Map<string, Signal<PlainObject[]>>();
  #streamSignals = new Map<string, Signal<StreamEventInput[]>>();
  #presenceSignals = new Map<string, Signal<PlainObject | undefined>>();
  #signalSignals = new Map<string, Signal<PlainObject[]>>();

  constructor(options: FrickClientOptions) {
    this.#endpoint = options.endpoint;
    this.schema = options.schema ?? foundationSchema;
    this.#cache = options.cache ?? new MemoryFrickCache();
    this.#replicaId = options.replicaId ?? `replica-${randomId()}`;
    this.#deviceId = options.deviceId ?? `device-${randomId()}`;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.#WebSocketImpl = options.WebSocketImpl;
    this.#hydrateFromCache();
  }

  connect(): void {
    this.#manualDisconnect = false;
    this.#clearReconnectTimer();
    if (this.#socket) {
      return;
    }

    const WebSocketCtor = this.#WebSocketImpl ?? WebSocket;
    const socket = new WebSocketCtor(this.#endpoint);
    socket.binaryType = "arraybuffer";
    this.#socket = socket;

    addSocketListener(socket, "open", () => {
      if (this.#socket !== socket) {
        return;
      }
      this.#send([
        FrameKind.Hello,
        {
          replicaId: this.#replicaId,
          deviceId: this.#deviceId,
          schemaHash: this.schema.hash,
          knownCursors: this.syncStatus.value.cursors,
        },
      ]);
      this.#setStatus({ connected: true });
      this.#resubscribe();
      this.#flushPendingAppends();
    });

    addSocketListener(socket, "message", (event) => {
      const data = "data" in event ? event.data : event;
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
    const signal = new Signal(this.#selectObjects(type));
    this.#objectListSignals.set(type, signal);
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
    const signal = new Signal([...(this.#streams.get(id) ?? [])]);
    this.#streamSignals.set(id, signal);
    if (this.syncStatus.value.connected) {
      this.#sendSubscribe({ kind: "stream", name: stream, key });
    }
    return signal;
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

  async append(stream: string, key: string, event: string, payload: PlainObject): Promise<void> {
    const append: PendingAppend = {
      requestId: randomId(),
      stream,
      key,
      event,
      payload: { ...payload },
    };
    this.#trackPendingAppend(append);
    this.#sendAppend(append);
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

  #hydrateFromCache(): void {
    const cached = this.#cache.load(this.schema);
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
        }
        for (const packed of frame[1].events) {
          this.#storeStreamEvent(unpackStreamEvent(this.schema, packed));
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
      case FrameKind.SignalDeliver: {
        const signal = unpackSignalEnvelope(this.schema, frame[1].envelope);
        const id = streamKey(signal.type, signal.key);
        const channel = this.#signalSignals.get(id);
        channel?.set([...(channel.value ?? []), signal.value]);
        return;
      }
      case FrameKind.Ack:
        this.#pendingAppends.delete(frame[1].requestId);
        this.#cache.removePendingAppend(this.schema, frame[1].requestId);
        this.#setStatus({ pendingMutations: this.#pendingAppends.size });
        return;
      case FrameKind.Nack:
        this.#pendingAppends.delete(frame[1].requestId);
        this.#cache.removePendingAppend(this.schema, frame[1].requestId);
        this.#setStatus({ pendingMutations: this.#pendingAppends.size });
        return;
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
    this.#cache.saveObject(this.schema, type, id, value, version);
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
    this.#cache.saveStreamEvent(this.schema, event);
    this.#streamSignals.get(id)?.set([...events]);
  }

  #trackPendingAppend(append: PendingAppend): void {
    this.#pendingAppends.set(append.requestId, append);
    this.#cache.savePendingAppend(this.schema, append);
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
  }

  #sendSubscribe(input: { kind: "object" | "stream" | "presence" | "signal"; name: string; key?: string }): void {
    const subscriptionId = input.key ? streamKey(input.name, input.key) : input.name;
    this.#send([
      FrameKind.Subscribe,
      {
        subscriptionId,
        kind: input.kind,
        name: input.name,
        key: input.key,
        cursor: this.syncStatus.value.cursors[subscriptionId] ?? 0,
      },
    ]);
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
    this.#cache.saveCursor(this.schema, key, cursor);
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

  #scheduleReconnect(): void {
    this.#clearReconnectTimer();
    this.#reconnectTimer = setTimeout(() => this.connect(), this.#reconnectDelayMs);
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
  }
}

function addSocketListener(socket: WebSocket, event: string, listener: (event: never) => void): void {
  if ("addEventListener" in socket) {
    socket.addEventListener(event, listener as EventListener);
    return;
  }
  (socket as never as { on(name: string, listener: (event: never) => void): void }).on(event, listener);
}

function splitSubscriptionKey(id: string): [name: string, key: string] {
  const separator = id.indexOf(":");
  return [id.slice(0, separator), id.slice(separator + 1)];
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}
