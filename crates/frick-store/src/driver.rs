//! The async storage seam (`apps/server/src/storage/sql-driver.ts`).
//!
//! Every store speaks this interface with `?` positional placeholders; the
//! SQLite arm passes them through (the future Postgres arm rewrites `?`→`$n`,
//! FR-242). Parameter normalization mirrors TS `bindParams`: booleans bind as
//! `1`/`0` (flag columns are INTEGER), absent values as NULL.
//!
//! Transactions are `BEGIN IMMEDIATE` … `COMMIT` with rollback on error
//! (rollback failures swallowed, original error rethrown), and nested
//! `transaction()` calls on a tx-scoped executor reuse the outer transaction
//! — no savepoints, exactly like the TS `#txDepth` counter.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;

use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::StoreError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SqlDialect {
    Sqlite,
    /// Reserved for FR-242.
    Postgres,
}

impl SqlDialect {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Sqlite => "sqlite",
            Self::Postgres => "postgres",
        }
    }
}

/// A bindable SQL parameter (`null | number | bigint | string | Uint8Array`
/// plus the boolean normalization in TS `bindParams`).
#[derive(Debug, Clone, PartialEq)]
pub enum SqlValue {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl SqlValue {
    #[must_use]
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::Integer(value) => Some(*value),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Text(value) => Some(value),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_blob(&self) -> Option<&[u8]> {
        match self {
            Self::Blob(value) => Some(value),
            _ => None,
        }
    }

    /// TS `bindParams`: flag columns are INTEGER, never BOOLEAN.
    #[must_use]
    pub fn from_bool(flag: bool) -> Self {
        Self::Integer(i64::from(flag))
    }
}

impl From<&str> for SqlValue {
    fn from(value: &str) -> Self {
        Self::Text(value.to_string())
    }
}

impl From<String> for SqlValue {
    fn from(value: String) -> Self {
        Self::Text(value)
    }
}

impl From<i64> for SqlValue {
    fn from(value: i64) -> Self {
        Self::Integer(value)
    }
}

impl From<bool> for SqlValue {
    fn from(value: bool) -> Self {
        Self::from_bool(value)
    }
}

impl From<Vec<u8>> for SqlValue {
    fn from(value: Vec<u8>) -> Self {
        Self::Blob(value)
    }
}

impl<T> From<Option<T>> for SqlValue
where
    T: Into<SqlValue>,
{
    fn from(value: Option<T>) -> Self {
        value.map_or(Self::Null, Into::into)
    }
}

impl rusqlite::ToSql for SqlValue {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        use rusqlite::types::{ToSqlOutput, ValueRef};
        Ok(match self {
            Self::Null => ToSqlOutput::Borrowed(ValueRef::Null),
            Self::Integer(value) => ToSqlOutput::Borrowed(ValueRef::Integer(*value)),
            Self::Real(value) => ToSqlOutput::Borrowed(ValueRef::Real(*value)),
            Self::Text(value) => ToSqlOutput::Borrowed(ValueRef::Text(value.as_bytes())),
            Self::Blob(value) => ToSqlOutput::Borrowed(ValueRef::Blob(value)),
        })
    }
}

/// One result row: column name → value, in select-list order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SqlRow {
    columns: Vec<(String, SqlValue)>,
}

impl SqlRow {
    #[must_use]
    pub fn get(&self, name: &str) -> Option<&SqlValue> {
        self.columns
            .iter()
            .find(|(column, _)| column == name)
            .map(|(_, value)| value)
    }

    /// The column's i64 value; `None` when absent or NULL/non-integer.
    #[must_use]
    pub fn i64(&self, name: &str) -> Option<i64> {
        self.get(name).and_then(SqlValue::as_i64)
    }

    #[must_use]
    pub fn text(&self, name: &str) -> Option<&str> {
        self.get(name).and_then(SqlValue::as_str)
    }

    #[must_use]
    pub fn blob(&self, name: &str) -> Option<&[u8]> {
        self.get(name).and_then(SqlValue::as_blob)
    }

    /// Flag columns are INTEGER 1/0 (see [`SqlValue::from_bool`]).
    #[must_use]
    pub fn flag(&self, name: &str) -> Option<bool> {
        self.i64(name).map(|value| value != 0)
    }
}

/// Result of a mutating statement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunResult {
    pub changes: u64,
    pub last_insert_rowid: i64,
}

type TxFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, StoreError>> + Send + 'a>>;

/// The storage driver. An enum rather than a trait so transactional methods
/// stay generic; FR-242 adds the Postgres arm behind the same surface.
pub enum SqlDriver {
    Sqlite(SqliteDriver),
}

// The query methods are `async` even though the SQLite arm runs
// synchronously: `async` is the seam contract. The FR-242 Postgres arm
// genuinely awaits, and every caller already `.await`s, so keeping the
// signatures async now avoids a churning API change at cutover.
#[allow(clippy::unused_async)]
impl SqlDriver {
    /// Open (or create) a SQLite database. Mirrors `createSqlDriver`:
    /// parent directories are created unless the path is `:memory:`.
    pub fn open_sqlite(path: &str) -> Result<Self, StoreError> {
        let connection = if path == ":memory:" {
            Connection::open_in_memory()
        } else {
            if let Some(parent) = Path::new(path).parent()
                && !parent.as_os_str().is_empty()
            {
                std::fs::create_dir_all(parent).map_err(|err| {
                    StoreError::driver(format!("mkdir {}: {err}", parent.display()))
                })?;
            }
            Connection::open(path)
        }
        .map_err(StoreError::sqlite)?;

        // Match production's connection pragmas (`storage/schema.ts`
        // `initializeStorage`): WAL + synchronous=NORMAL. Production also
        // relies on SQLite's default `foreign_keys = OFF` — the `blob_content`
        // FK is documentary (map 03 §3.1) — but rusqlite's bundled build
        // enables enforcement, so disable it explicitly for parity. `WAL` is a
        // no-op on `:memory:` and is silently ignored there.
        connection
            .execute_batch(
                "PRAGMA foreign_keys = OFF; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;",
            )
            .map_err(StoreError::sqlite)?;

        Ok(Self::Sqlite(SqliteDriver {
            connection: Mutex::new(connection),
        }))
    }

    #[must_use]
    pub fn dialect(&self) -> SqlDialect {
        match self {
            Self::Sqlite(_) => SqlDialect::Sqlite,
        }
    }

    /// First row or `None`.
    pub async fn get(&self, sql: &str, params: &[SqlValue]) -> Result<Option<SqlRow>, StoreError> {
        match self {
            Self::Sqlite(driver) => sqlite_get(&driver.connection, sql, params),
        }
    }

    /// All rows (empty when none).
    pub async fn all(&self, sql: &str, params: &[SqlValue]) -> Result<Vec<SqlRow>, StoreError> {
        match self {
            Self::Sqlite(driver) => sqlite_all(&driver.connection, sql, params),
        }
    }

    /// Execute a mutating statement.
    pub async fn run(&self, sql: &str, params: &[SqlValue]) -> Result<RunResult, StoreError> {
        match self {
            Self::Sqlite(driver) => sqlite_run(&driver.connection, sql, params),
        }
    }

    /// Multi-statement DDL, no params.
    pub async fn exec(&self, sql: &str) -> Result<(), StoreError> {
        match self {
            Self::Sqlite(driver) => sqlite_exec(&driver.connection, sql),
        }
    }

    /// `BEGIN IMMEDIATE` … callback … `COMMIT`, rolling back on error
    /// (rollback failures swallowed; the callback's error is rethrown).
    /// The callback receives a tx-scoped [`SqlExec`]; nested
    /// [`SqlExec::transaction`] calls reuse the outer transaction.
    pub async fn transaction<T, F>(&self, callback: F) -> Result<T, StoreError>
    where
        T: Send,
        F: for<'a> FnOnce(&'a SqlExec<'a>) -> TxFuture<'a, T> + Send,
    {
        match self {
            Self::Sqlite(driver) => {
                sqlite_exec(&driver.connection, "BEGIN IMMEDIATE")?;
                let executor = SqlExec {
                    connection: &driver.connection,
                };
                match callback(&executor).await {
                    Ok(value) => {
                        sqlite_exec(&driver.connection, "COMMIT")?;
                        Ok(value)
                    }
                    Err(err) => {
                        let _ = sqlite_exec(&driver.connection, "ROLLBACK");
                        Err(err)
                    }
                }
            }
        }
    }

    /// Tx-free executor view, so helpers can be written once against
    /// [`SqlExec`]-like surfaces. Locks per call.
    pub async fn close(self) {
        // rusqlite closes on drop; mirror the TS close() contract explicitly.
        drop(self);
    }
}

/// A transaction-scoped executor: same query surface, already inside the
/// open transaction. The connection lock is NOT held across the callback —
/// mirroring TS, where other tasks' statements can interleave into an open
/// transaction at await points (single shared connection on both sides).
pub struct SqlExec<'a> {
    connection: &'a Mutex<Connection>,
}

// Same async-seam rationale as the `SqlDriver` impl above.
#[allow(clippy::unused_async)]
impl SqlExec<'_> {
    pub async fn get(&self, sql: &str, params: &[SqlValue]) -> Result<Option<SqlRow>, StoreError> {
        sqlite_get(self.connection, sql, params)
    }

    pub async fn all(&self, sql: &str, params: &[SqlValue]) -> Result<Vec<SqlRow>, StoreError> {
        sqlite_all(self.connection, sql, params)
    }

    pub async fn run(&self, sql: &str, params: &[SqlValue]) -> Result<RunResult, StoreError> {
        sqlite_run(self.connection, sql, params)
    }

    pub async fn exec(&self, sql: &str) -> Result<(), StoreError> {
        sqlite_exec(self.connection, sql)
    }

    /// Nested transactions reuse the outer one (TS `#txDepth`): the callback
    /// simply runs inside the already-open transaction.
    pub async fn transaction<T, F>(&self, callback: F) -> Result<T, StoreError>
    where
        T: Send,
        F: for<'b> FnOnce(&'b SqlExec<'b>) -> TxFuture<'b, T> + Send,
    {
        let nested = SqlExec {
            connection: self.connection,
        };
        callback(&nested).await
    }
}

/// The SQLite arm: a single `rusqlite::Connection` behind a (briefly held)
/// sync mutex — everything runs synchronously inside async shells, like
/// `node:sqlite` under the TS driver. The lock is never held across awaits.
pub struct SqliteDriver {
    connection: Mutex<Connection>,
}

fn sqlite_exec(connection: &Mutex<Connection>, sql: &str) -> Result<(), StoreError> {
    lock(connection)?
        .execute_batch(sql)
        .map_err(StoreError::sqlite)
}

fn lock(
    connection: &Mutex<Connection>,
) -> Result<std::sync::MutexGuard<'_, Connection>, StoreError> {
    connection
        .lock()
        .map_err(|_| StoreError::driver("sqlite connection mutex poisoned"))
}

fn sqlite_get(
    connection: &Mutex<Connection>,
    sql: &str,
    params: &[SqlValue],
) -> Result<Option<SqlRow>, StoreError> {
    let mut rows = sqlite_all(connection, sql, params)?;
    if rows.is_empty() {
        Ok(None)
    } else {
        Ok(Some(rows.swap_remove(0)))
    }
}

fn sqlite_all(
    connection: &Mutex<Connection>,
    sql: &str,
    params: &[SqlValue],
) -> Result<Vec<SqlRow>, StoreError> {
    let connection = lock(connection)?;
    let mut statement = connection.prepare(sql).map_err(StoreError::sqlite)?;
    let column_names: Vec<String> = statement
        .column_names()
        .iter()
        .map(ToString::to_string)
        .collect();
    let mut rows = statement
        .query(rusqlite::params_from_iter(params.iter()))
        .map_err(StoreError::sqlite)?;
    let mut result = Vec::new();
    while let Some(row) = rows.next().map_err(StoreError::sqlite)? {
        let mut columns = Vec::with_capacity(column_names.len());
        for (index, name) in column_names.iter().enumerate() {
            let value = match row.get_ref(index).map_err(StoreError::sqlite)? {
                rusqlite::types::ValueRef::Null => SqlValue::Null,
                rusqlite::types::ValueRef::Integer(value) => SqlValue::Integer(value),
                rusqlite::types::ValueRef::Real(value) => SqlValue::Real(value),
                rusqlite::types::ValueRef::Text(value) => {
                    SqlValue::Text(String::from_utf8(value.to_vec()).map_err(|err| {
                        StoreError::driver(format!("non-utf8 text column: {err}"))
                    })?)
                }
                rusqlite::types::ValueRef::Blob(value) => SqlValue::Blob(value.to_vec()),
            };
            columns.push((name.clone(), value));
        }
        result.push(SqlRow { columns });
    }
    Ok(result)
}

fn sqlite_run(
    connection: &Mutex<Connection>,
    sql: &str,
    params: &[SqlValue],
) -> Result<RunResult, StoreError> {
    let connection = lock(connection)?;
    let changes = connection
        .prepare(sql)
        .and_then(|mut statement| statement.execute(rusqlite::params_from_iter(params.iter())))
        .map_err(StoreError::sqlite)?;
    Ok(RunResult {
        changes: changes as u64,
        last_insert_rowid: connection.last_insert_rowid(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_driver() -> SqlDriver {
        SqlDriver::open_sqlite(":memory:").unwrap()
    }

    #[tokio::test]
    async fn round_trips_rows_and_params() {
        let driver = memory_driver();
        driver
            .exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, flag INTEGER, data BLOB)")
            .await
            .unwrap();
        let result = driver
            .run(
                "INSERT INTO t (name, flag, data) VALUES (?, ?, ?)",
                &[
                    SqlValue::from("ada"),
                    SqlValue::from(true),
                    SqlValue::from(vec![1u8, 2]),
                ],
            )
            .await
            .unwrap();
        assert_eq!(result.changes, 1);
        assert_eq!(result.last_insert_rowid, 1);

        let row = driver
            .get("SELECT * FROM t WHERE name = ?", &[SqlValue::from("ada")])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.flag("flag"), Some(true));
        assert_eq!(row.blob("data"), Some(&[1u8, 2][..]));
        assert_eq!(
            driver
                .get("SELECT * FROM t WHERE name = ?", &[SqlValue::from("bo")])
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn transaction_commits_and_rolls_back() {
        let driver = memory_driver();
        driver
            .exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)")
            .await
            .unwrap();

        driver
            .transaction(|tx| {
                Box::pin(async move {
                    tx.run("INSERT INTO t (n) VALUES (?)", &[SqlValue::from(1i64)])
                        .await?;
                    // Nested transactions reuse the outer one.
                    tx.transaction(|inner| {
                        Box::pin(async move {
                            inner
                                .run("INSERT INTO t (n) VALUES (?)", &[SqlValue::from(2i64)])
                                .await
                        })
                    })
                    .await?;
                    Ok(())
                })
            })
            .await
            .unwrap();
        assert_eq!(driver.all("SELECT n FROM t", &[]).await.unwrap().len(), 2);

        let failed: Result<(), StoreError> = driver
            .transaction(|tx| {
                Box::pin(async move {
                    tx.run("INSERT INTO t (n) VALUES (?)", &[SqlValue::from(3i64)])
                        .await?;
                    Err(StoreError::driver("boom"))
                })
            })
            .await;
        assert!(failed.is_err());
        assert_eq!(
            driver.all("SELECT n FROM t", &[]).await.unwrap().len(),
            2,
            "rolled back"
        );
    }
}
