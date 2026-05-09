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

export interface FrickCacheState {
  objects: CachedObject[];
  streamEvents: StreamEventInput[];
  cursors: Record<string, number>;
  pendingAppends: PendingAppend[];
}

export interface FrickLocalCache {
  load(schema: FrickSchema): FrickCacheState;
  saveObject(schema: FrickSchema, type: string, id: string, value: PlainObject, version: number): void;
  saveStreamEvent(schema: FrickSchema, event: StreamEventInput): void;
  saveCursor(schema: FrickSchema, key: string, cursor: number): void;
  savePendingAppend(schema: FrickSchema, append: PendingAppend): void;
  removePendingAppend(schema: FrickSchema, requestId: string): void;
}

export class MemoryFrickCache implements FrickLocalCache {
  #objects = new Map<string, CachedObject>();
  #streamEvents = new Map<string, StreamEventInput[]>();
  #cursors: Record<string, number> = {};
  #pendingAppends = new Map<string, PendingAppend>();

  constructor(initial: Partial<FrickCacheState> = {}) {
    for (const object of initial.objects ?? []) {
      this.#objects.set(objectKey(object.type, object.id), cloneObject(object));
    }
    for (const event of initial.streamEvents ?? []) {
      this.saveStreamEvent({} as FrickSchema, event);
    }
    this.#cursors = { ...(initial.cursors ?? {}) };
    for (const append of initial.pendingAppends ?? []) {
      this.#pendingAppends.set(append.requestId, clonePendingAppend(append));
    }
  }

  load(_schema: FrickSchema): FrickCacheState {
    return {
      objects: Array.from(this.#objects.values(), cloneObject),
      streamEvents: Array.from(this.#streamEvents.values()).flat().map(cloneStreamEvent),
      cursors: { ...this.#cursors },
      pendingAppends: Array.from(this.#pendingAppends.values(), clonePendingAppend),
    };
  }

  saveObject(_schema: FrickSchema, type: string, id: string, value: PlainObject, version: number): void {
    this.#objects.set(objectKey(type, id), {
      type,
      id,
      value: { id, ...value },
      version,
    });
  }

  saveStreamEvent(_schema: FrickSchema, event: StreamEventInput): void {
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

  saveCursor(_schema: FrickSchema, key: string, cursor: number): void {
    this.#cursors[key] = Math.max(this.#cursors[key] ?? 0, cursor);
  }

  savePendingAppend(_schema: FrickSchema, append: PendingAppend): void {
    this.#pendingAppends.set(append.requestId, clonePendingAppend(append));
  }

  removePendingAppend(_schema: FrickSchema, requestId: string): void {
    this.#pendingAppends.delete(requestId);
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
