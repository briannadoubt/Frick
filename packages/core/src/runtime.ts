import {
  FrameKind,
  applyPackedFields,
  decodeFrame,
  demoManifest,
  encodeFrame,
  entityByName,
  packObject,
  type FrickFrame,
  type FrickManifest,
  type ObjectDelta,
  type PackedObject,
  type PlainObject,
  type QuerySpec,
} from "@frick/protocol";

const SOCKET_OPEN = 1;

export type Listener<T> = (value: T) => void;
export type Unsubscribe = () => void;

export class Signal<T> {
  #value: T;
  #listeners = new Set<Listener<T>>();

  constructor(initial: T) {
    this.#value = initial;
  }

  get value(): T {
    return this.#value;
  }

  set(value: T): void {
    this.#value = value;
    for (const listener of this.#listeners) {
      listener(value);
    }
  }

  subscribe(listener: Listener<T>): Unsubscribe {
    this.#listeners.add(listener);
    listener(this.#value);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

export interface SyncStatus {
  connected: boolean;
  lastSeq: number;
  pendingMutations: number;
}

export interface FrickClientOptions {
  endpoint: string;
  manifest?: FrickManifest;
  replicaId?: string;
  WebSocketImpl?: typeof WebSocket;
}

interface QuerySubscription {
  id: string;
  spec: QuerySpec;
  signal: Signal<PlainObject[]>;
}

export class FrickClient {
  readonly manifest: FrickManifest;
  readonly syncStatus = new Signal<SyncStatus>({
    connected: false,
    lastSeq: 0,
    pendingMutations: 0,
  });

  #endpoint: string;
  #replicaId: string;
  #WebSocketImpl: typeof WebSocket | undefined;
  #socket: WebSocket | undefined;
  #objects = new Map<number, Map<string, PlainObject>>();
  #queries = new Map<string, QuerySubscription>();
  #pending = new Set<string>();

  constructor(options: FrickClientOptions) {
    this.#endpoint = options.endpoint;
    this.manifest = options.manifest ?? demoManifest;
    this.#replicaId = options.replicaId ?? `replica-${crypto.randomUUID()}`;
    this.#WebSocketImpl = options.WebSocketImpl;
  }

  connect(): void {
    if (this.#socket) {
      return;
    }
    const WebSocketCtor = this.#WebSocketImpl ?? WebSocket;
    const socket = new WebSocketCtor(this.#endpoint);
    socket.binaryType = "arraybuffer";
    this.#socket = socket;

    socket.addEventListener("open", () => {
      if (this.#socket !== socket) {
        return;
      }
      sendToSocket(socket, [
        FrameKind.Hello,
        {
          replicaId: this.#replicaId,
          schemaVersion: this.manifest.schemaVersion,
          knownSeq: this.syncStatus.value.lastSeq,
        },
      ]);
      this.#setStatus({ connected: true });
      for (const query of this.#queries.values()) {
        sendToSocket(socket, [FrameKind.Subscribe, query.id, query.spec]);
      }
    });

    socket.addEventListener("close", () => {
      if (this.#socket !== socket) {
        return;
      }
      this.#socket = undefined;
      this.#setStatus({ connected: false });
    });

    socket.addEventListener("message", (event) => {
      void this.#receive(event.data);
    });
  }

  disconnect(): void {
    this.#socket?.close();
    this.#socket = undefined;
    this.#setStatus({ connected: false });
  }

  query(spec: QuerySpec): Signal<PlainObject[]> {
    const id = stableQueryId(spec);
    const existing = this.#queries.get(id);
    if (existing) {
      return existing.signal;
    }

    const signal = new Signal<PlainObject[]>(this.#select(spec));
    this.#queries.set(id, { id, spec, signal });
    if (this.syncStatus.value.connected) {
      this.#send([FrameKind.Subscribe, id, spec]);
    }
    return signal;
  }

  object(entityName: string, objectId: string): PlainObject | undefined {
    const entity = entityByName(this.manifest, entityName);
    return this.#objects.get(entity.id)?.get(objectId);
  }

  async mutate(name: string, input: Record<string, unknown>): Promise<void> {
    const requestId = crypto.randomUUID();
    this.#pending.add(requestId);
    this.#setStatus({ pendingMutations: this.#pending.size });
    this.#send([FrameKind.Mutate, { requestId, name, input }]);
  }

  applySnapshot(queryId: string, packedObjects: PackedObject[]): void {
    for (const packed of packedObjects) {
      this.#storePackedObject(packed);
    }
    const subscription = this.#queries.get(queryId);
    if (subscription) {
      subscription.signal.set(this.#select(subscription.spec));
    }
  }

  applyDelta(delta: ObjectDelta): void {
    const entityObjects = this.#objects.get(delta.entityId) ?? new Map<string, PlainObject>();
    const base = entityObjects.get(delta.objectId) ?? { id: delta.objectId };
    entityObjects.set(
      delta.objectId,
      applyPackedFields(this.manifest, delta.entityId, base, delta.fields),
    );
    this.#objects.set(delta.entityId, entityObjects);
    this.#setStatus({ lastSeq: Math.max(this.syncStatus.value.lastSeq, delta.seq) });
    this.#refreshQueries();
  }

  #storePackedObject(packed: PackedObject): void {
    const [entityId, objectId] = packed;
    const entityObjects = this.#objects.get(entityId) ?? new Map<string, PlainObject>();
    const object = applyPackedFields(this.manifest, entityId, { id: objectId }, packed[2]);
    entityObjects.set(objectId, object);
    this.#objects.set(entityId, entityObjects);
  }

  #select(spec: QuerySpec): PlainObject[] {
    const entity = entityByName(this.manifest, spec.entity);
    const objects = Array.from(this.#objects.get(entity.id)?.values() ?? []);
    if (spec.entity === "Task" && spec.index === "byProject") {
      return objects
        .filter((object) => object.projectId === spec.args.projectId)
        .sort((left, right) => String(left.updatedAt).localeCompare(String(right.updatedAt)));
    }
    if (spec.entity === "Project" && spec.index === "all") {
      return objects.sort((left, right) => String(left.name).localeCompare(String(right.name)));
    }
    return objects;
  }

  #refreshQueries(): void {
    for (const query of this.#queries.values()) {
      query.signal.set(this.#select(query.spec));
    }
  }

  async #receive(payload: unknown): Promise<void> {
    const data = payload instanceof Blob ? await payload.arrayBuffer() : payload;
    const frame = decodeFrame(data as ArrayBuffer | Uint8Array | Buffer);
    this.#handleFrame(frame);
  }

  #handleFrame(frame: FrickFrame): void {
    switch (frame[0]) {
      case FrameKind.Manifest:
        return;
      case FrameKind.Snapshot:
        this.applySnapshot(frame[1], frame[2]);
        return;
      case FrameKind.Delta:
        this.applyDelta(frame[1]);
        return;
      case FrameKind.Ack:
        this.#pending.delete(frame[1]);
        this.applyDelta(frame[2]);
        this.#setStatus({ pendingMutations: this.#pending.size });
        return;
      case FrameKind.Reject:
        this.#pending.delete(frame[1]);
        this.#setStatus({ pendingMutations: this.#pending.size });
        throw new Error(frame[2]);
      case FrameKind.SyncStatus:
        this.#setStatus({
          connected: frame[1].connected,
          lastSeq: frame[1].lastSeq,
        });
        return;
      default:
        return;
    }
  }

  #send(frame: FrickFrame): void {
    if (!this.#socket) {
      return;
    }
    sendToSocket(this.#socket, frame);
  }

  #setStatus(patch: Partial<SyncStatus>): void {
    this.syncStatus.set({ ...this.syncStatus.value, ...patch });
  }
}

function sendToSocket(socket: WebSocket, frame: FrickFrame): void {
  if (Number(socket.readyState) === SOCKET_OPEN) {
    socket.send(encodeFrame(frame));
  }
}

export function hydrateClient(client: FrickClient, entityName: string, objects: PlainObject[]): void {
  for (const object of objects) {
    client.applySnapshot(`hydrate:${entityName}`, [packObject(client.manifest, entityName, object)]);
  }
}

export function stableQueryId(spec: QuerySpec): string {
  return `${spec.entity}:${spec.index}:${JSON.stringify(spec.args, Object.keys(spec.args).sort())}`;
}
