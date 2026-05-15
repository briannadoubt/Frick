import type { FrickSchema, PlainObject, StreamEventInput } from "@frick/protocol";
import { objectKey, streamKey } from "./subscriptions.js";

export interface PendingAppend {
  requestId: string;
  stream: string;
  key: string;
  event: string;
  payload: PlainObject;
}

export interface CachedObject {
  type: string;
  id: string;
  value: PlainObject;
  version: number;
}

export interface FrickCacheMetadata {
  schemaId: string;
  schemaVersion: string;
  schemaRevision: number;
  schemaHash: string;
  tenantId?: string;
  userId?: string;
}

export interface FrickCacheScope {
  tenantId?: string;
  userId?: string;
}

export type FrickCacheIncompatibleReason = "schemaIdMismatch" | "cacheTooOld" | "sessionScopeMismatch";

export class FrickCacheIncompatibleError extends Error {
  constructor(
    public readonly reason: FrickCacheIncompatibleReason,
    public readonly cachedMetadata: FrickCacheMetadata,
    public readonly currentMetadata: FrickCacheMetadata,
    public readonly minimumClientRevision: number,
    public readonly pendingAppendCount: number,
    message: string,
  ) {
    super(message);
    this.name = "FrickCacheIncompatibleError";
  }
}

export interface FrickCacheState {
  objects: CachedObject[];
  streamEvents: StreamEventInput[];
  cursors: Record<string, number>;
  pendingAppends: PendingAppend[];
  metadata?: FrickCacheMetadata;
}

export interface FrickLocalCache {
  load(schema: FrickSchema, scope?: FrickCacheScope): FrickCacheState;
  saveObject(schema: FrickSchema, type: string, id: string, value: PlainObject, version: number, scope?: FrickCacheScope): void;
  saveStreamEvent(schema: FrickSchema, event: StreamEventInput, scope?: FrickCacheScope): void;
  saveCursor(schema: FrickSchema, key: string, cursor: number, scope?: FrickCacheScope): void;
  savePendingAppend(schema: FrickSchema, append: PendingAppend, scope?: FrickCacheScope): void;
  removePendingAppend(schema: FrickSchema, requestId: string, scope?: FrickCacheScope): void;
  clear(): void;
}

export function schemaIdentity(schema: FrickSchema, scope: FrickCacheScope = {}): FrickCacheMetadata {
  return {
    schemaId: schema.schemaId,
    schemaVersion: schema.schemaVersion,
    schemaRevision: schema.schemaRevision,
    schemaHash: schema.hash,
    ...(scope.tenantId !== undefined ? { tenantId: scope.tenantId } : {}),
    ...(scope.userId !== undefined ? { userId: scope.userId } : {}),
  };
}

export class MemoryFrickCache implements FrickLocalCache {
  #objects = new Map<string, CachedObject>();
  #streamEvents = new Map<string, StreamEventInput[]>();
  #cursors: Record<string, number> = {};
  #pendingAppends = new Map<string, PendingAppend>();
  #metadata: FrickCacheMetadata | undefined;

  constructor(initial: Partial<FrickCacheState> = {}) {
    if (initial.metadata) {
      this.#metadata = { ...initial.metadata };
    }
    for (const object of initial.objects ?? []) {
      this.#objects.set(objectKey(object.type, object.id), cloneObject(object));
    }
    for (const event of initial.streamEvents ?? []) {
      const key = streamKey(event.stream, event.streamId);
      const events = this.#streamEvents.get(key) ?? [];
      events.push(cloneStreamEvent(event));
      events.sort((left, right) => left.sequence - right.sequence);
      this.#streamEvents.set(key, events);
    }
    this.#cursors = { ...(initial.cursors ?? {}) };
    for (const append of initial.pendingAppends ?? []) {
      this.#pendingAppends.set(append.requestId, clonePendingAppend(append));
    }
  }

  load(schema: FrickSchema, scope: FrickCacheScope = {}): FrickCacheState {
    if (this.#metadata) {
      const reason = compatibilityReason(this.#metadata, schema, scope);
      if (reason) {
        throw new FrickCacheIncompatibleError(
          reason,
          { ...this.#metadata },
          schemaIdentity(schema, scope),
          schema.minimumClientRevision,
          this.#pendingAppends.size,
          incompatibilityMessage(reason, this.#metadata, schema, scope),
        );
      }
    }
    return {
      objects: Array.from(this.#objects.values(), cloneObject),
      streamEvents: Array.from(this.#streamEvents.values()).flat().map(cloneStreamEvent),
      cursors: { ...this.#cursors },
      pendingAppends: Array.from(this.#pendingAppends.values(), clonePendingAppend),
      ...(this.#metadata ? { metadata: { ...this.#metadata } } : {}),
    };
  }

  saveObject(schema: FrickSchema, type: string, id: string, value: PlainObject, version: number, scope: FrickCacheScope = {}): void {
    this.#writeMetadata(schema, scope);
    this.#objects.set(objectKey(type, id), {
      type,
      id,
      value: { id, ...value },
      version,
    });
  }

  saveStreamEvent(schema: FrickSchema, event: StreamEventInput, scope: FrickCacheScope = {}): void {
    this.#writeMetadata(schema, scope);
    const key = streamKey(event.stream, event.streamId);
    const events = this.#streamEvents.get(key) ?? [];
    const existingIndex = events.findIndex((candidate) => candidate.eventId === event.eventId);
    const next = cloneStreamEvent(event);
    if (existingIndex === -1) {
      events.push(next);
    } else {
      events[existingIndex] = next;
    }
    events.sort((left, right) => left.sequence - right.sequence);
    this.#streamEvents.set(key, events);
  }

  saveCursor(schema: FrickSchema, key: string, cursor: number, scope: FrickCacheScope = {}): void {
    this.#writeMetadata(schema, scope);
    this.#cursors[key] = Math.max(this.#cursors[key] ?? 0, cursor);
  }

  savePendingAppend(schema: FrickSchema, append: PendingAppend, scope: FrickCacheScope = {}): void {
    this.#writeMetadata(schema, scope);
    this.#pendingAppends.set(append.requestId, clonePendingAppend(append));
  }

  removePendingAppend(_schema: FrickSchema, requestId: string, _scope: FrickCacheScope = {}): void {
    this.#pendingAppends.delete(requestId);
  }

  clear(): void {
    this.#objects.clear();
    this.#streamEvents.clear();
    this.#cursors = {};
    this.#pendingAppends.clear();
    this.#metadata = undefined;
  }

  #writeMetadata(schema: FrickSchema, scope: FrickCacheScope): void {
    const next = schemaIdentity(schema, scope);
    if (
      this.#metadata &&
      this.#metadata.schemaId === next.schemaId &&
      this.#metadata.schemaHash === next.schemaHash &&
      this.#metadata.schemaRevision === next.schemaRevision &&
      this.#metadata.tenantId === next.tenantId &&
      this.#metadata.userId === next.userId
    ) {
      return;
    }
    this.#metadata = next;
  }
}

function compatibilityReason(
  cached: FrickCacheMetadata,
  schema: FrickSchema,
  scope: FrickCacheScope,
): FrickCacheIncompatibleReason | undefined {
  if (cached.schemaId !== schema.schemaId) {
    return "schemaIdMismatch";
  }
  if (cached.schemaRevision < schema.minimumClientRevision) {
    return "cacheTooOld";
  }
  if (
    (scope.tenantId !== undefined && cached.tenantId !== scope.tenantId) ||
    (scope.userId !== undefined && cached.userId !== scope.userId)
  ) {
    return "sessionScopeMismatch";
  }
  return undefined;
}

function incompatibilityMessage(
  reason: FrickCacheIncompatibleReason,
  cached: FrickCacheMetadata,
  schema: FrickSchema,
  scope: FrickCacheScope = {},
): string {
  switch (reason) {
    case "schemaIdMismatch":
      return `Cached schema id ${cached.schemaId} does not match current schema id ${schema.schemaId}`;
    case "cacheTooOld":
      return `Cached schema revision ${cached.schemaRevision} is below current minimum client revision ${schema.minimumClientRevision}`;
    case "sessionScopeMismatch":
      return `Cached session scope ${cached.tenantId ?? "unknown"}:${cached.userId ?? "unknown"} does not match current session scope ${scope.tenantId ?? "unknown"}:${scope.userId ?? "unknown"}`;
  }
}

function cloneObject(object: CachedObject): CachedObject {
  return {
    type: object.type,
    id: object.id,
    value: { ...object.value },
    version: object.version,
  };
}

function cloneStreamEvent(event: StreamEventInput): StreamEventInput {
  return {
    stream: event.stream,
    streamId: event.streamId,
    sequence: event.sequence,
    eventId: event.eventId,
    event: event.event,
    payload: { ...event.payload },
  };
}

function clonePendingAppend(append: PendingAppend): PendingAppend {
  return {
    requestId: append.requestId,
    stream: append.stream,
    key: append.key,
    event: append.event,
    payload: { ...append.payload },
  };
}
