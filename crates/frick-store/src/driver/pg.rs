//! The Postgres arm of the [`SqlDriver`](super::SqlDriver) seam (FR-242),
//! ported from `apps/server/src/storage/pg-sql-driver.ts`.
//!
//! Stores write SQLite-flavoured SQL with `?` positional placeholders; this
//! adapter [`rewrite_placeholders`] rewrites `?`→`$1, $2, …` and runs it on a
//! `deadpool_postgres` pool. Parameter normalization and result-shape mapping
//! are kept identical to the SQLite arm so the 20 stores behave the same on
//! both backends.
//!
//! Parameter + result conventions (TS `bindParams` / the BIGINT type parser):
//!   - Booleans already arrive as `Integer(1|0)` from the stores (flag columns
//!     are INTEGER/BIGINT on PG, never BOOLEAN), and `Null` → typed NULL.
//!   - `Blob` → BYTEA.
//!   - `int8`/`int4`/`int2` decode to [`SqlValue::Integer`] (mirroring the TS
//!     `pg.types.setTypeParser(20, Number)` so BIGINT round-trips like SQLite's
//!     numeric affinity), `float8`/`float4` → [`SqlValue::Real`],
//!     `text`/`varchar`/`bpchar` → [`SqlValue::Text`], `bytea` →
//!     [`SqlValue::Blob`], `bool` → `Integer(1|0)`, SQL NULL → [`SqlValue::Null`].

use deadpool_postgres::{Config, Object, Pool, Runtime};
use tokio_postgres::NoTls;
use tokio_postgres::types::{ToSql, Type};

use crate::error::StoreError;

use super::{RunResult, SqlRow, SqlValue};

/// Rewrite anonymous `?` placeholders to Postgres `$n` positionals, left to
/// right. `?` characters inside single-quoted string literals are left alone —
/// the Frick store SQL never embeds a literal `?`, but the guard keeps the
/// rewrite robust if one is ever added. `''` (an escaped quote inside a
/// literal) is handled implicitly by the double-toggle: the two quotes flip the
/// `in_string` flag off then back on, so the run stays "inside a string".
///
/// Pure and DB-free — unit-tested exhaustively below.
#[must_use]
pub fn rewrite_placeholders(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut n = 0u32;
    let mut in_string = false;
    for ch in sql.chars() {
        if ch == '\'' {
            in_string = !in_string;
            out.push(ch);
            continue;
        }
        if ch == '?' && !in_string {
            n += 1;
            out.push('$');
            // `n` is a positive integer; `itoa`-free formatting via `push_str`.
            out.push_str(&n.to_string());
            continue;
        }
        out.push(ch);
    }
    out
}

/// The Postgres driver: a `deadpool` connection pool. The pool connects lazily
/// (deadpool only opens a connection on first checkout), so construction stays
/// cheap and side-effect-free, like the TS `new Pool({connectionString})`.
pub struct PostgresDriver {
    pool: Pool,
}

impl PostgresDriver {
    /// Build the pool from a connection string. CI is localhost, so `NoTls`.
    pub fn connect(database_url: &str) -> Result<Self, StoreError> {
        let mut config = Config::new();
        config.url = Some(database_url.to_string());
        let pool = config
            .create_pool(Some(Runtime::Tokio1), NoTls)
            .map_err(|err| StoreError::driver(format!("postgres pool: {err}")))?;
        Ok(Self { pool })
    }

    /// Check out a pooled client (for the transaction path).
    pub(super) async fn checkout(&self) -> Result<Object, StoreError> {
        self.pool
            .get()
            .await
            .map_err(|err| StoreError::driver(format!("postgres checkout: {err}")))
    }

    pub(super) async fn get(
        &self,
        sql: &str,
        params: &[SqlValue],
    ) -> Result<Option<SqlRow>, StoreError> {
        let client = self.checkout().await?;
        query_one(&client, sql, params).await
    }

    pub(super) async fn all(
        &self,
        sql: &str,
        params: &[SqlValue],
    ) -> Result<Vec<SqlRow>, StoreError> {
        let client = self.checkout().await?;
        query_all(&client, sql, params).await
    }

    pub(super) async fn run(
        &self,
        sql: &str,
        params: &[SqlValue],
    ) -> Result<RunResult, StoreError> {
        let client = self.checkout().await?;
        run_query(&client, sql, params).await
    }

    pub(super) async fn exec(&self, sql: &str) -> Result<(), StoreError> {
        let client = self.checkout().await?;
        client_batch(&client, sql).await
    }
}

/// A transaction-scoped executor bound to a single checked-out client, exactly
/// like the TS `txClient`. Every statement runs on that one connection so the
/// open `BEGIN`/`COMMIT` wrap them; nested `transaction()` calls reuse it via
/// [`PostgresExec::reborrow`].
pub struct PostgresExec<'a> {
    client: &'a tokio_postgres::Client,
}

impl<'a> PostgresExec<'a> {
    pub(super) fn new(client: &'a tokio_postgres::Client) -> Self {
        Self { client }
    }

    /// Re-borrow the same client for a nested (reused) transaction scope.
    pub(super) fn reborrow(&self) -> PostgresExec<'a> {
        PostgresExec {
            client: self.client,
        }
    }

    pub(super) async fn get(
        &self,
        sql: &str,
        params: &[SqlValue],
    ) -> Result<Option<SqlRow>, StoreError> {
        query_one(self.client, sql, params).await
    }

    pub(super) async fn all(
        &self,
        sql: &str,
        params: &[SqlValue],
    ) -> Result<Vec<SqlRow>, StoreError> {
        query_all(self.client, sql, params).await
    }

    pub(super) async fn run(
        &self,
        sql: &str,
        params: &[SqlValue],
    ) -> Result<RunResult, StoreError> {
        run_query(self.client, sql, params).await
    }

    pub(super) async fn exec(&self, sql: &str) -> Result<(), StoreError> {
        client_batch(self.client, sql).await
    }
}

/// Multi-statement SQL via the simple-query protocol (no params), mirroring the
/// TS `exec()` / the migration runner's `BEGIN`/`COMMIT`/`ROLLBACK` and DDL.
pub(super) async fn client_batch(
    client: &tokio_postgres::Client,
    sql: &str,
) -> Result<(), StoreError> {
    client.batch_execute(sql).await.map_err(pg_error)
}

async fn query_all(
    client: &tokio_postgres::Client,
    sql: &str,
    params: &[SqlValue],
) -> Result<Vec<SqlRow>, StoreError> {
    let rewritten = rewrite_placeholders(sql);
    let bound = bind_params(params);
    let refs = bound_refs(&bound);
    let rows = client.query(&rewritten, &refs).await.map_err(pg_error)?;
    rows.iter().map(decode_row).collect()
}

async fn query_one(
    client: &tokio_postgres::Client,
    sql: &str,
    params: &[SqlValue],
) -> Result<Option<SqlRow>, StoreError> {
    let mut rows = query_all(client, sql, params).await?;
    if rows.is_empty() {
        Ok(None)
    } else {
        Ok(Some(rows.swap_remove(0)))
    }
}

async fn run_query(
    client: &tokio_postgres::Client,
    sql: &str,
    params: &[SqlValue],
) -> Result<RunResult, StoreError> {
    let rewritten = rewrite_placeholders(sql);
    let bound = bind_params(params);
    let refs = bound_refs(&bound);
    // Run via `query` (not `execute`) so a `RETURNING id` row is available:
    // Postgres has no rowid, so a caller needing the generated key appends
    // `RETURNING id` and we surface it here; otherwise 0 (TS `run()`).
    let rows = client.query(&rewritten, &refs).await.map_err(pg_error)?;
    let changes = rows.len() as u64;
    let last_insert_rowid = match rows.first() {
        Some(row) => row_id(row),
        None => 0,
    };
    Ok(RunResult {
        changes,
        last_insert_rowid,
    })
}

/// The `id` column of a `RETURNING id` row, decoded as i64 (BIGINT or INTEGER),
/// or 0 when the row has no `id` column. Mirrors the TS `firstRow.id`.
fn row_id(row: &tokio_postgres::Row) -> i64 {
    let Some((index, _)) = row
        .columns()
        .iter()
        .enumerate()
        .find(|(_, column)| column.name() == "id")
    else {
        return 0;
    };
    match *row.columns()[index].type_() {
        Type::INT8 => row.try_get::<_, Option<i64>>(index).ok().flatten(),
        Type::INT4 => row
            .try_get::<_, Option<i32>>(index)
            .ok()
            .flatten()
            .map(i64::from),
        Type::INT2 => row
            .try_get::<_, Option<i16>>(index)
            .ok()
            .flatten()
            .map(i64::from),
        _ => None,
    }
    .unwrap_or(0)
}

/// Decode one `tokio_postgres::Row` into a [`SqlRow`] by column name and type.
fn decode_row(row: &tokio_postgres::Row) -> Result<SqlRow, StoreError> {
    let mut columns = Vec::with_capacity(row.columns().len());
    for (index, column) in row.columns().iter().enumerate() {
        let value = decode_value(row, index, column)?;
        columns.push((column.name().to_string(), value));
    }
    Ok(SqlRow::from_columns(columns))
}

fn decode_value(
    row: &tokio_postgres::Row,
    index: usize,
    column: &tokio_postgres::Column,
) -> Result<SqlValue, StoreError> {
    let column_type = column.type_();
    let value = match *column_type {
        // int8 decodes as i64 — mirrors the TS BIGINT(OID 20)→Number parser, so
        // `expires_at`, identity ids, etc. round-trip the same as under SQLite.
        Type::INT8 => row
            .try_get::<_, Option<i64>>(index)
            .map_err(pg_error)?
            .map_or(SqlValue::Null, SqlValue::Integer),
        Type::INT4 => row
            .try_get::<_, Option<i32>>(index)
            .map_err(pg_error)?
            .map_or(SqlValue::Null, |value| SqlValue::Integer(i64::from(value))),
        Type::INT2 => row
            .try_get::<_, Option<i16>>(index)
            .map_err(pg_error)?
            .map_or(SqlValue::Null, |value| SqlValue::Integer(i64::from(value))),
        Type::FLOAT8 => row
            .try_get::<_, Option<f64>>(index)
            .map_err(pg_error)?
            .map_or(SqlValue::Null, SqlValue::Real),
        Type::FLOAT4 => row
            .try_get::<_, Option<f32>>(index)
            .map_err(pg_error)?
            .map_or(SqlValue::Null, |value| SqlValue::Real(f64::from(value))),
        Type::BOOL => row
            .try_get::<_, Option<bool>>(index)
            .map_err(pg_error)?
            .map_or(SqlValue::Null, SqlValue::from_bool),
        Type::BYTEA => row
            .try_get::<_, Option<Vec<u8>>>(index)
            .map_err(pg_error)?
            .map_or(SqlValue::Null, SqlValue::Blob),
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME => row
            .try_get::<_, Option<String>>(index)
            .map_err(pg_error)?
            .map_or(SqlValue::Null, SqlValue::Text),
        ref other => {
            return Err(StoreError::driver(format!(
                "postgres column '{}' has unsupported type {} (oid {})",
                column.name(),
                other.name(),
                other.oid()
            )));
        }
    };
    Ok(value)
}

/// An owned, `tokio_postgres`-bindable copy of each parameter. Booleans already
/// arrive as `Integer(1|0)` from the stores (TS `bindParams`), so there is no
/// boolean case here.
enum Bound {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

fn bind_params(params: &[SqlValue]) -> Vec<Bound> {
    params
        .iter()
        .map(|value| match value {
            SqlValue::Null => Bound::Null,
            SqlValue::Integer(v) => Bound::Integer(*v),
            SqlValue::Real(v) => Bound::Real(*v),
            SqlValue::Text(v) => Bound::Text(v.clone()),
            SqlValue::Blob(v) => Bound::Blob(v.clone()),
        })
        .collect()
}

fn bound_refs(bound: &[Bound]) -> Vec<&(dyn ToSql + Sync)> {
    bound
        .iter()
        .map(|value| match value {
            // A typed NULL: `Option::<i64>::None` binds NULL with a concrete
            // type the server can coerce to any column type at the planner.
            Bound::Null => &NULL_PARAM as &(dyn ToSql + Sync),
            Bound::Integer(v) => v as &(dyn ToSql + Sync),
            Bound::Real(v) => v as &(dyn ToSql + Sync),
            Bound::Text(v) => v as &(dyn ToSql + Sync),
            Bound::Blob(v) => v as &(dyn ToSql + Sync),
        })
        .collect()
}

/// A shared typed NULL (`Option::<i64>::None`). Binding `None::<i64>` sends a
/// NULL with the int8 type oid; Postgres coerces NULLs to the target column
/// type regardless of the sent type, so a single shared instance suffices for
/// every `Null` parameter.
static NULL_PARAM: Option<i64> = None;

// Takes the error by value so it can be used directly as `.map_err(pg_error)`,
// matching the `StoreError::sqlite` pattern.
#[allow(clippy::needless_pass_by_value)]
fn pg_error(err: tokio_postgres::Error) -> StoreError {
    StoreError::driver(err.to_string())
}

#[cfg(test)]
mod tests {
    use super::rewrite_placeholders;

    #[test]
    fn rewrites_no_params_unchanged() {
        assert_eq!(rewrite_placeholders("SELECT 1"), "SELECT 1");
        assert_eq!(
            rewrite_placeholders("SELECT * FROM t WHERE n = 5"),
            "SELECT * FROM t WHERE n = 5"
        );
    }

    #[test]
    fn rewrites_single_param() {
        assert_eq!(
            rewrite_placeholders("SELECT * FROM t WHERE id = ?"),
            "SELECT * FROM t WHERE id = $1"
        );
    }

    #[test]
    fn rewrites_multiple_params_left_to_right() {
        assert_eq!(
            rewrite_placeholders("INSERT INTO t (a, b, c) VALUES (?, ?, ?)"),
            "INSERT INTO t (a, b, c) VALUES ($1, $2, $3)"
        );
        assert_eq!(
            rewrite_placeholders("UPDATE t SET a = ?, b = ? WHERE id = ?"),
            "UPDATE t SET a = $1, b = $2 WHERE id = $3"
        );
    }

    #[test]
    fn skips_question_mark_inside_string_literal() {
        // A `?` inside a single-quoted literal is left alone; the real param
        // after it still numbers from $1.
        assert_eq!(
            rewrite_placeholders("SELECT * FROM t WHERE label = 'why?' AND id = ?"),
            "SELECT * FROM t WHERE label = 'why?' AND id = $1"
        );
        // A literal that is only a `?`.
        assert_eq!(
            rewrite_placeholders("INSERT INTO t (q) VALUES ('?')"),
            "INSERT INTO t (q) VALUES ('?')"
        );
    }

    #[test]
    fn handles_escaped_quote_double_toggle() {
        // `''` is an escaped quote inside the literal: the run stays "in
        // string", so the `?` between the escaped quotes is NOT rewritten, and
        // the trailing `?` outside is $1.
        assert_eq!(
            rewrite_placeholders("SELECT 'it''s a ?' AS x WHERE id = ?"),
            "SELECT 'it''s a ?' AS x WHERE id = $1"
        );
        // Two adjacent literals separated by a param.
        assert_eq!(
            rewrite_placeholders("SELECT 'a' || ? || 'b''c'"),
            "SELECT 'a' || $1 || 'b''c'"
        );
    }

    #[test]
    fn params_before_and_after_literals_number_continuously() {
        assert_eq!(
            rewrite_placeholders("SELECT ? , 'lit?lit' , ? , 'x' , ?"),
            "SELECT $1 , 'lit?lit' , $2 , 'x' , $3"
        );
    }

    #[test]
    fn empty_string_is_unchanged() {
        assert_eq!(rewrite_placeholders(""), "");
    }

    #[test]
    fn double_digit_param_indices() {
        let sql = std::iter::repeat_n("?", 12).collect::<Vec<_>>().join(",");
        let rewritten = rewrite_placeholders(&sql);
        assert_eq!(
            rewritten, "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12",
            "params past 9 keep numbering"
        );
    }
}
