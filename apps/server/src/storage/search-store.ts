import type { DatabaseSync } from "node:sqlite";
import type { FrickSearchDoc, FrickSearchHit } from "../search/types.js";

/**
 * Low-level SQLite operations backing the FTS5 search adapter. Keeps SQL,
 * parameter binding, and JSON encoding of structured fields in one spot so
 * the adapter implementation stays readable.
 *
 * Schema (created by migration `0008_search_indexes`):
 *   - `search_indexes` (canonical rows: tenant_id, index_name, doc_id, text, fields JSON)
 *   - `search_index_fts` (FTS5 virtual table — text mirrored via triggers)
 *
 * Triggers keep `search_index_fts` in lockstep with `search_indexes` so the
 * adapter only ever writes to the canonical table. Queries join the two by
 * rowid.
 */
export class SearchIndexStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * REPLACE INTO so re-indexing the same `(tenantId, indexName, docId)` is
   * idempotent — the FTS update trigger swaps the FTS row at the same time.
   * REPLACE first DELETEs then INSERTs; the FTS triggers handle both halves.
   */
  upsert(tenantId: string, indexName: string, doc: FrickSearchDoc): void {
    const fieldsJson = JSON.stringify(doc.fields ?? {});
    this.db
      .prepare(
        `INSERT INTO search_indexes (tenant_id, index_name, doc_id, text, fields)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id, index_name, doc_id) DO UPDATE SET
            text = excluded.text,
            fields = excluded.fields`,
      )
      .run(tenantId, indexName, doc.docId, doc.text, fieldsJson);
  }

  delete(tenantId: string, indexName: string, docId: string): void {
    this.db
      .prepare(
        `DELETE FROM search_indexes WHERE tenant_id = ? AND index_name = ? AND doc_id = ?`,
      )
      .run(tenantId, indexName, docId);
  }

  /** Clear every row under `(tenantId, indexName)`. Used by rebuild. */
  clear(tenantId: string, indexName: string): void {
    this.db
      .prepare(`DELETE FROM search_indexes WHERE tenant_id = ? AND index_name = ?`)
      .run(tenantId, indexName);
  }

  /**
   * Execute a MATCH-style FTS query joined back against `search_indexes`,
   * filtered by tenant + index. Applies the supplied exact-match `filter`
   * over the JSON `fields` column via `json_extract`.
   *
   * Returns the hits in ascending bm25 order (most relevant first — FTS5's
   * bm25() returns a negative-of-relevance, so we sort ASC) up to `limit`.
   */
  query(args: {
    tenantId: string;
    indexName: string;
    q: string;
    filter?: Record<string, string | number>;
    limit: number;
  }): { hits: FrickSearchHit[]; total: number } {
    const filterEntries = Object.entries(args.filter ?? {});
    const filterClauses = filterEntries.map(() => `json_extract(si.fields, ?) = ?`);
    const filterParams: Array<string | number> = [];
    for (const [key, value] of filterEntries) {
      filterParams.push(`$.${key}`);
      filterParams.push(value);
    }
    const filterSql = filterClauses.length > 0 ? ` AND ${filterClauses.join(" AND ")}` : "";

    // Total — same filters, but `COUNT(*)` over the join. We compute total
    // before slicing so callers can paginate later.
    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM search_indexes si
           JOIN search_index_fts ON search_index_fts.rowid = si.rowid
          WHERE search_index_fts MATCH ?
            AND si.tenant_id = ?
            AND si.index_name = ?
            ${filterSql}`,
      )
      .get(args.q, args.tenantId, args.indexName, ...filterParams) as
      | { count: number }
      | undefined;
    const total = Number(totalRow?.count ?? 0);

    const rows = this.db
      .prepare(
        `SELECT si.doc_id AS doc_id, si.fields AS fields, bm25(search_index_fts) AS score
           FROM search_indexes si
           JOIN search_index_fts ON search_index_fts.rowid = si.rowid
          WHERE search_index_fts MATCH ?
            AND si.tenant_id = ?
            AND si.index_name = ?
            ${filterSql}
          ORDER BY score ASC
          LIMIT ?`,
      )
      .all(args.q, args.tenantId, args.indexName, ...filterParams, args.limit) as Array<{
      doc_id: string;
      fields: string;
      score: number;
    }>;

    const hits: FrickSearchHit[] = rows.map((row) => ({
      docId: row.doc_id,
      score: Number(row.score),
      fields: safeParseFields(row.fields),
    }));
    return { hits, total };
  }
}

function safeParseFields(raw: string): Record<string, string | number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string | number> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string" || typeof value === "number") {
          out[key] = value;
        }
      }
      return out;
    }
  } catch {
    // Malformed JSON shouldn't tear down the route — drop fields silently.
  }
  return {};
}
