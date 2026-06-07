/**
 * Postgres full-text search adapter (FR-24).
 *
 * Mirrors the SQLite FTS5 adapter but against Postgres's native full-text
 * search: the `search_indexes` table carries a `text_tsv TSVECTOR GENERATED
 * ALWAYS AS (to_tsvector('simple', text)) STORED` column with a GIN index (see
 * the Postgres framework migrations). Writes only touch `text`/`fields` — the
 * tsvector maintains itself — and queries match with `@@ plainto_tsquery` and
 * rank with `ts_rank`. Implements the same async {@link FrickSearchAdapter}
 * seam, so the framework is engine-agnostic.
 *
 * Relevance is adapter-defined: this adapter returns `ts_rank` (higher = more
 * relevant) and orders descending, where the SQLite adapter returns bm25
 * (lower = more relevant). The route layer leaves the score untouched.
 */
import type { SqlDriver } from "../storage/sql-driver.js";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  type FrickSearchAdapter,
  type FrickSearchHit,
  type FrickSearchIndexDefinition,
  type FrickSearchProjectInput,
  type FrickSearchQuery,
  type FrickSearchResult,
} from "./types.js";
import { withSearchSourceFields } from "./source-fields.js";

// Must match the text-search configuration the `text_tsv` generated column
// uses in the Postgres `search_indexes` migration (`to_tsvector('simple', …)`).
const SEARCH_TEXT_CONFIG = "simple";

function safeParseFields(raw: string): Record<string, string | number> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string | number>) : {};
  } catch {
    return {};
  }
}

export function createPgFtsSearchAdapter(sql: SqlDriver): FrickSearchAdapter {
  const defs = new Map<string, FrickSearchIndexDefinition>();

  async function clear(tenantId: string, indexName: string): Promise<void> {
    await sql.run(`DELETE FROM search_indexes WHERE tenant_id = ? AND index_name = ?`, [
      tenantId,
      indexName,
    ]);
  }

  return {
    id: "postgres-tsvector",
    registerIndex(def: FrickSearchIndexDefinition): void {
      defs.set(def.name, def);
    },
    async upsert(tenantId, indexName, doc): Promise<void> {
      await sql.run(
        `INSERT INTO search_indexes (tenant_id, index_name, doc_id, text, fields)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (tenant_id, index_name, doc_id) DO UPDATE SET
              text = excluded.text,
              fields = excluded.fields`,
        [tenantId, indexName, doc.docId, doc.text, JSON.stringify(doc.fields ?? {})],
      );
    },
    async delete(tenantId, indexName, docId): Promise<void> {
      await sql.run(
        `DELETE FROM search_indexes WHERE tenant_id = ? AND index_name = ? AND doc_id = ?`,
        [tenantId, indexName, docId],
      );
    },
    async query(tenantId, query: FrickSearchQuery): Promise<FrickSearchResult> {
      const rawLimit = query.limit ?? DEFAULT_SEARCH_LIMIT;
      const limit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(rawLimit)));
      const trimmed = query.q.trim();
      if (trimmed.length === 0) {
        return { hits: [], total: 0 };
      }

      // Exact-match field filters on the JSON `fields` column. Mirrors the
      // SQLite adapter's `json_extract(fields, '$.k') = v`.
      const filterEntries = Object.entries(query.filter ?? {});
      const filterClauses = filterEntries.map(() => `(fields::jsonb ->> ?) = ?`);
      const filterParams: Array<string | number> = [];
      for (const [key, value] of filterEntries) {
        filterParams.push(key);
        filterParams.push(String(value));
      }
      const filterSql = filterClauses.length > 0 ? ` AND ${filterClauses.join(" AND ")}` : "";

      const where = `text_tsv @@ plainto_tsquery('${SEARCH_TEXT_CONFIG}', ?)
            AND tenant_id = ?
            AND index_name = ?
            ${filterSql}`;

      const totalRow = await sql.get<{ count: number | string }>(
        `SELECT COUNT(*) AS count FROM search_indexes WHERE ${where}`,
        [trimmed, tenantId, query.index, ...filterParams],
      );
      const total = Number(totalRow?.count ?? 0);

      const rows = await sql.all<{ doc_id: string; fields: string; score: number }>(
        `SELECT doc_id,
                fields,
                ts_rank(text_tsv, plainto_tsquery('${SEARCH_TEXT_CONFIG}', ?)) AS score
           FROM search_indexes
          WHERE ${where}
          ORDER BY score DESC, doc_id ASC
          LIMIT ?`,
        [trimmed, trimmed, tenantId, query.index, ...filterParams, limit],
      );

      const hits: FrickSearchHit[] = rows.map((row) => ({
        docId: row.doc_id,
        score: Number(row.score),
        fields: safeParseFields(row.fields),
      }));
      return { hits, total };
    },
    async rebuild(
      tenantId: string,
      indexName: string,
      source: AsyncIterable<FrickSearchProjectInput>,
    ): Promise<void> {
      const def = defs.get(indexName);
      await clear(tenantId, indexName);
      if (!def) return;
      for await (const input of source) {
        const doc = def.project(input);
        if (doc) {
          await this.upsert(tenantId, indexName, withSearchSourceFields(input, doc));
        }
      }
    },
  };
}
