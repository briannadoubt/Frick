import type { PlainObject } from "@frick/protocol";

/**
 * The search subsystem is a pluggable full-text layer over framework-managed
 * source primitives (objects, streams, projections). Apps register
 * {@link FrickSearchIndexDefinition}s; the framework wires each registered
 * index into the write path of its source primitive and, on every successful
 * write, calls `project()` to derive a {@link FrickSearchDoc}. The doc is
 * persisted via the configured {@link FrickSearchAdapter} (the first
 * implementation is SQLite FTS5).
 *
 * Authz is enforced before any hit leaves the server — see `authz.ts`'s
 * `"search.query"` action and the `POST /search` route. The built-in
 * `messages-fts` index and app indexes backed by foundation sources with
 * framework visibility checks can be queried by tenant users. App indexes
 * over custom sources require an explicit allow from a registered policy
 * hook; admin principals can still query them for inspection and operations.
 */

/** Source primitive an index ingests from. */
export type FrickSearchIndexSource =
  | { kind: "stream"; type: string }
  | { kind: "object"; type: string }
  | { kind: "projection"; name: string };

/**
 * One row projected into the index, discriminated by the source kind. Only
 * one of `streamEvent`, `object`, `projectionRow` is set at a time.
 */
export interface FrickSearchProjectInput {
  tenantId: string;
  streamEvent?: {
    stream: string;
    streamId: string;
    sequence: number;
    /** Stable id of the source stream event — reuse as the doc id by default. */
    eventId: string;
    event: string;
    payload: PlainObject;
  };
  object?: { type: string; id: string; value: PlainObject };
  projectionRow?: { name: string; key: string; value: PlainObject };
}

export interface FrickSearchDoc {
  /** Stable id for the indexed document. Reusing source ids is fine. */
  docId: string;
  /** Already-flattened searchable text. */
  text: string;
  /** Structured fields filterable through the query API. */
  fields?: Record<string, string | number>;
}

export interface FrickSearchIndexDefinition {
  /** Stable identifier — e.g. "messages-fts". */
  name: string;
  /** Source primitive the index ingests from. */
  source: FrickSearchIndexSource;
  /**
   * Project a source row into an index document. Return `null` to skip
   * indexing the row (e.g. a stream event of an uninteresting type).
   */
  project(input: FrickSearchProjectInput): FrickSearchDoc | null;
}

export interface FrickSearchQuery {
  /** Registered index name. */
  index: string;
  /** Full-text query (FTS5 MATCH-style for the SQLite adapter). */
  q: string;
  /** Exact-match filter over fields supplied at projection time. */
  filter?: Record<string, string | number>;
  /** 1..200, default 50. Adapter enforces. */
  limit?: number;
}

export interface FrickSearchHit {
  docId: string;
  /**
   * Adapter-defined relevance. The SQLite FTS5 adapter uses raw bm25
   * (lower = more relevant); the route layer leaves the value untouched so
   * apps that swap engines aren't surprised by translation.
   */
  score: number;
  fields: Record<string, string | number>;
}

export interface FrickSearchResult {
  hits: FrickSearchHit[];
  total: number;
}

/**
 * Registry of search indexes. Held by FrickStore alongside `projections` and
 * consulted on every object/stream write.
 */
export interface FrickSearchIndexRegistry {
  register(def: FrickSearchIndexDefinition): void;
  get(name: string): FrickSearchIndexDefinition | undefined;
  list(): readonly FrickSearchIndexDefinition[];
}

export function createFrickSearchIndexRegistry(): FrickSearchIndexRegistry {
  const indexes: FrickSearchIndexDefinition[] = [];
  const byName = new Map<string, FrickSearchIndexDefinition>();
  return {
    register(def) {
      if (byName.has(def.name)) {
        throw new Error(`Search index "${def.name}" is already registered`);
      }
      byName.set(def.name, def);
      indexes.push(def);
    },
    get: (name) => byName.get(name),
    list: () => indexes.slice(),
  };
}

/**
 * Adapter interface. The default implementation lives in
 * `apps/server/src/search/sqlite-fts.ts`; external engines plug in by
 * implementing this surface.
 *
 * All methods are tenant-scoped — adapters MUST never return rows belonging
 * to a different tenant than the one in the query.
 */
export interface FrickSearchAdapter {
  /** Stable adapter identifier surfaced through inspection (e.g. "sqlite-fts5"). */
  readonly id: string;
  /**
   * Notify the adapter that an index has been declared. Adapters can use this
   * to allocate per-index state (separate FTS tables, schema, etc.). The
   * default SQLite implementation reuses a single `search_indexes` table and
   * filters by `index_name`, so its `registerIndex` is a no-op.
   */
  registerIndex(def: FrickSearchIndexDefinition): void;
  upsert(tenantId: string, indexName: string, doc: FrickSearchDoc): void;
  delete(tenantId: string, indexName: string, docId: string): void;
  query(tenantId: string, query: FrickSearchQuery): FrickSearchResult;
  /**
   * Wipe everything indexed under `(tenantId, indexName)` and re-ingest from
   * the supplied source iterator. Used by the admin rebuild route.
   */
  rebuild(
    tenantId: string,
    indexName: string,
    source: AsyncIterable<FrickSearchProjectInput>,
  ): Promise<void>;
}

/**
 * Default upper bound on hits returned per query. The route layer enforces
 * this even if an app's adapter is more permissive.
 */
export const DEFAULT_SEARCH_LIMIT = 50;
export const MAX_SEARCH_LIMIT = 200;
