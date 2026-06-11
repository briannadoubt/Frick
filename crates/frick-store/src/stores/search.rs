//! SQLite FTS5 search adapter (FR-245, map 03 §13).
//!
//! The durable full-text search surface. The `0009_search_indexes` migration
//! owns the schema: a `search_indexes(index_name, tenant_id, doc_id, text,
//! fields)` table keyed on `(tenant_id, index_name, doc_id)` plus a contentless
//! FTS5 companion `search_index_fts(text)` (`content='search_indexes'`,
//! `content_rowid='rowid'`, `tokenize='unicode61'`). The `ai`/`ad`/`au` triggers
//! keep the FTS index in sync automatically, so this adapter only ever writes
//! `search_indexes` rows — the triggers maintain the mirror.
//!
//! Determinism: search rows have no `created_at`, so these methods take no
//! `now_ms`. They are pure functions of the driver and their arguments.
//!
//! Dialect: this is the SQLite (`sqlite-fts5`) adapter. The Postgres `tsvector`
//! arm is a documented FR-242-style follow-up; the facade branches on the
//! driver dialect and no-ops on Postgres rather than failing (see
//! [`crate::facade`]).

use std::collections::BTreeMap;
use std::fmt::Write as _;

use serde_json::{Map, Value as JsonValue};

use crate::driver::{SqlDriver, SqlValue};
use crate::error::StoreError;

/// Stable adapter id surfaced by the inspect report (map 03 §13). The SQLite
/// adapter is FTS5-backed.
pub const SEARCH_ADAPTER_ID: &str = "sqlite-fts5";

/// Default page size when a search request omits `limit` (map 03 §13,
/// map 02 line 120).
pub const DEFAULT_SEARCH_LIMIT: u32 = 50;

/// Hard ceiling on `limit` for a search request (map 03 §13, map 02 line 120).
pub const MAX_SEARCH_LIMIT: u32 = 200;

/// A single write the search projector wants applied to an index, derived from a
/// store-write event (map 03 §13). The server builds these in its projector
/// callback; the store applies them through its own SQL methods so it stays the
/// sole owner of its writes.
#[derive(Debug, Clone, PartialEq)]
pub enum SearchOp {
    /// Insert or replace a document in an index. `fields` is the flattened,
    /// JSON-typed filter map (string/number values) persisted alongside the
    /// indexed `text`; it already carries the reserved `__frickSource*` keys.
    Upsert {
        index: String,
        doc_id: String,
        text: String,
        fields: Map<String, JsonValue>,
    },
    /// Remove a document from an index.
    Delete { index: String, doc_id: String },
}

/// A scalar a search request can filter on — the value of one `filter` entry
/// (map 03 §13). Filters compare against `json_extract(fields, '$.<key>')`.
#[derive(Debug, Clone, PartialEq)]
pub enum SearchFilterValue {
    Text(String),
    Number(f64),
}

/// One search hit: the document id and its persisted `fields` (including the
/// reserved `__frickSource*` keys — the server strips those before returning the
/// hit to the caller). Map 03 §13.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub doc_id: String,
    pub fields: Map<String, JsonValue>,
}

/// Result of a search query: the ordered hits (most relevant first) and the
/// total match count (computed independently of `limit`). Map 03 §13.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SearchQueryResult {
    pub hits: Vec<SearchHit>,
    pub total: u64,
}

/// `INSERT ... ON CONFLICT(tenant_id, index_name, doc_id) DO UPDATE SET text,
/// fields`. The `ai`/`au` triggers reflect the change into `search_index_fts`.
pub async fn search_upsert(
    driver: &SqlDriver,
    tenant_id: &str,
    index_name: &str,
    doc_id: &str,
    text: &str,
    fields: &Map<String, JsonValue>,
) -> Result<(), StoreError> {
    let fields_json = JsonValue::Object(fields.clone()).to_string();
    driver
        .run(
            "INSERT INTO search_indexes (tenant_id, index_name, doc_id, text, fields)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(tenant_id, index_name, doc_id)
                 DO UPDATE SET text = excluded.text, fields = excluded.fields",
            &[
                tenant_id.into(),
                index_name.into(),
                doc_id.into(),
                text.into(),
                fields_json.into(),
            ],
        )
        .await?;
    Ok(())
}

/// Remove a document. The `ad` trigger drops it from `search_index_fts`.
pub async fn search_delete(
    driver: &SqlDriver,
    tenant_id: &str,
    index_name: &str,
    doc_id: &str,
) -> Result<(), StoreError> {
    driver
        .run(
            "DELETE FROM search_indexes
                 WHERE tenant_id = ? AND index_name = ? AND doc_id = ?",
            &[tenant_id.into(), index_name.into(), doc_id.into()],
        )
        .await?;
    Ok(())
}

/// Clear `(tenant, index)` then re-insert every document (map 03 §13 `rebuild`).
/// The triggers keep the FTS mirror in step on each insert.
pub async fn search_rebuild(
    driver: &SqlDriver,
    tenant_id: &str,
    index_name: &str,
    docs: Vec<(String, String, Map<String, JsonValue>)>,
) -> Result<(), StoreError> {
    driver
        .run(
            "DELETE FROM search_indexes WHERE tenant_id = ? AND index_name = ?",
            &[tenant_id.into(), index_name.into()],
        )
        .await?;
    for (doc_id, text, fields) in docs {
        search_upsert(driver, tenant_id, index_name, &doc_id, &text, &fields).await?;
    }
    Ok(())
}

/// Query an index (map 03 §13). Empty/whitespace `q` short-circuits to an empty
/// result — FTS5 `MATCH` throws on an empty pattern. Otherwise: the total is a
/// `COUNT(*)` over the same join *first*, then the hits page is `bm25`-ordered
/// ascending (lower score = more relevant). Each `filter` entry adds a
/// `json_extract(si.fields, '$.<key>') = ?` clause.
pub async fn search_query(
    driver: &SqlDriver,
    tenant_id: &str,
    index_name: &str,
    q: &str,
    filter: &BTreeMap<String, SearchFilterValue>,
    limit: u32,
) -> Result<SearchQueryResult, StoreError> {
    if q.trim().is_empty() {
        return Ok(SearchQueryResult::default());
    }

    // Shared WHERE tail: tenant + index + FTS match + the filter clauses. The
    // bound params line up positionally across the COUNT and the page query.
    let mut where_sql =
        String::from(" WHERE si.tenant_id = ? AND si.index_name = ? AND search_index_fts MATCH ?");
    let mut params: Vec<SqlValue> = vec![tenant_id.into(), index_name.into(), q.into()];
    for (key, value) in filter {
        // `key` is a caller-supplied field name. `json_extract`'s path argument
        // cannot be parameterized, so guard it: only flat, identifier-shaped
        // keys are addressable, which is exactly what the doc `fields` map holds.
        // The route validates keys against the same `[A-Za-z0-9_-]` shape, so
        // reaching here with an unsafe key means a guard drifted — fail loud
        // (mapped to a 400 invalidSearchQuery upstream) rather than silently
        // dropping the clause and returning unfiltered results.
        if !is_safe_json_key(key) {
            return Err(StoreError::store(format!(
                "search filter key is not addressable: {key:?}"
            )));
        }
        // `key` passed `is_safe_json_key` (identifier-shaped), so the path
        // literal is safe to interpolate; the value stays a bound parameter.
        let _ = write!(where_sql, " AND json_extract(si.fields, '$.{key}') = ?");
        params.push(match value {
            SearchFilterValue::Text(text) => text.clone().into(),
            SearchFilterValue::Number(number) => number_param(*number),
        });
    }

    // Total first (independent of LIMIT), over the same join + filters.
    let count_sql = format!(
        "SELECT COUNT(*) AS total
             FROM search_indexes si
             JOIN search_index_fts ON si.rowid = search_index_fts.rowid{where_sql}"
    );
    let total = driver
        .get(&count_sql, &params)
        .await?
        .and_then(|row| row.i64("total"))
        .unwrap_or(0)
        .max(0)
        .unsigned_abs();

    // Hits page: bm25 ascending (lower = more relevant), capped at `limit`.
    let hits_sql = format!(
        "SELECT si.doc_id AS doc_id, si.fields AS fields, bm25(search_index_fts) AS score
             FROM search_indexes si
             JOIN search_index_fts ON si.rowid = search_index_fts.rowid{where_sql}
             ORDER BY score ASC
             LIMIT ?"
    );
    let mut hit_params = params;
    hit_params.push(i64::from(limit).into());
    let rows = driver.all(&hits_sql, &hit_params).await?;

    let hits = rows
        .iter()
        .map(|row| SearchHit {
            doc_id: row.text("doc_id").unwrap_or_default().to_owned(),
            fields: parse_fields(row.text("fields")),
        })
        .collect();

    Ok(SearchQueryResult { hits, total })
}

/// Every distinct index name with at least one document for the tenant. Used by
/// the inspect report (map 03 §13).
pub async fn search_index_names(
    driver: &SqlDriver,
    tenant_id: &str,
) -> Result<Vec<String>, StoreError> {
    let rows = driver
        .all(
            "SELECT DISTINCT index_name FROM search_indexes
                 WHERE tenant_id = ? ORDER BY index_name ASC",
            &[tenant_id.into()],
        )
        .await?;
    Ok(rows
        .iter()
        .filter_map(|row| row.text("index_name").map(str::to_owned))
        .collect())
}

/// Bind a JSON number as the matching SQL scalar so `json_extract = ?` compares
/// against the value SQLite stored. Integral values bind as INTEGER (SQLite's
/// `json_extract` yields an integer for whole numbers); fractional values bind
/// as REAL.
fn number_param(number: f64) -> SqlValue {
    if number.fract() == 0.0 && number.is_finite() && number.abs() < 9.007_199_254_740_992e15 {
        #[allow(clippy::cast_possible_truncation)]
        SqlValue::Integer(number as i64)
    } else {
        SqlValue::Real(number)
    }
}

/// Defensive parse of the persisted `fields` JSON (map 03 §13): a JSON object
/// whose entries are kept only when string- or number-typed. Anything else (a
/// non-object payload, nested objects/arrays, booleans, nulls) is dropped.
fn parse_fields(raw: Option<&str>) -> Map<String, JsonValue> {
    let Some(raw) = raw else {
        return Map::new();
    };
    let Ok(JsonValue::Object(object)) = serde_json::from_str::<JsonValue>(raw) else {
        return Map::new();
    };
    object
        .into_iter()
        .filter(|(_, value)| matches!(value, JsonValue::String(_) | JsonValue::Number(_)))
        .collect()
}

/// A filter key is addressable only when it is a flat, identifier-shaped name:
/// the `json_extract` path is interpolated (it cannot be a bound parameter), so
/// anything outside `[A-Za-z0-9_-]` is rejected. This matches the route's filter
/// key regex (`/^[A-Za-z0-9_-]+$/`) exactly; the hyphen is safe because it
/// cannot break out of the single-quoted `'$.<key>'` path literal (only a `'`
/// could). The reserved `__frickSource*` keys qualify.
fn is_safe_json_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact `0009_search_indexes` schema (table + contentless FTS5 mirror +
    /// the ai/ad/au triggers that keep the mirror in sync). Verbatim from
    /// `conformance/fixtures/migrations/sqlite.json` so these tests exercise the
    /// real trigger behaviour the adapter relies on.
    const DDL: &str = "
        CREATE TABLE IF NOT EXISTS search_indexes (
          index_name TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT '_default',
          doc_id TEXT NOT NULL,
          text TEXT NOT NULL,
          fields TEXT NOT NULL,
          PRIMARY KEY (tenant_id, index_name, doc_id)
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS search_index_fts USING fts5(
          text,
          content='search_indexes',
          content_rowid='rowid',
          tokenize='unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS search_indexes_ai AFTER INSERT ON search_indexes BEGIN
          INSERT INTO search_index_fts (rowid, text) VALUES (new.rowid, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS search_indexes_ad AFTER DELETE ON search_indexes BEGIN
          INSERT INTO search_index_fts (search_index_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        END;
        CREATE TRIGGER IF NOT EXISTS search_indexes_au AFTER UPDATE ON search_indexes BEGIN
          INSERT INTO search_index_fts (search_index_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
          INSERT INTO search_index_fts (rowid, text) VALUES (new.rowid, new.text);
        END;
    ";

    const TENANT: &str = "_default";
    const INDEX: &str = "docs";

    async fn memory_driver() -> SqlDriver {
        let driver = SqlDriver::open_sqlite(":memory:").unwrap();
        driver.exec(DDL).await.unwrap();
        driver
    }

    fn fields(pairs: &[(&str, JsonValue)]) -> Map<String, JsonValue> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.clone()))
            .collect()
    }

    /// Number of rows the FTS mirror reports for a MATCH, read directly so the
    /// tests assert the triggers actually maintain `search_index_fts`.
    async fn fts_match_count(driver: &SqlDriver, q: &str) -> i64 {
        driver
            .get(
                "SELECT COUNT(*) AS n FROM search_index_fts WHERE search_index_fts MATCH ?",
                &[q.into()],
            )
            .await
            .unwrap()
            .unwrap()
            .i64("n")
            .unwrap()
    }

    async fn upsert(driver: &SqlDriver, doc_id: &str, text: &str, f: &[(&str, JsonValue)]) {
        search_upsert(driver, TENANT, INDEX, doc_id, text, &fields(f))
            .await
            .unwrap();
    }

    fn no_filter() -> BTreeMap<String, SearchFilterValue> {
        BTreeMap::new()
    }

    #[tokio::test]
    async fn upsert_then_query_matches() {
        let driver = memory_driver().await;
        upsert(&driver, "d1", "the quick brown fox", &[]).await;

        let result = search_query(&driver, TENANT, INDEX, "fox", &no_filter(), 50)
            .await
            .unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].doc_id, "d1");
        // The trigger inserted the row into the FTS mirror.
        assert_eq!(fts_match_count(&driver, "fox").await, 1);
    }

    #[tokio::test]
    async fn multi_term_query_with_no_match_is_empty() {
        let driver = memory_driver().await;
        upsert(&driver, "d1", "the quick brown fox", &[]).await;

        // All terms ANDed: "fox" matches, "zebra" does not → no hit.
        let result = search_query(&driver, TENANT, INDEX, "fox zebra", &no_filter(), 50)
            .await
            .unwrap();
        assert_eq!(result.total, 0);
        assert!(result.hits.is_empty());
    }

    #[tokio::test]
    async fn filter_via_json_extract() {
        let driver = memory_driver().await;
        upsert(&driver, "d1", "alpha report", &[("kind", "report".into())]).await;
        upsert(&driver, "d2", "alpha memo", &[("kind", "memo".into())]).await;

        let mut filter = BTreeMap::new();
        filter.insert(
            "kind".to_string(),
            SearchFilterValue::Text("report".to_string()),
        );
        let result = search_query(&driver, TENANT, INDEX, "alpha", &filter, 50)
            .await
            .unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].doc_id, "d1");
    }

    #[tokio::test]
    async fn filter_with_hyphenated_key_is_applied() {
        // Regression: a hyphenated filter key (legal per the route regex
        // `[A-Za-z0-9_-]`) must apply the json_extract clause, not be silently
        // dropped — else the filter is a no-op and returns unfiltered results.
        let driver = memory_driver().await;
        upsert(&driver, "d1", "alpha", &[("room-id", "vault".into())]).await;
        upsert(&driver, "d2", "alpha", &[("room-id", "lobby".into())]).await;

        let mut filter = BTreeMap::new();
        filter.insert(
            "room-id".to_string(),
            SearchFilterValue::Text("vault".to_string()),
        );
        let result = search_query(&driver, TENANT, INDEX, "alpha", &filter, 50)
            .await
            .unwrap();
        assert_eq!(result.total, 1, "the hyphenated filter must narrow results");
        assert_eq!(result.hits[0].doc_id, "d1");
    }

    #[tokio::test]
    async fn filter_via_numeric_json_extract() {
        let driver = memory_driver().await;
        upsert(&driver, "d1", "alpha", &[("score", JsonValue::from(7))]).await;
        upsert(&driver, "d2", "alpha", &[("score", JsonValue::from(9))]).await;

        let mut filter = BTreeMap::new();
        filter.insert("score".to_string(), SearchFilterValue::Number(7.0));
        let result = search_query(&driver, TENANT, INDEX, "alpha", &filter, 50)
            .await
            .unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.hits[0].doc_id, "d1");
    }

    #[tokio::test]
    async fn bm25_orders_more_relevant_first() {
        let driver = memory_driver().await;
        // d1 repeats the term → lower (better) bm25; d2 mentions it once.
        upsert(&driver, "d1", "fox fox fox fox", &[]).await;
        upsert(&driver, "d2", "a lone fox among many other words here", &[]).await;

        let result = search_query(&driver, TENANT, INDEX, "fox", &no_filter(), 50)
            .await
            .unwrap();
        assert_eq!(result.total, 2);
        assert_eq!(result.hits.len(), 2);
        // Lower bm25 (more relevant) sorts first.
        assert_eq!(result.hits[0].doc_id, "d1");
        assert_eq!(result.hits[1].doc_id, "d2");
    }

    #[tokio::test]
    async fn empty_query_short_circuits() {
        let driver = memory_driver().await;
        upsert(&driver, "d1", "anything", &[]).await;

        for q in ["", "   ", "\t\n"] {
            let result = search_query(&driver, TENANT, INDEX, q, &no_filter(), 50)
                .await
                .unwrap();
            assert_eq!(result.total, 0, "q={q:?}");
            assert!(result.hits.is_empty(), "q={q:?}");
        }
    }

    #[tokio::test]
    async fn delete_removes_from_results_and_fts() {
        let driver = memory_driver().await;
        upsert(&driver, "d1", "deletable fox", &[]).await;
        assert_eq!(fts_match_count(&driver, "fox").await, 1);

        search_delete(&driver, TENANT, INDEX, "d1").await.unwrap();

        let result = search_query(&driver, TENANT, INDEX, "fox", &no_filter(), 50)
            .await
            .unwrap();
        assert_eq!(result.total, 0);
        assert!(result.hits.is_empty());
        // The ad trigger removed the row from the FTS mirror too.
        assert_eq!(fts_match_count(&driver, "fox").await, 0);
    }

    #[tokio::test]
    async fn upsert_conflict_updates_text_and_fts() {
        let driver = memory_driver().await;
        upsert(&driver, "d1", "original wombat", &[]).await;
        // Same (tenant, index, doc) → ON CONFLICT UPDATE; au trigger re-syncs FTS.
        upsert(&driver, "d1", "replaced platypus", &[]).await;

        assert_eq!(fts_match_count(&driver, "wombat").await, 0);
        assert_eq!(fts_match_count(&driver, "platypus").await, 1);
        let result = search_query(&driver, TENANT, INDEX, "platypus", &no_filter(), 50)
            .await
            .unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.hits[0].doc_id, "d1");
    }

    #[tokio::test]
    async fn rebuild_replaces_the_index() {
        let driver = memory_driver().await;
        upsert(&driver, "old1", "stale fox", &[]).await;
        upsert(&driver, "old2", "stale fox two", &[]).await;

        search_rebuild(
            &driver,
            TENANT,
            INDEX,
            vec![("new1".to_string(), "fresh fox".to_string(), Map::new())],
        )
        .await
        .unwrap();

        let result = search_query(&driver, TENANT, INDEX, "fox", &no_filter(), 50)
            .await
            .unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].doc_id, "new1");
        // The stale rows are gone from the FTS mirror.
        assert_eq!(fts_match_count(&driver, "stale").await, 0);
    }

    #[tokio::test]
    async fn reserved_fields_pass_through_to_hits() {
        let driver = memory_driver().await;
        upsert(
            &driver,
            "d1",
            "report body",
            &[
                ("__frickSourceKind", "object".into()),
                ("__frickSourceType", "Report".into()),
                ("__frickSourceId", "r1".into()),
                ("title", "Q4".into()),
            ],
        )
        .await;

        let result = search_query(&driver, TENANT, INDEX, "report", &no_filter(), 50)
            .await
            .unwrap();
        assert_eq!(result.hits.len(), 1);
        let hit = &result.hits[0];
        assert_eq!(
            hit.fields.get("__frickSourceKind"),
            Some(&JsonValue::from("object"))
        );
        assert_eq!(
            hit.fields.get("__frickSourceType"),
            Some(&JsonValue::from("Report"))
        );
        assert_eq!(hit.fields.get("title"), Some(&JsonValue::from("Q4")));
    }

    #[tokio::test]
    async fn limit_caps_hits_but_total_counts_all() {
        let driver = memory_driver().await;
        for i in 0..5 {
            upsert(&driver, &format!("d{i}"), "shared fox term", &[]).await;
        }

        let result = search_query(&driver, TENANT, INDEX, "fox", &no_filter(), 2)
            .await
            .unwrap();
        assert_eq!(result.hits.len(), 2, "limit caps the page");
        assert_eq!(result.total, 5, "total counts every match");
    }

    #[tokio::test]
    async fn fields_parse_is_defensive() {
        let driver = memory_driver().await;
        // String + number survive; bool/null/object/array are dropped on read.
        let mut raw = Map::new();
        raw.insert("keepStr".into(), JsonValue::from("s"));
        raw.insert("keepNum".into(), JsonValue::from(3));
        raw.insert("dropBool".into(), JsonValue::Bool(true));
        raw.insert("dropNull".into(), JsonValue::Null);
        raw.insert("dropArr".into(), JsonValue::Array(vec![JsonValue::from(1)]));
        search_upsert(&driver, TENANT, INDEX, "d1", "kept", &raw)
            .await
            .unwrap();

        let result = search_query(&driver, TENANT, INDEX, "kept", &no_filter(), 50)
            .await
            .unwrap();
        let hit = &result.hits[0];
        assert_eq!(hit.fields.len(), 2);
        assert!(hit.fields.contains_key("keepStr"));
        assert!(hit.fields.contains_key("keepNum"));
        assert!(!hit.fields.contains_key("dropBool"));
        assert!(!hit.fields.contains_key("dropNull"));
        assert!(!hit.fields.contains_key("dropArr"));
    }

    #[tokio::test]
    async fn index_names_are_distinct_and_tenant_scoped() {
        let driver = memory_driver().await;
        search_upsert(&driver, TENANT, "docs", "d1", "x", &Map::new())
            .await
            .unwrap();
        search_upsert(&driver, TENANT, "people", "p1", "y", &Map::new())
            .await
            .unwrap();
        search_upsert(&driver, TENANT, "docs", "d2", "z", &Map::new())
            .await
            .unwrap();
        // A different tenant's index must not leak.
        search_upsert(&driver, "other", "secret", "s1", "q", &Map::new())
            .await
            .unwrap();

        let names = search_index_names(&driver, TENANT).await.unwrap();
        assert_eq!(names, vec!["docs".to_string(), "people".to_string()]);
    }

    #[tokio::test]
    async fn query_is_tenant_scoped() {
        let driver = memory_driver().await;
        search_upsert(&driver, "t1", INDEX, "d1", "shared fox", &Map::new())
            .await
            .unwrap();
        search_upsert(&driver, "t2", INDEX, "d1", "shared fox", &Map::new())
            .await
            .unwrap();

        let result = search_query(&driver, "t1", INDEX, "fox", &no_filter(), 50)
            .await
            .unwrap();
        assert_eq!(result.total, 1, "only t1's doc is visible");
        assert_eq!(result.hits[0].doc_id, "d1");
    }
}
