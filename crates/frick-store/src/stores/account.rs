//! Account/identity store (`apps/server/src/storage/account-store.ts`, map 03
//! §9.2, FR-35/FR-39). Owns the `auth_accounts` rows: handle/display-name plus
//! the self-describing password hash. Passwords are hashed through the
//! [`FrickPasswordHasher`] seam ([`crate::stores::password_hasher`]); the store
//! never sees plaintext beyond the hash/verify calls and never exposes the
//! stored hash through [`StoredAccount`].
//!
//! # Determinism seam
//!
//! Like the sibling stores, the store never reads the system clock: `create`
//! takes `now_ms` for the `created_at` stamp. The password hasher owns its own
//! salt seam (CSPRNG in production, fixed in tests) so hashes are reproducible.
//!
//! # Handle uniqueness
//!
//! `auth_accounts` has a `UNIQUE (tenant_id, handle COLLATE NOCASE)` index, so a
//! duplicate handle within a tenant raises a SQLite constraint error; `create`
//! maps any `/constraint/i` message to the exact TS string
//! `"Handle is already taken"`.

use std::sync::Arc;
use std::sync::OnceLock;

use crate::driver::{SqlDriver, SqlRow};
use crate::error::StoreError;
use crate::stores::password_hasher::{
    FrickPasswordHasher, default_password_hasher, to_stored_hash,
};

/// `DUMMY_VERIFY_SECRET` (account-store.ts:38): the plaintext hashed once per
/// process into the constant fake hash used by
/// [`AccountStore::verify_dummy_password`]. Never a real credential.
const DUMMY_VERIFY_SECRET: &str = "frick-constant-work-dummy-verify-secret";

/// `StoredAccount` (account-store.ts:8-14): the public projection of an
/// `auth_accounts` row. Deliberately carries NO password hash/salt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredAccount {
    pub tenant_id: String,
    pub user_id: String,
    pub handle: String,
    pub display_name: String,
    pub created_at: String,
}

/// `CreateAccountInput` (account-store.ts:16-22).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateAccountInput {
    pub tenant_id: String,
    pub user_id: String,
    pub handle: String,
    pub display_name: String,
    pub password: String,
}

/// Outcome of [`AccountStore::move_account`] (`AccountStore.move`,
/// account-store.ts:186-222). `move` is a Rust keyword, hence the method name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoveOutcome {
    /// The row was reassigned (or `from == to`, a no-op still reported moved).
    Moved,
    /// No `(from_tenant_id, user_id)` row existed.
    NotFound,
    /// The target tenant already holds the handle (case-insensitive) or user_id.
    Conflict,
}

/// `AccountStore` (`storage/account-store.ts`): account CRUD + password verify
/// over [`SqlDriver`], with lazy hash migration on successful login.
pub struct AccountStore {
    sql: Arc<SqlDriver>,
    hasher: Box<dyn FrickPasswordHasher>,
    /// Lazily-computed fake hash for constant-work dummy verification
    /// (`#dummyHash`, account-store.ts:43). Computed at most once per process.
    dummy_hash: OnceLock<String>,
}

impl AccountStore {
    /// Build a store with the default argon2 hasher (`createPasswordHasher()`,
    /// account-store.ts:51). Use [`AccountStore::with_hasher`] to inject scrypt
    /// or a deterministic-salt hasher in tests.
    #[must_use]
    pub fn new(sql: Arc<SqlDriver>) -> Self {
        Self::with_hasher(sql, default_password_hasher())
    }

    /// Build a store with an injected hasher (account-store.ts:46-52).
    #[must_use]
    pub fn with_hasher(sql: Arc<SqlDriver>, hasher: Box<dyn FrickPasswordHasher>) -> Self {
        Self {
            sql,
            hasher,
            dummy_hash: OnceLock::new(),
        }
    }

    /// `create` (account-store.ts:54-81). Hash the password (new credentials
    /// store the self-describing hash in `password_hash`, leaving
    /// `password_salt` empty), then INSERT. A `/constraint/i` failure (the
    /// per-tenant handle uniqueness index) maps to the exact TS error string
    /// `"Handle is already taken"`. `now_ms` stamps `created_at`.
    pub async fn create(
        &self,
        input: &CreateAccountInput,
        now_ms: i64,
    ) -> Result<StoredAccount, StoreError> {
        let now = iso_from_epoch_ms(now_ms);
        let password_hash = self
            .hasher
            .hash(&input.password)
            .map_err(|err| StoreError::store(err.to_string()))?;

        let result = self
            .sql
            .run(
                "INSERT INTO auth_accounts
                    (user_id, tenant_id, handle, display_name, password_salt, password_hash, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)",
                &[
                    input.user_id.as_str().into(),
                    input.tenant_id.as_str().into(),
                    input.handle.as_str().into(),
                    input.display_name.as_str().into(),
                    "".into(),
                    password_hash.into(),
                    now.clone().into(),
                ],
            )
            .await;
        if let Err(err) = result {
            if is_constraint_error(&err) {
                return Err(StoreError::store("Handle is already taken"));
            }
            return Err(err);
        }

        Ok(StoredAccount {
            tenant_id: input.tenant_id.clone(),
            user_id: input.user_id.clone(),
            handle: input.handle.clone(),
            display_name: input.display_name.clone(),
            created_at: now,
        })
    }

    /// `list` (account-store.ts:83-92): a tenant's accounts,
    /// `ORDER BY created_at ASC, handle ASC LIMIT ?` (default limit 100).
    pub async fn list(
        &self,
        tenant_id: &str,
        limit: i64,
    ) -> Result<Vec<StoredAccount>, StoreError> {
        let rows = self
            .sql
            .all(
                "SELECT * FROM auth_accounts
                    WHERE tenant_id = ?
                    ORDER BY created_at ASC, handle ASC
                    LIMIT ?",
                &[tenant_id.into(), limit.into()],
            )
            .await?;
        Ok(rows.iter().map(map_account_row).collect())
    }

    /// `readByIdentity` (account-store.ts:94-97): one row whose handle
    /// (case-insensitive) OR `user_id` equals `identity`, scoped to the tenant.
    pub async fn read_by_identity(
        &self,
        tenant_id: &str,
        identity: &str,
    ) -> Result<Option<StoredAccount>, StoreError> {
        let row = self.read_row_by_identity(tenant_id, identity).await?;
        Ok(row.as_ref().map(map_account_row))
    }

    /// `setPassword` (account-store.ts:104-113): replace the password for an
    /// existing account (used by the password-reset flow). New hash, empty
    /// salt. Returns `true` when a row matched.
    pub async fn set_password(
        &self,
        tenant_id: &str,
        user_id: &str,
        new_password: &str,
    ) -> Result<bool, StoreError> {
        let password_hash = self
            .hasher
            .hash(new_password)
            .map_err(|err| StoreError::store(err.to_string()))?;
        let result = self
            .sql
            .run(
                "UPDATE auth_accounts
                    SET password_salt = ?, password_hash = ?
                    WHERE tenant_id = ? AND user_id = ?",
                &[
                    "".into(),
                    password_hash.into(),
                    tenant_id.into(),
                    user_id.into(),
                ],
            )
            .await?;
        Ok(result.changes > 0)
    }

    /// `verifyPassword` (account-store.ts:115-151). Reconstruct the stored
    /// string via [`to_stored_hash`] (legacy rows carry the salt separately;
    /// FR-35 rows carry the whole tagged hash). On a verify miss ⇒ `None`. On
    /// success, if the stored hash is weaker than the active hasher
    /// (`needs_rehash`), transparently re-hash and UPDATE — **failures are
    /// swallowed** so a best-effort upgrade never blocks login. Returns the
    /// account on success.
    pub async fn verify_password(
        &self,
        tenant_id: &str,
        identity: &str,
        password: &str,
    ) -> Result<Option<StoredAccount>, StoreError> {
        let Some(row) = self.read_row_by_identity(tenant_id, identity).await? else {
            // Anti-enumeration constant work (auth-core-2): an unknown account
            // still spends exactly one verify, so this branch costs the same
            // Argon2 op as the wrong-password branch below (one real verify).
            // Without it an unknown email would be measurably cheaper than a
            // wrong password — a timing oracle. The result is discarded; this
            // never authenticates.
            self.verify_dummy_password(password).await;
            return Ok(None);
        };

        let stored = to_stored_hash(
            row.text("password_hash").unwrap_or_default(),
            row.text("password_salt").unwrap_or_default(),
        );
        if !self.hasher.verify(password, &stored) {
            return Ok(None);
        }

        if self.hasher.needs_rehash(&stored) {
            // Best-effort lazy migration: hash + UPDATE, swallowing any failure
            // (the original hash still verifies next time).
            if let Ok(upgraded) = self.hasher.hash(password) {
                let row_tenant = row.text("tenant_id").unwrap_or_default().to_owned();
                let row_user = row.text("user_id").unwrap_or_default().to_owned();
                let _ = self
                    .sql
                    .run(
                        "UPDATE auth_accounts
                            SET password_salt = ?, password_hash = ?
                            WHERE tenant_id = ? AND user_id = ?",
                        &[
                            "".into(),
                            upgraded.into(),
                            row_tenant.into(),
                            row_user.into(),
                        ],
                    )
                    .await;
            }
        }

        Ok(Some(map_account_row(&row)))
    }

    /// `verifyDummyPassword` (account-store.ts:162-172, auth-core-2): a
    /// constant-work fake verify against a fixed dummy hash, computed lazily
    /// once per process with the active hasher's parameters so it tracks the
    /// real verify cost. **Always returns `false`** — the verify result is
    /// discarded; this path exists solely to equalize login timing on the
    /// unknown-/revoked-account branches and never authenticates. A hashing
    /// failure while seeding the dummy hash is swallowed (the path still
    /// returns `false`).
    // `async` with no `await`: the TS `verifyDummyPassword` is async and the
    // facade `await`s it alongside the SQL-backed verify path, so the seam stays
    // async for a uniform call site (same rationale as the driver's async shells).
    #[allow(clippy::unused_async)]
    pub async fn verify_dummy_password(&self, password: &str) -> bool {
        let dummy = self.dummy_hash.get_or_init(|| {
            self.hasher
                .hash(DUMMY_VERIFY_SECRET)
                .unwrap_or_else(|_| String::new())
        });
        // Discard the result — only the spent work matters.
        let _ = self.hasher.verify(password, dummy);
        false
    }

    /// `move` (account-store.ts:186-222, FR-39): reassign a row's `tenant_id`
    /// (only the tenant changes; user_id/handle/display-name/hash are
    /// preserved). [`MoveOutcome::Moved`] when reassigned (or `from == to`, a
    /// no-op), [`MoveOutcome::NotFound`] when no source row exists,
    /// [`MoveOutcome::Conflict`] when the target tenant already holds the handle
    /// (case-insensitive) or user_id — including a constraint race on UPDATE.
    pub async fn move_account(
        &self,
        from_tenant_id: &str,
        user_id: &str,
        to_tenant_id: &str,
    ) -> Result<MoveOutcome, StoreError> {
        let Some(row) = self
            .sql
            .get(
                "SELECT * FROM auth_accounts WHERE tenant_id = ? AND user_id = ? LIMIT 1",
                &[from_tenant_id.into(), user_id.into()],
            )
            .await?
        else {
            return Ok(MoveOutcome::NotFound);
        };
        if from_tenant_id == to_tenant_id {
            return Ok(MoveOutcome::Moved);
        }
        let handle = row.text("handle").unwrap_or_default();
        let clash = self
            .sql
            .get(
                "SELECT * FROM auth_accounts
                    WHERE tenant_id = ? AND (LOWER(handle) = LOWER(?) OR user_id = ?)
                    LIMIT 1",
                &[to_tenant_id.into(), handle.into(), user_id.into()],
            )
            .await?;
        if clash.is_some() {
            return Ok(MoveOutcome::Conflict);
        }
        let result = self
            .sql
            .run(
                "UPDATE auth_accounts SET tenant_id = ? WHERE tenant_id = ? AND user_id = ?",
                &[to_tenant_id.into(), from_tenant_id.into(), user_id.into()],
            )
            .await;
        if let Err(err) = result {
            if is_constraint_error(&err) {
                return Ok(MoveOutcome::Conflict);
            }
            return Err(err);
        }
        Ok(MoveOutcome::Moved)
    }

    /// `delete` (account-store.ts:231-237): remove a `(tenant_id, user_id)` row.
    /// Returns `true` when a row was deleted, `false` when none matched —
    /// idempotent, tenant-scoped (never reaches across tenants).
    pub async fn delete(&self, tenant_id: &str, user_id: &str) -> Result<bool, StoreError> {
        let result = self
            .sql
            .run(
                "DELETE FROM auth_accounts WHERE tenant_id = ? AND user_id = ?",
                &[tenant_id.into(), user_id.into()],
            )
            .await?;
        Ok(result.changes > 0)
    }

    /// `readRowByIdentity` (account-store.ts:239-249): the raw row by handle
    /// (case-insensitive) OR `user_id`, tenant-scoped.
    async fn read_row_by_identity(
        &self,
        tenant_id: &str,
        identity: &str,
    ) -> Result<Option<SqlRow>, StoreError> {
        self.sql
            .get(
                "SELECT * FROM auth_accounts
                    WHERE tenant_id = ? AND (LOWER(handle) = LOWER(?) OR user_id = ?)
                    LIMIT 1",
                &[tenant_id.into(), identity.into(), identity.into()],
            )
            .await
    }
}

/// `fromRow` (account-store.ts:252-260): `SELECT *` row → [`StoredAccount`],
/// dropping the hash/salt columns. Relies on column names, not positions.
fn map_account_row(row: &SqlRow) -> StoredAccount {
    StoredAccount {
        tenant_id: row.text("tenant_id").unwrap_or_default().to_owned(),
        user_id: row.text("user_id").unwrap_or_default().to_owned(),
        handle: row.text("handle").unwrap_or_default().to_owned(),
        display_name: row.text("display_name").unwrap_or_default().to_owned(),
        created_at: row.text("created_at").unwrap_or_default().to_owned(),
    }
}

/// The TS guards on `/constraint/i.test(error.message)` (and `/constraint|UNIQUE/i`
/// for move); rusqlite spells a uniqueness failure
/// "UNIQUE constraint failed: …", so a case-insensitive substring match on
/// "constraint" covers both TS regexes.
fn is_constraint_error(err: &StoreError) -> bool {
    err.to_string().to_lowercase().contains("constraint")
}

/// ISO-8601 UTC millisecond timestamp from epoch ms
/// (`new Date(now_ms).toISOString()`), e.g. `2023-11-14T22:13:20.123Z`. The
/// determinism seam: callers pass `now_ms`, never the wall clock. Local to this
/// module to avoid a cross-store dependency.
fn iso_from_epoch_ms(now_ms: i64) -> String {
    // Days/time decomposition (proleptic Gregorian, matching JS Date).
    let total_ms = now_ms;
    let ms = total_ms.rem_euclid(1000);
    let total_secs = total_ms.div_euclid(1000);
    let secs_of_day = total_secs.rem_euclid(86_400);
    let days = total_secs.div_euclid(86_400);

    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{ms:03}Z")
}

/// Convert a count of days since the Unix epoch to a `(year, month, day)`
/// proleptic-Gregorian date (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    // `day` is in 1..=31 and `month` in 1..=12, so both fit a u32 without loss;
    // compute them as i64 then narrow via the infallible-by-construction cast.
    let day_i64 = doy - (153 * mp + 2) / 5 + 1;
    let month_i64 = if mp < 10 { mp + 3 } else { mp - 9 };
    let day = u32::try_from(day_i64).unwrap_or(1);
    let month = u32::try_from(month_i64).unwrap_or(1);
    let year = if month <= 2 { year + 1 } else { year };
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stores::password_hasher::{
        Argon2PasswordHasher, FixedSaltSource, ScryptPasswordHasher,
    };

    // ── Test schema bootstrap ────────────────────────────────────────────────
    // The effective post-all-migrations `auth_accounts` table (map 03 §5).
    // `handle` is `COLLATE NOCASE`; the per-tenant uniqueness index enforces the
    // "Handle is already taken" path. `tenant_id`/`app_id` are additive columns.

    const SCHEMA: &str = "
        CREATE TABLE auth_accounts (
          user_id TEXT PRIMARY KEY,
          handle TEXT NOT NULL COLLATE NOCASE,
          display_name TEXT NOT NULL,
          password_salt TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT '_default',
          app_id TEXT NOT NULL DEFAULT '_default'
        );
        CREATE UNIQUE INDEX idx_auth_accounts_tenant_handle
          ON auth_accounts (tenant_id, handle COLLATE NOCASE);";

    const NOW: i64 = 1_700_000_000_123;

    async fn driver() -> Arc<SqlDriver> {
        let sql = Arc::new(SqlDriver::open_sqlite(":memory:").unwrap());
        sql.exec(SCHEMA).await.unwrap();
        sql
    }

    /// A store whose hasher uses a deterministic salt seam — keeps argon2 hashes
    /// reproducible and fast to reason about while still real Argon2id.
    fn argon2_store(sql: Arc<SqlDriver>) -> AccountStore {
        AccountStore::with_hasher(
            sql,
            Box::new(Argon2PasswordHasher::new(FixedSaltSource::new([
                0x07, 0x09,
            ]))),
        )
    }

    fn scrypt_store(sql: Arc<SqlDriver>) -> AccountStore {
        AccountStore::with_hasher(
            sql,
            Box::new(ScryptPasswordHasher::new(FixedSaltSource::new([0x42]))),
        )
    }

    fn input(tenant: &str, user: &str, handle: &str, password: &str) -> CreateAccountInput {
        CreateAccountInput {
            tenant_id: tenant.to_owned(),
            user_id: user.to_owned(),
            handle: handle.to_owned(),
            display_name: handle.to_owned(),
            password: password.to_owned(),
        }
    }

    // ── create / readByIdentity / verifyPassword / setPassword / delete ──────
    // Port of pg-identity.test.ts "AccountStore create / readByIdentity / …".

    #[tokio::test]
    async fn create_read_verify_set_delete_round_trip() {
        let store = argon2_store(driver().await);
        let created = store
            .create(&input("_default", "user-ada", "ada", "hunter2"), NOW)
            .await
            .unwrap();
        assert_eq!(created.user_id, "user-ada");
        assert_eq!(created.created_at, "2023-11-14T22:13:20.123Z");

        // readByIdentity by handle (case-insensitive) and by user_id.
        assert_eq!(
            store
                .read_by_identity("_default", "ada")
                .await
                .unwrap()
                .unwrap()
                .display_name,
            "ada"
        );
        assert!(
            store
                .read_by_identity("_default", "ADA")
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            store
                .read_by_identity("_default", "user-ada")
                .await
                .unwrap()
                .is_some()
        );

        // verifyPassword: correct ⇒ account, wrong ⇒ None.
        assert!(
            store
                .verify_password("_default", "ada", "hunter2")
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            store
                .verify_password("_default", "ada", "wrong")
                .await
                .unwrap()
                .is_none()
        );

        // setPassword updates the credential.
        assert!(
            store
                .set_password("_default", "user-ada", "newpass")
                .await
                .unwrap()
        );
        assert!(
            store
                .verify_password("_default", "ada", "newpass")
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            store
                .verify_password("_default", "ada", "hunter2")
                .await
                .unwrap()
                .is_none()
        );

        // delete is idempotent.
        assert!(store.delete("_default", "user-ada").await.unwrap());
        assert!(!store.delete("_default", "user-ada").await.unwrap());
        assert!(
            store
                .read_by_identity("_default", "ada")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn duplicate_handle_is_already_taken() {
        let store = argon2_store(driver().await);
        store
            .create(&input("_default", "u1", "ada", "pw1"), NOW)
            .await
            .unwrap();
        // Same handle (different case) in the same tenant ⇒ constraint ⇒ the
        // exact TS error string.
        let err = store
            .create(&input("_default", "u2", "ADA", "pw2"), NOW)
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "Handle is already taken");

        // A different tenant may reuse the handle.
        store
            .create(&input("other", "u3", "ada", "pw3"), NOW)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn verify_password_returns_none_for_unknown_account() {
        let store = argon2_store(driver().await);
        assert!(
            store
                .verify_password("_default", "ghost", "whatever")
                .await
                .unwrap()
                .is_none()
        );
    }

    // ── list ordering ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn list_orders_created_at_asc_then_handle_asc_and_tenant_scopes() {
        let store = argon2_store(driver().await);
        store
            .create(&input("_default", "u-b", "bob", "pw"), NOW + 1_000)
            .await
            .unwrap();
        // Two share a created_at ⇒ tie broken by handle ASC.
        store
            .create(&input("_default", "u-z", "zed", "pw"), NOW)
            .await
            .unwrap();
        store
            .create(&input("_default", "u-a", "amy", "pw"), NOW)
            .await
            .unwrap();
        // A different tenant is excluded.
        store
            .create(&input("other", "u-o", "otto", "pw"), NOW)
            .await
            .unwrap();

        let handles: Vec<String> = store
            .list("_default", 100)
            .await
            .unwrap()
            .into_iter()
            .map(|a| a.handle)
            .collect();
        assert_eq!(handles, ["amy", "zed", "bob"]);

        // limit is honored.
        assert_eq!(store.list("_default", 2).await.unwrap().len(), 2);
    }

    // ── lazy migration (port of password-hasher.test.ts AccountStore section) ─

    #[tokio::test]
    async fn rehashes_legacy_scrypt_to_argon2_on_login() {
        let sql = driver().await;
        let store = argon2_store(sql.clone());
        // Seed a legacy two-column row: untagged digest + separate salt.
        let salt = "legacysaltvalue";
        let digest = legacy_scrypt_digest("supersecret", salt);
        sql.run(
            "INSERT INTO auth_accounts
                (user_id, tenant_id, handle, display_name, password_salt, password_hash, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)",
            &[
                "u1".into(),
                "_default".into(),
                "ada".into(),
                "Ada".into(),
                salt.into(),
                digest.into(),
                iso_from_epoch_ms(NOW).into(),
            ],
        )
        .await
        .unwrap();

        // Login succeeds against the legacy hash.
        assert!(
            store
                .verify_password("_default", "ada", "supersecret")
                .await
                .unwrap()
                .is_some()
        );

        // The row was transparently upgraded to a tagged argon2 hash, empty salt.
        let row = sql
            .get(
                "SELECT password_hash, password_salt FROM auth_accounts WHERE user_id = ?",
                &["u1".into()],
            )
            .await
            .unwrap()
            .unwrap();
        assert!(row.text("password_hash").unwrap().starts_with("argon2$"));
        assert_eq!(row.text("password_salt").unwrap(), "");

        // And the upgraded credential still verifies; a wrong password fails.
        assert!(
            store
                .verify_password("_default", "ada", "supersecret")
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            store
                .verify_password("_default", "ada", "wrong")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn does_not_rewrite_when_hash_already_matches_active_hasher() {
        let sql = driver().await;
        let store = argon2_store(sql.clone());
        store
            .create(&input("_default", "u2", "grace", "topsecret"), NOW)
            .await
            .unwrap();
        let before = sql
            .get(
                "SELECT password_hash FROM auth_accounts WHERE user_id = ?",
                &["u2".into()],
            )
            .await
            .unwrap()
            .unwrap()
            .text("password_hash")
            .unwrap()
            .to_owned();
        assert!(
            store
                .verify_password("_default", "grace", "topsecret")
                .await
                .unwrap()
                .is_some()
        );
        let after = sql
            .get(
                "SELECT password_hash FROM auth_accounts WHERE user_id = ?",
                &["u2".into()],
            )
            .await
            .unwrap()
            .unwrap()
            .text("password_hash")
            .unwrap()
            .to_owned();
        assert_eq!(after, before, "no rewrite when the hash already matches");
    }

    #[tokio::test]
    async fn scrypt_store_rehashes_legacy_to_tagged_scrypt() {
        let sql = driver().await;
        let store = scrypt_store(sql.clone());
        let salt = "anotherlegacysalt";
        let digest = legacy_scrypt_digest("pw123456", salt);
        sql.run(
            "INSERT INTO auth_accounts
                (user_id, tenant_id, handle, display_name, password_salt, password_hash, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)",
            &[
                "u3".into(),
                "_default".into(),
                "linus".into(),
                "Linus".into(),
                salt.into(),
                digest.into(),
                iso_from_epoch_ms(NOW).into(),
            ],
        )
        .await
        .unwrap();
        assert!(
            store
                .verify_password("_default", "linus", "pw123456")
                .await
                .unwrap()
                .is_some()
        );
        let row = sql
            .get(
                "SELECT password_hash FROM auth_accounts WHERE user_id = ?",
                &["u3".into()],
            )
            .await
            .unwrap()
            .unwrap();
        assert!(row.text("password_hash").unwrap().starts_with("scrypt$"));
    }

    // ── verifyDummyPassword ──────────────────────────────────────────────────

    #[tokio::test]
    async fn verify_dummy_password_always_false() {
        let store = argon2_store(driver().await);
        assert!(!store.verify_dummy_password("anything").await);
        // Second call reuses the cached dummy hash and still returns false.
        assert!(!store.verify_dummy_password("anything").await);
        assert!(!store.verify_dummy_password(DUMMY_VERIFY_SECRET).await);
    }

    // ── move (FR-39) ─────────────────────────────────────────────────────────

    #[tokio::test]
    async fn move_reassigns_tenant() {
        let store = argon2_store(driver().await);
        store
            .create(&input("tenant-old", "u-ada", "ada", "pw"), NOW)
            .await
            .unwrap();

        assert_eq!(
            store
                .move_account("tenant-old", "u-ada", "tenant-new")
                .await
                .unwrap(),
            MoveOutcome::Moved
        );
        assert!(
            store
                .read_by_identity("tenant-new", "u-ada")
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            store
                .read_by_identity("tenant-old", "u-ada")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn move_same_tenant_is_noop_moved() {
        let store = argon2_store(driver().await);
        store
            .create(&input("t", "u", "h", "pw"), NOW)
            .await
            .unwrap();
        assert_eq!(
            store.move_account("t", "u", "t").await.unwrap(),
            MoveOutcome::Moved
        );
        assert!(store.read_by_identity("t", "u").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn move_unknown_account_is_not_found() {
        let store = argon2_store(driver().await);
        assert_eq!(
            store
                .move_account("tenant-old", "u-nobody", "tenant-new")
                .await
                .unwrap(),
            MoveOutcome::NotFound
        );
    }

    #[tokio::test]
    async fn move_conflicting_handle_is_conflict_and_leaves_source() {
        let store = argon2_store(driver().await);
        store
            .create(&input("tenant-old", "u-ada", "ada", "pw"), NOW)
            .await
            .unwrap();
        // The target tenant already owns the same handle (different case).
        store
            .create(&input("tenant-new", "u-other", "ADA", "pw"), NOW)
            .await
            .unwrap();

        assert_eq!(
            store
                .move_account("tenant-old", "u-ada", "tenant-new")
                .await
                .unwrap(),
            MoveOutcome::Conflict
        );
        // The source account is untouched.
        assert!(
            store
                .read_by_identity("tenant-old", "u-ada")
                .await
                .unwrap()
                .is_some()
        );
    }

    // NOTE: the `OR user_id = ?` arm of the move clash check
    // (account-store.ts:203) can't be exercised in isolation here because
    // `user_id` is the table PRIMARY KEY — two rows can never share a user_id
    // across tenants in the first place, so seeding such a fixture fails at
    // INSERT. The TS suite likewise only covers the handle-conflict path
    // (admin-account-move.test.ts). The arm is still ported verbatim for
    // fidelity and a defensive belt against any future PK change.

    // ── iso_from_epoch_ms parity ─────────────────────────────────────────────

    #[test]
    fn iso_from_epoch_ms_matches_js_date() {
        assert_eq!(iso_from_epoch_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_epoch_ms(NOW), "2023-11-14T22:13:20.123Z");
        // A leap-day boundary.
        assert_eq!(
            iso_from_epoch_ms(1_582_934_400_000),
            "2020-02-29T00:00:00.000Z"
        );
    }

    /// Compute a bug-compatible legacy digest the way the pre-FR-35 code did:
    /// `scryptSync(password, saltString, 32)` (salt is the UTF-8 string, Node
    /// defaults N=16384,r=8,p=1), base64url-encoded.
    fn legacy_scrypt_digest(password: &str, salt: &str) -> String {
        use base64::Engine;
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use scrypt::{Params, scrypt};
        let params = Params::new(14, 8, 1, 32).unwrap();
        let mut digest = vec![0u8; 32];
        scrypt(password.as_bytes(), salt.as_bytes(), &params, &mut digest).unwrap();
        URL_SAFE_NO_PAD.encode(&digest)
    }
}
