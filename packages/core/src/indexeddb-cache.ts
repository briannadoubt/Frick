/**
 * Persistent web-platform implementation of {@link FrickLocalCache}.
 *
 * Mirrors every write the runtime makes through to IndexedDB so a page
 * reload (or a force-quit on mobile Safari) preserves the cached objects,
 * stream events, cursors, and — critically — the pending append queue.
 * On reopen, the runtime hydrates from this cache before connecting,
 * which means a user who composed messages offline sees them in the UI
 * and flushes them on reconnect without any extra ceremony.
 *
 * The cache is built on top of {@link MemoryFrickCache} (the in-memory
 * mirror is the source of truth for synchronous reads the runtime
 * depends on); IndexedDB writes happen asynchronously and are fire-and-
 * forget. A reload that races a write loses at most one mutation — the
 * pending-append queue is durable enough to absorb that with retries.
 *
 * To use:
 *
 *   const cache = await openIndexedDBFrickCache({ dbName: "my-app" });
 *   const client = new FrickClient({ endpoint, cache });
 *
 * The factory loads the persisted state from IndexedDB up front and
 * returns a ready-to-use cache. In Node / non-DOM environments the
 * factory throws — callers should branch on `typeof indexedDB !==
 * "undefined"` and fall back to {@link MemoryFrickCache}.
 */

import type { FrickSchema, PlainObject, StreamEventInput } from "@fricken/protocol";
import {
  MemoryFrickCache,
  type CachedObject,
  type FrickCacheState,
  type FrickCacheScope,
  type FrickLocalCache,
  type FrickCacheMetadata,
  type PendingAppend,
} from "./cache.js";

const DEFAULT_DB_NAME = "frick-cache";
const DB_VERSION = 1;
const STORE_OBJECTS = "objects";
const STORE_EVENTS = "events";
const STORE_CURSORS = "cursors";
const STORE_PENDING = "pendingAppends";
const STORE_META = "metadata";
const META_KEY = "schema";

export interface IndexedDBFrickCacheOptions {
  readonly dbName?: string;
  /** Override `globalThis.indexedDB`. Tests pass a fake. */
  readonly indexedDB?: IDBFactory;
}

/**
 * Open + hydrate a persistent cache. Reads every persisted record from
 * IndexedDB once at startup, populates the in-memory mirror, and returns a
 * cache that mirrors subsequent writes back through to IndexedDB.
 */
export async function openIndexedDBFrickCache(
  options: IndexedDBFrickCacheOptions = {},
): Promise<FrickLocalCache & { close(): void }> {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) {
    throw new Error(
      "IndexedDB is not available in this environment — fall back to MemoryFrickCache",
    );
  }
  const db = await openDb(factory, options.dbName ?? DEFAULT_DB_NAME);
  const initial = await loadInitialState(db);
  return new IndexedDBFrickCache(db, initial);
}

class IndexedDBFrickCache implements FrickLocalCache {
  readonly #mirror: MemoryFrickCache;
  readonly #db: IDBDatabase;

  constructor(db: IDBDatabase, initial: Partial<FrickCacheState>) {
    this.#db = db;
    this.#mirror = new MemoryFrickCache(initial);
  }

  load(schema: FrickSchema, scope?: FrickCacheScope): FrickCacheState {
    return this.#mirror.load(schema, scope);
  }

  saveObject(schema: FrickSchema, type: string, id: string, value: PlainObject, version: number, scope?: FrickCacheScope): void {
    this.#mirror.saveObject(schema, type, id, value, version, scope);
    this.#writeMetadata(schema, scope);
    this.#put(STORE_OBJECTS, `${type}\x00${id}`, { type, id, value, version });
  }

  saveStreamEvent(schema: FrickSchema, event: StreamEventInput, scope?: FrickCacheScope): void {
    this.#mirror.saveStreamEvent(schema, event, scope);
    this.#writeMetadata(schema, scope);
    this.#put(STORE_EVENTS, event.eventId, event);
  }

  saveCursor(schema: FrickSchema, key: string, cursor: number, scope?: FrickCacheScope): void {
    this.#mirror.saveCursor(schema, key, cursor, scope);
    this.#writeMetadata(schema, scope);
    this.#put(STORE_CURSORS, key, cursor);
  }

  savePendingAppend(schema: FrickSchema, append: PendingAppend, scope?: FrickCacheScope): void {
    this.#mirror.savePendingAppend(schema, append, scope);
    this.#writeMetadata(schema, scope);
    this.#put(STORE_PENDING, append.requestId, append);
  }

  removePendingAppend(schema: FrickSchema, requestId: string, scope?: FrickCacheScope): void {
    this.#mirror.removePendingAppend(schema, requestId, scope);
    this.#delete(STORE_PENDING, requestId);
  }

  clear(): void {
    this.#mirror.clear();
    const tx = this.#db.transaction(
      [STORE_OBJECTS, STORE_EVENTS, STORE_CURSORS, STORE_PENDING, STORE_META],
      "readwrite",
    );
    tx.objectStore(STORE_OBJECTS).clear();
    tx.objectStore(STORE_EVENTS).clear();
    tx.objectStore(STORE_CURSORS).clear();
    tx.objectStore(STORE_PENDING).clear();
    tx.objectStore(STORE_META).clear();
  }

  close(): void {
    this.#db.close();
  }

  #writeMetadata(schema: FrickSchema, scope: FrickCacheScope = {}): void {
    const metadata: FrickCacheMetadata = {
      schemaId: schema.schemaId,
      schemaVersion: schema.schemaVersion,
      schemaRevision: schema.schemaRevision,
      schemaHash: schema.hash,
      ...(scope.tenantId !== undefined ? { tenantId: scope.tenantId } : {}),
      ...(scope.userId !== undefined ? { userId: scope.userId } : {}),
    };
    this.#put(STORE_META, META_KEY, metadata);
  }

  #put(store: string, key: IDBValidKey, value: unknown): void {
    try {
      const tx = this.#db.transaction(store, "readwrite");
      tx.objectStore(store).put(value, key);
    } catch {
      // A write failure (quota / closed db) should not propagate — the
      // mirror still holds the value and the next cold-load will simply
      // miss it. Logging is the consumer's job via the FrickClient logger.
    }
  }

  #delete(store: string, key: IDBValidKey): void {
    try {
      const tx = this.#db.transaction(store, "readwrite");
      tx.objectStore(store).delete(key);
    } catch {
      // See above — best-effort.
    }
  }
}

function openDb(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of [STORE_OBJECTS, STORE_EVENTS, STORE_CURSORS, STORE_PENDING, STORE_META]) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store);
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

async function loadInitialState(db: IDBDatabase): Promise<Partial<FrickCacheState>> {
  const [objects, events, cursors, pending, metadata] = await Promise.all([
    getAll<CachedObject>(db, STORE_OBJECTS),
    getAll<StreamEventInput>(db, STORE_EVENTS),
    getAllPairs<number>(db, STORE_CURSORS),
    getAll<PendingAppend>(db, STORE_PENDING),
    getOne<FrickCacheMetadata>(db, STORE_META, META_KEY),
  ]);
  const cursorRecord: Record<string, number> = {};
  for (const [key, value] of cursors) cursorRecord[key] = value;
  return {
    objects,
    streamEvents: events,
    cursors: cursorRecord,
    pendingAppends: pending,
    ...(metadata ? { metadata } : {}),
  };
}

function getAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).getAll();
    req.onsuccess = () => resolve((req.result ?? []) as T[]);
    req.onerror = () => reject(req.error ?? new Error(`getAll ${store} failed`));
  });
}

function getAllPairs<T>(db: IDBDatabase, store: string): Promise<Array<[string, T]>> {
  return new Promise((resolve, reject) => {
    const out: Array<[string, T]> = [];
    const req = db.transaction(store, "readonly").objectStore(store).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(out);
      out.push([String(cursor.key), cursor.value as T]);
      cursor.continue();
    };
    req.onerror = () => reject(req.error ?? new Error(`openCursor ${store} failed`));
  });
}

function getOne<T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error ?? new Error(`get ${store} failed`));
  });
}
