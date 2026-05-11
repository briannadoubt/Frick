/**
 * Bounded in-memory idempotency cache.
 *
 * The durable source of truth for idempotency lookups is the `idempotency_keys`
 * SQLite table (see {@link StreamStore}). However, every distinct request id
 * that has ever been seen for a stream key sits in that table forever, and a
 * naive in-process map fronting it would grow without bound too. This module
 * provides a classic LRU map keyed by a caller-defined string (typically
 * `replicaId|requestId`) and bounded by a configurable capacity. When the
 * capacity is exceeded, the least-recently-used entries are dropped from the
 * cache — those callers simply fall through to the SQLite lookup on the next
 * access, so dropping a cache entry never breaks idempotency semantics.
 *
 * The cache is intentionally pure (no I/O, no async, no time-based eviction).
 */
export interface IdempotencyCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  readonly size: number;
  readonly evictions: number;
}

export class BoundedIdempotencyCache<V> implements IdempotencyCache<V> {
  readonly #capacity: number;
  readonly #entries = new Map<string, V>();
  #evictions = 0;

  constructor(capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(`BoundedIdempotencyCache capacity must be > 0, got ${capacity}`);
    }
    this.#capacity = Math.floor(capacity);
  }

  get capacity(): number {
    return this.#capacity;
  }

  get size(): number {
    return this.#entries.size;
  }

  get evictions(): number {
    return this.#evictions;
  }

  get(key: string): V | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) {
      return undefined;
    }
    // Refresh recency by re-inserting at the end of the Map iteration order.
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    // Re-set semantics: delete first so the key is moved to the most-recent
    // position regardless of whether it already existed.
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.#capacity) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#entries.delete(oldest);
      this.#evictions += 1;
    }
  }
}
