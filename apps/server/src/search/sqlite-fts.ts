import type { DatabaseSync } from "node:sqlite";
import { SearchIndexStore } from "../storage/search-store.js";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  type FrickSearchAdapter,
  type FrickSearchIndexDefinition,
  type FrickSearchProjectInput,
  type FrickSearchQuery,
  type FrickSearchResult,
} from "./types.js";
import { withSearchSourceFields } from "./source-fields.js";

/**
 * Default search adapter: a single `search_indexes` table fronted by a
 * `search_index_fts` FTS5 virtual table (see migration `0008_search_indexes`).
 * One adapter instance serves every registered index — `index_name` is a
 * filter column on the canonical table.
 *
 * The triggers installed by the migration mirror text into FTS on every
 * insert/update/delete, so this adapter only writes to `search_indexes`.
 */
export function createSqliteFtsSearchAdapter(db: DatabaseSync): FrickSearchAdapter {
  const store = new SearchIndexStore(db);
  const defs = new Map<string, FrickSearchIndexDefinition>();

  return {
    id: "sqlite-fts5",
    registerIndex(def: FrickSearchIndexDefinition): void {
      // Cache the def so `rebuild()` can re-project source rows without
      // needing the framework to pass the project function in.
      defs.set(def.name, def);
    },
    upsert(tenantId, indexName, doc) {
      store.upsert(tenantId, indexName, doc);
    },
    delete(tenantId, indexName, docId) {
      store.delete(tenantId, indexName, docId);
    },
    query(tenantId, query: FrickSearchQuery): FrickSearchResult {
      const rawLimit = query.limit ?? DEFAULT_SEARCH_LIMIT;
      const limit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(rawLimit)));
      const trimmed = query.q.trim();
      if (trimmed.length === 0) {
        // FTS5 MATCH with an empty string throws — treat as "no hits" so
        // callers don't need a special case before issuing a query.
        return { hits: [], total: 0 };
      }
      return store.query({
        tenantId,
        indexName: query.index,
        q: trimmed,
        ...(query.filter !== undefined ? { filter: query.filter } : {}),
        limit,
      });
    },
    async rebuild(
      tenantId: string,
      indexName: string,
      source: AsyncIterable<FrickSearchProjectInput>,
    ): Promise<void> {
      const def = defs.get(indexName);
      store.clear(tenantId, indexName);
      if (!def) {
        // Adapter has no record of this index — clearing was still the right
        // thing to do, but we can't re-project source rows. Return cleanly.
        return;
      }
      for await (const input of source) {
        const doc = def.project(input);
        if (doc) store.upsert(tenantId, indexName, withSearchSourceFields(input, doc));
      }
    },
  };
}
