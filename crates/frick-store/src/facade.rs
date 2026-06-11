//! The `FrickStore` facade (FR-243), ported from `apps/server/src/store.ts`
//! (map 03 §7). It is the integration keystone that wires the already-finished
//! store modules into one durable surface: it owns the [`SqlDriver`], the
//! validated [`FrickSchema`], the shared idempotency front-cache, and the
//! `Arc`-owning sub-stores, and it constructs the lifetime-borrowing data-plane
//! stores (objects / streams / presence / signals / jobs) on demand from those.
//!
//! Construction order, the write-notification funnel, prune semantics, schema
//! identity recording, the tenant/app-scoped facades, and `for_app` all mirror
//! the TS class exactly (§7.1–§7.7). The clock and id/token generation enter
//! here via the [`seam`] traits (§7 "Determinism"), so the data-plane stores
//! stay pure.
//!
//! ## Scope (this story)
//!
//! Projections (FR-244), search (FR-245), and the devtools / platform-events /
//! analytics sub-stores and per-app registries (FR-249) are later stories: this
//! facade leaves documented no-op extension points where the TS fires those, so
//! the write funnel's shape is preserved. The Postgres arm (FR-242) is not
//! implemented. Everything else from §7 is here.

pub mod seam;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use frick_protocol::schema::{FrickObjectMergePolicy, resolve_object_merge_policy};
use frick_protocol::{FrickSchema, Value, foundation_schema, validate_schema};
use serde_json::{Map, Value as JsonValue};

use crate::driver::{SqlDialect, SqlDriver};
use crate::error::StoreError;
use crate::migrations::{self, AppliedMigrationRow};
use crate::packed::encode_packed;
use crate::stores::account::AccountStore;
use crate::stores::admin_audit::AdminAuditStore;
use crate::stores::blob::BlobStore;
use crate::stores::blob_bytes::{BlobBytesDriver, FrickBlobDriver, create_blob_bytes_driver};
use crate::stores::grant::GrantStore;
use crate::stores::idempotency::BoundedIdempotencyCache;
use crate::stores::invitation::InvitationStore;
use crate::stores::job::{EnqueueInput, JobStore, StoredJob};
use crate::stores::object::{ObjectStore, ObjectUpsertResult};
use crate::stores::password_reset::PasswordResetTokenStore;
use crate::stores::presence::PresenceStore;
use crate::stores::push_registration::PushRegistrationStore;
use crate::stores::refresh_token::RefreshTokenStore;
use crate::stores::saml_assertion::SamlAssertionStore;
use crate::stores::search::{
    self, SEARCH_ADAPTER_ID, SearchFilterValue, SearchOp, SearchQueryResult,
};
use crate::stores::service_principal::ServicePrincipalStore;
use crate::stores::session::SessionStore;
use crate::stores::signal::SignalStore;
use crate::stores::stream::{AppendResult, CachedIdempotentEvent, StoredEvent, StreamStore};
use crate::stores::tenant::{TenantSettingsStore, TenantStore};

use self::seam::{Clock, IdGen, OsIdGen, SystemClock};

/// `_default` app partition (`app-id.ts`). Re-exported from the data-plane
/// stores' shared constant so the facade and the stores agree byte-for-byte.
pub use crate::stores::blob_bytes::DEFAULT_APP_ID;

/// `_default` tenant (`tenant.ts` `DEFAULT_TENANT_ID`). The no-tenant facade
/// overloads target this tenant.
pub const DEFAULT_TENANT_ID: &str = "_default";

// ---- §7.1 constants / defaults ----------------------------------------------

/// Default capacity of the in-process idempotency front-cache. Capacity-evicted
/// entries fall through to the durable `idempotency_keys` table, so this is a
/// hot-path optimisation, never a correctness boundary.
pub const DEFAULT_IDEMPOTENCY_CACHE_CAPACITY: usize = 10_000;
/// Default retention window for durable idempotency records: 24 hours.
pub const DEFAULT_IDEMPOTENCY_KEY_RETENTION_MS: i64 = 24 * 60 * 60 * 1000;
/// Default hard cap on `idempotency_keys` rows, independent of age.
pub const DEFAULT_IDEMPOTENCY_KEY_MAX_ROWS: i64 = 100_000;
/// Default interval between background idempotency prune passes: 15 minutes.
pub const DEFAULT_IDEMPOTENCY_KEY_PRUNE_INTERVAL_MS: i64 = 15 * 60 * 1000;
/// Default replay window for `requestId` idempotency: 24 hours (lookup-time
/// bound, independent of pruning).
pub const DEFAULT_IDEMPOTENCY_REPLAY_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;
/// Default interval between background expired-session prune passes: 15 minutes.
pub const DEFAULT_EXPIRED_SESSION_PRUNE_INTERVAL_MS: i64 = 15 * 60 * 1000;
/// Default grace kept before an expired `auth_sessions` row is pruned: 0.
pub const DEFAULT_EXPIRED_SESSION_RETENTION_GRACE_MS: i64 = 0;
/// Default cadence for the opt-in per-stream retention sweep: 15 minutes.
pub const DEFAULT_STREAM_RETENTION_PRUNE_INTERVAL_MS: i64 = 15 * 60 * 1000;
/// Default TTL for an enqueued signal when the caller omits one: 30 s.
pub const DEFAULT_SIGNAL_TTL_MS: i64 = 30_000;
/// Default filesystem blob storage path (`config.ts:253`,
/// `FRICK_BLOB_STORAGE_PATH`). Only consulted by the `filesystem` driver.
pub const DEFAULT_BLOB_STORAGE_PATH: &str = "./frick-blobs/";

/// Storage driver selector (`StoreOptions.dbDriver`). Only [`Sqlite`] is wired
/// in this story; [`Postgres`] is reserved for FR-242.
///
/// [`Sqlite`]: StoreDriverKind::Sqlite
/// [`Postgres`]: StoreDriverKind::Postgres
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StoreDriverKind {
    /// SQLite (the default).
    #[default]
    Sqlite,
    /// Postgres — not implemented in this story (FR-242).
    Postgres,
}

/// Construction options for [`FrickStore`] (TS `StoreOptions`, §7.1 defaults).
/// Only the fields meaningful to this story are present; the projection /
/// search / per-app-registry knobs are deferred (FR-244/FR-245/FR-249).
pub struct FrickStoreOptions {
    /// SQLite database path, or `":memory:"`.
    pub path: String,
    /// Storage driver. Defaults to [`StoreDriverKind::Sqlite`].
    pub db_driver: StoreDriverKind,
    /// Postgres connection string (`FRICK_DATABASE_URL`). Required when
    /// `db_driver == Postgres`; ignored otherwise (FR-242).
    pub database_url: Option<String>,
    /// Blob *bytes* driver selector (`FRICK_BLOB_DRIVER`, map 05 §3.3).
    /// Defaults to [`FrickBlobDriver::Sqlite`] (bytes in `blob_content`).
    pub blob_driver: FrickBlobDriver,
    /// Filesystem/S3 blob storage path (`FRICK_BLOB_STORAGE_PATH`). Only the
    /// `filesystem` driver requires it; `None` ⇒ [`DEFAULT_BLOB_STORAGE_PATH`].
    pub blob_storage_path: Option<String>,
    /// Schema to validate and record. `None` ⇒ [`foundation_schema`].
    pub schema: Option<FrickSchema>,
    /// Accepted and ignored (parity with TS `void options.seed`).
    pub seed: bool,
    /// Idempotency front-cache capacity. `None` ⇒
    /// [`DEFAULT_IDEMPOTENCY_CACHE_CAPACITY`].
    pub idempotency_cache_capacity: Option<usize>,
    /// Durable idempotency retention window (ms). `None` ⇒
    /// [`DEFAULT_IDEMPOTENCY_KEY_RETENTION_MS`].
    pub idempotency_key_retention_ms: Option<i64>,
    /// Hard cap on `idempotency_keys` rows. `None` ⇒
    /// [`DEFAULT_IDEMPOTENCY_KEY_MAX_ROWS`].
    pub idempotency_key_max_rows: Option<i64>,
    /// Background idempotency prune interval (ms); `Some(0)` disables the timer
    /// (the one-shot prune at construction still runs). `None` ⇒
    /// [`DEFAULT_IDEMPOTENCY_KEY_PRUNE_INTERVAL_MS`].
    pub idempotency_key_prune_interval_ms: Option<i64>,
    /// Lookup-time replay window (ms). `None` ⇒
    /// [`DEFAULT_IDEMPOTENCY_REPLAY_WINDOW_MS`].
    pub idempotency_replay_window_ms: Option<i64>,
    /// Grace kept before an expired session row is pruned. `None` ⇒
    /// [`DEFAULT_EXPIRED_SESSION_RETENTION_GRACE_MS`].
    pub expired_session_retention_grace_ms: Option<i64>,
    /// Background expired-session prune interval (ms); `Some(0)` disables the
    /// timer. `None` ⇒ [`DEFAULT_EXPIRED_SESSION_PRUNE_INTERVAL_MS`].
    pub expired_session_prune_interval_ms: Option<i64>,
    /// Background stream-retention prune interval (ms). `None` ⇒
    /// [`DEFAULT_STREAM_RETENTION_PRUNE_INTERVAL_MS`]. Only armed when
    /// `stream_retention` declares at least one policy (FR-145, deferred until
    /// the retention-policy option lands).
    pub stream_retention_prune_interval_ms: Option<i64>,
}

impl Default for FrickStoreOptions {
    fn default() -> Self {
        Self {
            path: ":memory:".to_string(),
            db_driver: StoreDriverKind::Sqlite,
            database_url: None,
            blob_driver: FrickBlobDriver::Sqlite,
            blob_storage_path: None,
            schema: None,
            seed: false,
            idempotency_cache_capacity: None,
            idempotency_key_retention_ms: None,
            idempotency_key_max_rows: None,
            idempotency_key_prune_interval_ms: None,
            idempotency_replay_window_ms: None,
            expired_session_retention_grace_ms: None,
            expired_session_prune_interval_ms: None,
            stream_retention_prune_interval_ms: None,
        }
    }
}

impl FrickStoreOptions {
    /// Convenience constructor for an in-memory store with all defaults.
    #[must_use]
    pub fn memory() -> Self {
        Self::default()
    }
}

// ---- §7.3 write-notification funnel ------------------------------------------

/// Change notification emitted on every successful object upsert / delete and
/// stream append, regardless of which caller drove the write (TS
/// `FrickStoreWriteEvent`, §7.3). The store is the ONLY emission point (FR-114);
/// a single consumer (the sync gateway) registers via
/// [`FrickStore::set_write_listener`] and owns the fan-out.
#[derive(Debug, Clone, PartialEq)]
pub enum FrickStoreWriteEvent {
    /// A row was written through the object facade. Carries the stored
    /// (post-merge) object state including its `id` field.
    ObjectUpsert {
        tenant_id: String,
        /// Storage app id of the write (FR-153); `_default` for single-app.
        app_id: String,
        object_type: String,
        object_id: String,
        object: Value,
    },
    /// A row was removed. Fired only when a row actually existed (§7.3).
    ObjectDelete {
        tenant_id: String,
        app_id: String,
        object_type: String,
        object_id: String,
    },
    /// An event was appended. Fired only when `created == true` (§7.3).
    StreamAppend {
        tenant_id: String,
        /// The freshly-appended, persisted event.
        event: StoredEvent,
    },
}

/// Consumer of [`FrickStoreWriteEvent`]s — the sync gateway. A boxed `Fn` so the
/// facade holds a single listener behind a mutex, matching the TS single-slot
/// `#writeListener`.
pub type FrickStoreWriteListener = Box<dyn Fn(&FrickStoreWriteEvent) + Send + Sync>;

/// The search projector (FR-245, map 03 §13): maps one store-write event to the
/// [`SearchOp`]s the registered indexes want applied. The server installs this
/// via [`FrickStore::set_search_projector`]; the store applies the returned ops
/// through its own search SQL so it stays the sole owner of its writes (the
/// projector must NOT call back into the store). A boxed `Fn` behind a mutex,
/// the same single-slot shape as [`FrickStoreWriteListener`].
pub type FrickStoreSearchProjector =
    Box<dyn Fn(&FrickStoreWriteEvent) -> Vec<SearchOp> + Send + Sync>;

/// Result of [`FrickStore::prune`] (TS `PruneResult`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PruneResult {
    /// Rows removed because their `created_at` was older than the retention
    /// window (global or per-tenant override).
    pub pruned_by_age: u64,
    /// Rows removed to bring the table down to `maxRows` after the age sweep.
    pub pruned_by_cap: u64,
}

/// The integration keystone (TS `FrickStore`). Owns the driver, schema, shared
/// idempotency cache, and the `Arc`-owning sub-stores; constructs the
/// lifetime-borrowing data-plane stores on demand.
pub struct FrickStore {
    /// The validated schema (TS `readonly schema`).
    schema: FrickSchema,
    /// The shared async storage driver. `Arc` so the `Arc`-owning sub-stores
    /// and the data-plane borrow-views share one connection.
    driver: Arc<SqlDriver>,

    // Arc-owning sub-stores (one shared connection, cheap to hold as fields).
    accounts: AccountStore,
    sessions: SessionStore,
    password_reset_tokens: PasswordResetTokenStore,
    refresh_tokens: RefreshTokenStore,
    saml_assertions: SamlAssertionStore,
    service_principals: ServicePrincipalStore,
    blobs: BlobStore,
    /// The configured blob *bytes* driver (map 05 §3.3): the byte half of the
    /// blob surface, behind the metadata store's `blob_metadata` rows. Built
    /// from [`FrickStoreOptions::blob_driver`] in [`open_with_seams`]. Bytes
    /// flow through [`write_content`](Self::write_content) /
    /// [`read_content`](Self::read_content); metadata stays on [`blobs`].
    ///
    /// [`blobs`]: Self::blobs
    blob_bytes: BlobBytesDriver,
    tenants: TenantStore,
    tenant_settings: TenantSettingsStore,
    invitations: InvitationStore,
    grants: GrantStore,
    admin_audit: AdminAuditStore,
    push_registrations: PushRegistrationStore,

    /// The in-process idempotency front-cache, shared with the data-plane
    /// [`StreamStore`] view that the facade builds on every append. Behind a
    /// mutex because `StreamStore::append` needs `&mut` and `prune` swaps in a
    /// fresh cache (§7.4, "rebuild the cache"). Wrapped in `Option` so an append
    /// can `take` it out of the std mutex, run the (async) append against the
    /// owned cache, then put it back — never holding the lock across an `.await`
    /// (the SQLite arm is single-writer, so no append observes the gap).
    idempotency_cache: Mutex<Option<BoundedIdempotencyCache<CachedIdempotentEvent>>>,

    // Idempotency knobs (§7.1).
    idempotency_cache_capacity: usize,
    idempotency_key_retention_ms: i64,
    idempotency_key_max_rows: i64,
    idempotency_replay_window_ms: i64,
    expired_session_grace_ms: i64,

    /// Determinism seams (§7). Production wires [`SystemClock`] / [`OsIdGen`];
    /// tests inject fixed/seeded variants.
    clock: Box<dyn Clock>,
    id_gen: Box<dyn IdGen>,

    /// Single optional store-write consumer (the sync gateway), set via
    /// [`set_write_listener`](Self::set_write_listener). Behind a mutex so the
    /// gateway can attach/detach at runtime.
    write_listener: Mutex<Option<FrickStoreWriteListener>>,

    /// Single optional search projector (FR-245), set via
    /// [`set_search_projector`](Self::set_search_projector). Invoked after every
    /// successful object/stream write to derive the [`SearchOp`]s the store then
    /// applies to its own indexes. Behind a mutex so the server can
    /// attach/detach at runtime.
    search_projector: Mutex<Option<FrickStoreSearchProjector>>,
}

impl FrickStore {
    /// Construct a store with production seams ([`SystemClock`] + [`OsIdGen`]).
    /// See [`open_with_seams`](Self::open_with_seams) for the deterministic-test
    /// entry point.
    pub async fn open(options: FrickStoreOptions) -> Result<Self, StoreError> {
        Self::open_with_seams(options, Box::new(SystemClock), Box::new(OsIdGen)).await
    }

    /// Construct a store with explicit determinism seams. Construction order
    /// mirrors TS §7.2: validate schema → open driver → initialize storage
    /// (pragmas via `open_sqlite`) + run framework migrations → record schema
    /// identity → build the shared idempotency cache → instantiate every
    /// sub-store → run the one-shot maintenance prunes. Recurring maintenance
    /// timers are opt-in via [`start_maintenance`](Self::start_maintenance), so
    /// tests never spawn timers.
    pub async fn open_with_seams(
        options: FrickStoreOptions,
        clock: Box<dyn Clock>,
        id_gen: Box<dyn IdGen>,
    ) -> Result<Self, StoreError> {
        // 1. Validate the schema (TS `validateSchema`).
        let schema = options.schema.unwrap_or_else(foundation_schema);
        validate_schema(&schema).map_err(|err| StoreError::store(err.message()))?;

        // 2. Open the driver and 3. run the framework migrations. The SQLite
        // arm sets pragmas at open time then runs the SQLite migration list;
        // the Postgres arm (FR-242) connects a pool then runs the dialect-
        // translated PG migration list. Both share the ledger/checksum
        // semantics in `migrations`.
        let driver = match options.db_driver {
            StoreDriverKind::Sqlite => {
                let driver = Arc::new(SqlDriver::open_sqlite(&options.path)?);
                migrations::run_framework_migrations(
                    &driver,
                    schema.schema_revision,
                    migrations::MigrationRunnerOptions::default(),
                )
                .await?;
                driver
            }
            StoreDriverKind::Postgres => {
                let url = options.database_url.as_deref().ok_or_else(|| {
                    StoreError::store(
                        "FRICK_DB_DRIVER=postgres requires FRICK_DATABASE_URL (the Postgres connection string).".to_string(),
                    )
                })?;
                let driver = Arc::new(SqlDriver::open_postgres(url)?);
                migrations::run_framework_migrations_postgres(
                    &driver,
                    schema.schema_revision,
                    migrations::MigrationRunnerOptions::default(),
                )
                .await?;
                driver
            }
        };

        // `options.seed` is accepted and ignored (TS `void options.seed`).
        let _ = options.seed;

        // 4. Resolve the §7.1 knobs.
        let idempotency_cache_capacity = options
            .idempotency_cache_capacity
            .unwrap_or(DEFAULT_IDEMPOTENCY_CACHE_CAPACITY);
        let idempotency_key_retention_ms = options
            .idempotency_key_retention_ms
            .unwrap_or(DEFAULT_IDEMPOTENCY_KEY_RETENTION_MS);
        let idempotency_key_max_rows = options
            .idempotency_key_max_rows
            .unwrap_or(DEFAULT_IDEMPOTENCY_KEY_MAX_ROWS);
        let idempotency_replay_window_ms = options
            .idempotency_replay_window_ms
            .unwrap_or(DEFAULT_IDEMPOTENCY_REPLAY_WINDOW_MS);
        let expired_session_grace_ms = options
            .expired_session_retention_grace_ms
            .unwrap_or(DEFAULT_EXPIRED_SESSION_RETENTION_GRACE_MS);

        // 5. Build the shared idempotency front-cache.
        #[allow(clippy::cast_precision_loss)]
        let idempotency_cache = BoundedIdempotencyCache::new(idempotency_cache_capacity as f64)?;

        // 5b. Build the configured blob-bytes driver (map 05 §3.3). The
        // filesystem arm validates its root (creatable, writable dir) here, so
        // a misconfigured `filesystem` driver fails fast at construction — the
        // sqlite arm clones the shared `SqlDriver` Arc. The S3 arm selects the
        // stub seam (FR-241 follow-up).
        let blob_storage_path = options
            .blob_storage_path
            .as_deref()
            .filter(|path| !path.is_empty())
            .unwrap_or(DEFAULT_BLOB_STORAGE_PATH);
        let blob_bytes =
            create_blob_bytes_driver(options.blob_driver, &driver, Some(blob_storage_path))?;

        // 6. Instantiate every Arc-owning sub-store. The data-plane stores
        // (objects / streams / presence / signals / jobs) are lifetime-borrowing
        // zero-cost views built on demand from `&self.driver` / `&self.schema`.
        let store = Self {
            schema,
            accounts: AccountStore::new(Arc::clone(&driver)),
            sessions: SessionStore::new(Arc::clone(&driver)),
            password_reset_tokens: PasswordResetTokenStore::new(Arc::clone(&driver)),
            refresh_tokens: RefreshTokenStore::new(Arc::clone(&driver)),
            saml_assertions: SamlAssertionStore::new(Arc::clone(&driver)),
            service_principals: ServicePrincipalStore::new(Arc::clone(&driver)),
            blobs: BlobStore::new(Arc::clone(&driver)),
            blob_bytes,
            tenants: TenantStore::new(Arc::clone(&driver)),
            tenant_settings: TenantSettingsStore::new(Arc::clone(&driver)),
            invitations: InvitationStore::new(Arc::clone(&driver)),
            grants: GrantStore::new(Arc::clone(&driver)),
            admin_audit: AdminAuditStore::new(Arc::clone(&driver)),
            push_registrations: PushRegistrationStore::new(Arc::clone(&driver)),
            driver,
            idempotency_cache: Mutex::new(Some(idempotency_cache)),
            idempotency_cache_capacity,
            idempotency_key_retention_ms,
            idempotency_key_max_rows,
            idempotency_replay_window_ms,
            expired_session_grace_ms,
            clock,
            id_gen,
            write_listener: Mutex::new(None),
            search_projector: Mutex::new(None),
        };

        // 7. Record the schema identity (§7.5). The TS constructor does this
        // before instantiating sub-stores, but the row write only needs the
        // driver + schema, so ordering here is observationally identical.
        store.record_schema().await?;

        // 8. One-shot maintenance prunes (mop up after a crashed previous run),
        // matching the TS constructor. The recurring timers are opt-in.
        store.safe_prune().await;
        store.safe_expired_session_prune().await;

        Ok(store)
    }

    /// The validated schema.
    #[must_use]
    pub fn schema(&self) -> &FrickSchema {
        &self.schema
    }

    // ---- Arc-owning sub-store accessors ----------------------------------

    /// Account store (auth identities).
    #[must_use]
    pub fn accounts(&self) -> &AccountStore {
        &self.accounts
    }
    /// Session store.
    #[must_use]
    pub fn sessions(&self) -> &SessionStore {
        &self.sessions
    }
    /// Password-reset token store.
    #[must_use]
    pub fn password_reset_tokens(&self) -> &PasswordResetTokenStore {
        &self.password_reset_tokens
    }
    /// Refresh-token store.
    #[must_use]
    pub fn refresh_tokens(&self) -> &RefreshTokenStore {
        &self.refresh_tokens
    }
    /// SAML seen-assertion store.
    #[must_use]
    pub fn saml_assertions(&self) -> &SamlAssertionStore {
        &self.saml_assertions
    }
    /// Service-principal store.
    #[must_use]
    pub fn service_principals(&self) -> &ServicePrincipalStore {
        &self.service_principals
    }
    /// Blob metadata + bytes store.
    #[must_use]
    pub fn blobs(&self) -> &BlobStore {
        &self.blobs
    }

    /// The configured blob-bytes driver (map 05 §3.3). Most callers should
    /// prefer [`write_content`](Self::write_content) /
    /// [`read_content`](Self::read_content); this accessor exists for the GC /
    /// compliance paths that delete bytes directly
    /// ([`BlobBytesDriver::delete`](crate::stores::blob_bytes::BlobBytesDriver::delete)).
    #[must_use]
    pub fn blob_bytes(&self) -> &BlobBytesDriver {
        &self.blob_bytes
    }

    /// Persist (or overwrite) the raw bytes for a blob (TS
    /// `store.blobs.writeContent`, map 05 §3.5 step 8). Delegates to the
    /// configured bytes driver; `now_ms` stamps `blob_content.updated_at` on
    /// the SQL arm. The caller MUST have written the `blob_metadata` row first
    /// — `blob_content.blob_id` has an FK to it (map 05 §3.5 step 7).
    pub async fn write_content(
        &self,
        tenant_id: &str,
        blob_id: &str,
        content: &[u8],
        app_id: &str,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        self.blob_bytes
            .write(tenant_id, blob_id, content, app_id, now_ms)
            .await
    }

    /// Read the raw bytes for a blob (TS `store.blobs.readContent`, map 05
    /// §3.6 `GET /blobs/:id/content`). `None` when no bytes are stored for
    /// `(app_id, tenant_id, blob_id)`.
    pub async fn read_content(
        &self,
        tenant_id: &str,
        blob_id: &str,
        app_id: &str,
    ) -> Result<Option<Vec<u8>>, StoreError> {
        self.blob_bytes.read(tenant_id, blob_id, app_id).await
    }
    /// Tenant ledger store.
    #[must_use]
    pub fn tenants(&self) -> &TenantStore {
        &self.tenants
    }
    /// Tenant-settings KV store.
    #[must_use]
    pub fn tenant_settings(&self) -> &TenantSettingsStore {
        &self.tenant_settings
    }
    /// Invitation store.
    #[must_use]
    pub fn invitations(&self) -> &InvitationStore {
        &self.invitations
    }
    /// Grant store.
    #[must_use]
    pub fn grants(&self) -> &GrantStore {
        &self.grants
    }
    /// Hash-chained admin audit store.
    #[must_use]
    pub fn admin_audit(&self) -> &AdminAuditStore {
        &self.admin_audit
    }
    /// Push-registration store.
    #[must_use]
    pub fn push_registrations(&self) -> &PushRegistrationStore {
        &self.push_registrations
    }

    /// Internal escape hatch for the backup/restore subsystem (TS `sqlDriver`
    /// getter): the [`SqlDriver`] the store reads/writes through.
    #[must_use]
    pub fn sql_driver(&self) -> &SqlDriver {
        &self.driver
    }

    // ---- Data-plane store views (lifetime-borrowing, built on demand) ----

    /// An [`ObjectStore`] view over this facade's driver + schema.
    #[must_use]
    pub fn objects(&self) -> ObjectStore<'_> {
        ObjectStore::new(&self.driver, &self.schema)
    }

    /// A [`PresenceStore`] view.
    #[must_use]
    pub fn presence(&self) -> PresenceStore<'_> {
        PresenceStore::new(&self.driver, &self.schema)
    }

    /// A [`SignalStore`] view.
    #[must_use]
    pub fn signals(&self) -> SignalStore<'_> {
        SignalStore::new(&self.driver, &self.schema)
    }

    /// A [`JobStore`] view.
    #[must_use]
    pub fn jobs(&self) -> JobStore<'_> {
        JobStore::new(&self.driver)
    }

    /// A [`StreamStore`] view configured with this facade's replay window. Does
    /// NOT carry the cache — callers that want the front-cache go through
    /// [`append_event`](Self::append_event), which threads the shared cache.
    #[must_use]
    pub fn streams(&self) -> StreamStore<'_> {
        StreamStore::new(
            &self.driver,
            &self.schema,
            Some(self.idempotency_replay_window_ms),
        )
    }

    // ---- §7.3 write-notification funnel ----------------------------------

    /// Register the single store-write listener (the sync gateway). Passing a
    /// new listener replaces any existing one; only one consumer is expected
    /// (TS `setWriteListener`).
    pub fn set_write_listener(&self, listener: FrickStoreWriteListener) {
        if let Ok(mut slot) = self.write_listener.lock() {
            *slot = Some(listener);
        }
    }

    /// Detach the store-write listener (the gateway does this on close).
    pub fn clear_write_listener(&self) {
        if let Ok(mut slot) = self.write_listener.lock() {
            *slot = None;
        }
    }

    /// Register the single search projector (FR-245, map 03 §13). Passing a new
    /// projector replaces any existing one. The store calls it after each
    /// successful object/stream write and applies the returned [`SearchOp`]s
    /// itself; the projector must be pure (it must NOT re-enter the store).
    pub fn set_search_projector(&self, projector: FrickStoreSearchProjector) {
        if let Ok(mut slot) = self.search_projector.lock() {
            *slot = Some(projector);
        }
    }

    /// Detach the search projector (the server does this on close).
    pub fn clear_search_projector(&self) {
        if let Ok(mut slot) = self.search_projector.lock() {
            *slot = None;
        }
    }

    /// Apply the projector to a write event and run every returned [`SearchOp`]
    /// through the facade's own search SQL. Each op is its own driver call — the
    /// projector lock is released before any op runs, so the store never holds a
    /// lock across the (synchronous) projector call or the (async) SQL. Any
    /// failure is logged (`frick.search`) and swallowed: a search hiccup must
    /// never fail the originating write (map 03 §13).
    async fn run_search_projector(&self, tenant_id: &str, event: &FrickStoreWriteEvent) {
        // The SQLite arm is FTS5-backed. The Postgres `tsvector` arm is a
        // documented FR-242-style follow-up; no-op there rather than failing.
        if self.driver.dialect() != SqlDialect::Sqlite {
            // TODO(FR-242): Postgres `tsvector` search projection.
            return;
        }
        let ops = {
            let Ok(slot) = self.search_projector.lock() else {
                return;
            };
            let Some(projector) = slot.as_ref() else {
                return;
            };
            let Ok(ops) =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| projector(event)))
            else {
                tracing::warn!(
                    target: "frick.search.projector_failed",
                    kind = event_kind(event),
                    "search projector panicked",
                );
                return;
            };
            ops
        };
        for op in ops {
            match op {
                SearchOp::Upsert {
                    index,
                    doc_id,
                    text,
                    fields,
                } => {
                    if let Err(err) = self
                        .search_upsert(tenant_id, &index, &doc_id, &text, &fields)
                        .await
                    {
                        tracing::warn!(
                            target: "frick.search.upsert_failed",
                            tenant_id,
                            index = index.as_str(),
                            doc_id = doc_id.as_str(),
                            error = %err,
                            "search upsert failed",
                        );
                    }
                }
                SearchOp::Delete { index, doc_id } => {
                    if let Err(err) = self.search_delete(tenant_id, &index, &doc_id).await {
                        tracing::warn!(
                            target: "frick.search.delete_failed",
                            tenant_id,
                            index = index.as_str(),
                            doc_id = doc_id.as_str(),
                            error = %err,
                            "search delete failed",
                        );
                    }
                }
            }
        }
    }

    // ---- §13 search adapter SQL (sqlite-fts5) -----------------------------
    //
    // The store owns these writes; the projector and the server's search route
    // call them. They are `now_ms`-free — search rows have no `created_at`.

    /// Insert or replace a document in a search index (map 03 §13). The
    /// `0009_search_indexes` triggers keep `search_index_fts` in sync.
    pub async fn search_upsert(
        &self,
        tenant_id: &str,
        index_name: &str,
        doc_id: &str,
        text: &str,
        fields: &Map<String, JsonValue>,
    ) -> Result<(), StoreError> {
        search::search_upsert(&self.driver, tenant_id, index_name, doc_id, text, fields).await
    }

    /// Remove a document from a search index (map 03 §13).
    pub async fn search_delete(
        &self,
        tenant_id: &str,
        index_name: &str,
        doc_id: &str,
    ) -> Result<(), StoreError> {
        search::search_delete(&self.driver, tenant_id, index_name, doc_id).await
    }

    /// Clear `(tenant, index)` then re-insert every document (map 03 §13
    /// `rebuild`). Each `doc` is `(doc_id, text, fields)`.
    pub async fn search_rebuild(
        &self,
        tenant_id: &str,
        index_name: &str,
        docs: Vec<(String, String, Map<String, JsonValue>)>,
    ) -> Result<(), StoreError> {
        search::search_rebuild(&self.driver, tenant_id, index_name, docs).await
    }

    /// Query a search index (map 03 §13). Empty/whitespace `q` short-circuits to
    /// `{hits: [], total: 0}`. Hits carry their persisted `fields` (including the
    /// reserved `__frickSource*` keys — the server strips those before
    /// responding); they are ordered by `bm25` ascending (most relevant first),
    /// and `total` is computed independently of `limit`.
    pub async fn search_query(
        &self,
        tenant_id: &str,
        index_name: &str,
        q: &str,
        filter: &BTreeMap<String, SearchFilterValue>,
        limit: u32,
    ) -> Result<SearchQueryResult, StoreError> {
        search::search_query(&self.driver, tenant_id, index_name, q, filter, limit).await
    }

    /// Every distinct index name with documents for the tenant (map 03 §13);
    /// surfaced in the inspect report.
    pub async fn search_index_names(&self, tenant_id: &str) -> Result<Vec<String>, StoreError> {
        search::search_index_names(&self.driver, tenant_id).await
    }

    /// The search adapter id surfaced by the inspect report (map 03 §13).
    #[must_use]
    pub const fn search_adapter_id(&self) -> &'static str {
        SEARCH_ADAPTER_ID
    }

    /// Fire the store-write listener for a successful write. Any listener panic
    /// is caught + logged (`frick.store.write_listener_failed`); a fan-out
    /// hiccup must never tear down the originating write (TS
    /// `#notifyWriteListener`).
    fn notify_write_listener(&self, event: &FrickStoreWriteEvent) {
        let Ok(slot) = self.write_listener.lock() else {
            return;
        };
        let Some(listener) = slot.as_ref() else {
            return;
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(event)));
        if result.is_err() {
            tracing::warn!(
                target: "frick.store.write_listener_failed",
                kind = event_kind(event),
                "store write listener panicked",
            );
        }
    }

    /// Tenant-aware object write (TS `upsertObject` 6-arg form). Unconditional
    /// last-write-wins. After the write it re-reads the stored row, fires the
    /// projection + search extension points (FR-244/FR-245, currently no-op),
    /// then fires the write listener.
    pub async fn upsert_object(
        &self,
        tenant_id: &str,
        object_type: &str,
        object_id: &str,
        value: &Value,
        version: i64,
        app_id: &str,
    ) -> Result<(), StoreError> {
        let now_ms = self.clock.now_ms();
        self.objects()
            .upsert(
                tenant_id,
                object_type,
                object_id,
                value,
                version,
                app_id,
                now_ms,
            )
            .await?;
        // Re-read the stored row (TS re-reads, falling back to the input value).
        let stored = self
            .objects()
            .read(tenant_id, object_type, object_id, app_id)
            .await?
            .unwrap_or_else(|| value.clone());
        // Projection notify hook: FR-244 extension point (currently no-op).
        self.notify_projection_object_upsert(tenant_id, app_id, object_type, object_id, &stored);
        let event = FrickStoreWriteEvent::ObjectUpsert {
            tenant_id: tenant_id.to_string(),
            app_id: app_id.to_string(),
            object_type: object_type.to_string(),
            object_id: object_id.to_string(),
            object: stored,
        };
        // Search projector (FR-245) runs after the write, before the listener.
        self.run_search_projector(tenant_id, &event).await;
        self.notify_write_listener(&event);
        Ok(())
    }

    /// Tenant-aware object write honoring the schema-declared merge policy (TS
    /// `upsertObjectWithPolicy`). Throws on version conflict; reaching the
    /// notify step means the row was written.
    pub async fn upsert_object_with_policy(
        &self,
        tenant_id: &str,
        app_id: &str,
        object_type: &str,
        object_id: &str,
        value: &Value,
        expected_version: Option<i64>,
    ) -> Result<ObjectUpsertResult, StoreError> {
        let now_ms = self.clock.now_ms();
        let merge_policy: FrickObjectMergePolicy =
            resolve_object_merge_policy(&self.schema, object_type);
        let result = self
            .objects()
            .upsert_with_policy(
                app_id,
                tenant_id,
                object_type,
                object_id,
                value,
                expected_version,
                merge_policy,
                now_ms,
            )
            .await?;
        let stored = self
            .objects()
            .read(tenant_id, object_type, object_id, app_id)
            .await?
            .unwrap_or_else(|| value.clone());
        self.notify_projection_object_upsert(tenant_id, app_id, object_type, object_id, &stored);
        let event = FrickStoreWriteEvent::ObjectUpsert {
            tenant_id: tenant_id.to_string(),
            app_id: app_id.to_string(),
            object_type: object_type.to_string(),
            object_id: object_id.to_string(),
            object: stored,
        };
        self.run_search_projector(tenant_id, &event).await;
        self.notify_write_listener(&event);
        Ok(result)
    }

    /// Effective merge policy for an object type (TS `objectMergePolicy`).
    #[must_use]
    pub fn object_merge_policy(&self, object_type: &str) -> FrickObjectMergePolicy {
        resolve_object_merge_policy(&self.schema, object_type)
    }

    /// Remove an object row. Returns true when a row was actually deleted. The
    /// write listener fires only when a row existed (§7.3, TS `deleteObject`).
    pub async fn delete_object(
        &self,
        tenant_id: &str,
        object_type: &str,
        object_id: &str,
        app_id: &str,
    ) -> Result<bool, StoreError> {
        let existed = self
            .objects()
            .delete(tenant_id, object_type, object_id, app_id)
            .await?;
        if existed {
            let event = FrickStoreWriteEvent::ObjectDelete {
                tenant_id: tenant_id.to_string(),
                app_id: app_id.to_string(),
                object_type: object_type.to_string(),
                object_id: object_id.to_string(),
            };
            self.run_search_projector(tenant_id, &event).await;
            self.notify_write_listener(&event);
        }
        Ok(existed)
    }

    /// Append an event, deduping replays. The write listener (and the
    /// projection/search hooks) fire only on `created == true` (§7.3, TS
    /// `appendEvent`). Threads the shared idempotency front-cache so retries are
    /// deduped without a SQL round-trip; `event_id` and `now_ms` come from the
    /// determinism seams.
    #[allow(clippy::too_many_arguments)]
    pub async fn append_event(
        &self,
        tenant_id: &str,
        stream: &str,
        stream_id: &str,
        replica_id: &str,
        request_id: &str,
        event: &str,
        payload: &Value,
        app_id: &str,
    ) -> Result<AppendResult, StoreError> {
        let now_ms = self.clock.now_ms();
        let event_id = self.id_gen.event_id();
        // Take the front-cache out of the std mutex so the lock is never held
        // across the append's `.await` (the SQLite arm is single-writer).
        let mut cache = self
            .idempotency_cache
            .lock()
            .map_err(|_| StoreError::driver("idempotency cache mutex poisoned"))?
            .take();
        let append = self
            .streams()
            .append(
                tenant_id,
                stream,
                stream_id,
                replica_id,
                request_id,
                event,
                payload,
                app_id,
                &event_id,
                now_ms,
                cache.as_mut(),
            )
            .await;
        // Restore the (possibly cache-updated) front-cache. `prune` may have
        // swapped a fresh cache in while we were appending; if so, prefer the
        // fresh one (retention just invalidated ours) and drop the stale copy.
        if let Ok(mut slot) = self.idempotency_cache.lock()
            && slot.is_none()
        {
            *slot = cache.take();
        }
        let result = append?;
        if result.created {
            self.notify_projection_stream_append(&result.event);
            let event_tenant = result.event.tenant_id.clone();
            let event = FrickStoreWriteEvent::StreamAppend {
                tenant_id: event_tenant.clone(),
                event: result.event.clone(),
            };
            self.run_search_projector(&event_tenant, &event).await;
            self.notify_write_listener(&event);
        }
        Ok(result)
    }

    /// UPSERT a presence lease (TS `setPresence`). `expires_at = now + ttlMs`.
    pub async fn set_presence(
        &self,
        tenant_id: &str,
        presence_type: &str,
        presence_key: &str,
        value: &Value,
        ttl_ms: i64,
        app_id: &str,
    ) -> Result<(), StoreError> {
        let now_ms = self.clock.now_ms();
        self.presence()
            .set(
                tenant_id,
                presence_type,
                presence_key,
                value,
                ttl_ms,
                app_id,
                now_ms,
            )
            .await
    }

    /// Clear a presence lease (TS `clearPresence`).
    pub async fn clear_presence(
        &self,
        tenant_id: &str,
        presence_type: &str,
        presence_key: &str,
        app_id: &str,
    ) -> Result<(), StoreError> {
        self.presence()
            .clear(tenant_id, presence_type, presence_key, app_id)
            .await
    }

    /// Enqueue a signal (TS `enqueueSignal`). `ttl_ms` defaults to
    /// [`DEFAULT_SIGNAL_TTL_MS`] when `None`.
    pub async fn enqueue_signal(
        &self,
        tenant_id: &str,
        signal_type: &str,
        signal_key: &str,
        value: &Value,
        ttl_ms: Option<i64>,
        app_id: &str,
    ) -> Result<(), StoreError> {
        let now_ms = self.clock.now_ms();
        self.signals()
            .enqueue(
                tenant_id,
                signal_type,
                signal_key,
                value,
                ttl_ms.unwrap_or(DEFAULT_SIGNAL_TTL_MS),
                app_id,
                now_ms,
            )
            .await
    }

    /// Enqueue a background job (TS `enqueueJob`). `now_ms` from the clock seam.
    pub async fn enqueue_job(&self, input: EnqueueInput) -> Result<StoredJob, StoreError> {
        let now_ms = self.clock.now_ms();
        let row = self.jobs().enqueue(input, now_ms).await?;
        Ok(StoredJob {
            id: row.id,
            name: row.job_type,
            value: row.payload,
        })
    }

    /// Claim the next ready job of a type (TS `nextJob`). `now_ms` from the
    /// clock seam.
    pub async fn next_job(
        &self,
        tenant_id: &str,
        job_type: &str,
        app_id: Option<&str>,
    ) -> Result<Option<StoredJob>, StoreError> {
        let now_ms = self.clock.now_ms();
        self.jobs().next(tenant_id, job_type, app_id, now_ms).await
    }

    // ---- §7.6/§7.7 tenant/app-scoped accessors ----------------------------

    /// Return an [`AppScopedStore`] view whose object/stream/presence/signal/job
    /// writes default to `app_id` instead of [`DEFAULT_APP_ID`] (TS `forApp`).
    /// `None` / `_default` returns the unscoped store (no wrapper), matching the
    /// TS short-circuit.
    #[must_use]
    pub fn for_app<'a>(&'a self, app_id: Option<&str>) -> AppScopedStore<'a> {
        match app_id {
            None | Some(DEFAULT_APP_ID) => AppScopedStore {
                store: self,
                app_id: DEFAULT_APP_ID.to_string(),
            },
            Some(app_id) => AppScopedStore {
                store: self,
                app_id: app_id.to_string(),
            },
        }
    }

    // ---- §7.4 prune ------------------------------------------------------

    /// Current row count of the durable `idempotency_keys` table (TS
    /// `idempotencyKeyRowCount`).
    pub async fn idempotency_key_row_count(&self) -> Result<u64, StoreError> {
        let row = self
            .driver
            .get("SELECT COUNT(*) AS count FROM idempotency_keys", &[])
            .await?;
        Ok(row
            .and_then(|row| row.i64("count"))
            .unwrap_or(0)
            .max(0)
            .unsigned_abs())
    }

    /// Read the per-tenant `retentionMs` overrides from `tenant_settings`,
    /// returning `(tenant_id, cutoff_iso)` pairs. JSON-malformed,
    /// non-finite, or negative values are ignored (TS `prune` step 1).
    async fn collect_tenant_retention_cutoffs(
        &self,
        now_ms: i64,
    ) -> Result<Vec<(String, String)>, StoreError> {
        let rows = self
            .driver
            .all(
                "SELECT tenant_id, setting_value FROM tenant_settings WHERE setting_key = 'retentionMs'",
                &[],
            )
            .await?;
        let mut cutoffs = Vec::new();
        for row in &rows {
            let (Some(tenant_id), Some(raw)) = (row.text("tenant_id"), row.text("setting_value"))
            else {
                continue;
            };
            // setting_value is a JSON-encoded number; non-finite/negative ignored.
            let Ok(parsed) = serde_json::from_str::<f64>(raw) else {
                continue;
            };
            if !parsed.is_finite() || parsed < 0.0 {
                continue;
            }
            #[allow(clippy::cast_possible_truncation)]
            let cutoff = iso_from_epoch_ms(now_ms - parsed as i64);
            cutoffs.push((tenant_id.to_string(), cutoff));
        }
        Ok(cutoffs)
    }

    /// Prune the durable `idempotency_keys` table (TS `prune`, §7.4).
    ///
    /// Two passes inside one `BEGIN IMMEDIATE`: per-tenant `retentionMs`
    /// overrides + global cutoff (age), then a cap pass. After any deletion the
    /// in-process front-cache is rebuilt so stale LRU entries can't outlive
    /// retention.
    pub async fn prune(&self) -> Result<PruneResult, StoreError> {
        let now = self.clock.now_ms();
        let global_cutoff_iso = iso_from_epoch_ms(now - self.idempotency_key_retention_ms);

        // 1. Per-tenant retention overrides: `(tenant_id, cutoff_iso)` pairs.
        let tenant_cutoffs = self.collect_tenant_retention_cutoffs(now).await?;

        let max_rows = self.idempotency_key_max_rows;
        let result = self
            .driver
            .transaction(move |tx| {
                let tenant_cutoffs = tenant_cutoffs.clone();
                let global_cutoff_iso = global_cutoff_iso.clone();
                Box::pin(async move {
                    let mut pruned_by_age: u64 = 0;
                    // Per-tenant overrides.
                    for (tenant_id, cutoff_iso) in &tenant_cutoffs {
                        let run = tx
                            .run(
                                "DELETE FROM idempotency_keys WHERE tenant_id = ? AND created_at < ?",
                                &[tenant_id.as_str().into(), cutoff_iso.as_str().into()],
                            )
                            .await?;
                        pruned_by_age += run.changes;
                    }
                    // Remaining tenants use the global cutoff.
                    let age_run = if tenant_cutoffs.is_empty() {
                        tx.run(
                            "DELETE FROM idempotency_keys WHERE created_at < ?",
                            &[global_cutoff_iso.as_str().into()],
                        )
                        .await?
                    } else {
                        let placeholders =
                            vec!["?"; tenant_cutoffs.len()].join(",");
                        let mut params: Vec<crate::driver::SqlValue> =
                            Vec::with_capacity(tenant_cutoffs.len() + 1);
                        params.push(global_cutoff_iso.as_str().into());
                        for (tenant_id, _) in &tenant_cutoffs {
                            params.push(tenant_id.as_str().into());
                        }
                        tx.run(
                            &format!(
                                "DELETE FROM idempotency_keys WHERE created_at < ? AND tenant_id NOT IN ({placeholders})"
                            ),
                            &params,
                        )
                        .await?
                    };
                    pruned_by_age += age_run.changes;

                    // Cap pass.
                    let mut pruned_by_cap: u64 = 0;
                    let remaining = tx
                        .get("SELECT COUNT(*) AS count FROM idempotency_keys", &[])
                        .await?
                        .and_then(|row| row.i64("count"))
                        .unwrap_or(0);
                    let overflow = remaining - max_rows;
                    if overflow > 0 {
                        let cap_run = tx
                            .run(
                                "DELETE FROM idempotency_keys
                                  WHERE rowid IN (
                                    SELECT rowid FROM idempotency_keys
                                      ORDER BY created_at ASC, rowid ASC
                                      LIMIT ?
                                  )",
                                &[overflow.into()],
                            )
                            .await?;
                        pruned_by_cap = cap_run.changes;
                    }

                    Ok(PruneResult {
                        pruned_by_age,
                        pruned_by_cap,
                    })
                })
            })
            .await?;

        // Rebuild the front-cache so stale entries can't survive retention.
        if result.pruned_by_age > 0 || result.pruned_by_cap > 0 {
            #[allow(clippy::cast_precision_loss)]
            let fresh = BoundedIdempotencyCache::new(self.idempotency_cache_capacity as f64)?;
            if let Ok(mut cache) = self.idempotency_cache.lock() {
                *cache = Some(fresh);
            }
        }

        Ok(result)
    }

    /// Prune expired `auth_sessions` rows (TS `#safeExpiredSessionPrune` core).
    pub async fn prune_expired_sessions(&self) -> Result<u64, StoreError> {
        let cutoff_iso = iso_from_epoch_ms(self.clock.now_ms() - self.expired_session_grace_ms);
        self.sessions.prune_expired(&cutoff_iso).await
    }

    /// `#safePrune`: run [`prune`](Self::prune), catching + warning on failure
    /// (a maintenance failure must never tear down the process).
    async fn safe_prune(&self) {
        if let Err(error) = self.prune().await {
            tracing::warn!(
                target: "frick.store.prune_failed",
                error = %error,
                "idempotency_keys prune failed",
            );
        }
    }

    /// `#safeExpiredSessionPrune`: run [`prune_expired_sessions`], swallowing +
    /// warning on failure.
    async fn safe_expired_session_prune(&self) {
        if let Err(error) = self.prune_expired_sessions().await {
            tracing::warn!(
                target: "frick.store.session_prune_failed",
                error = %error,
                "auth_sessions prune failed",
            );
        }
    }

    // ---- maintenance loops (§7.2 last step) ------------------------------

    /// Spawn the recurring maintenance prune loops as tokio intervals (§7.2 last
    /// step). Opt-in so tests never spawn timers. An interval of `0` disables a
    /// timer (the one-shot prune already ran at construction). Returns a
    /// [`MaintenanceHandle`] whose drop aborts the loops.
    ///
    /// Wiring note: the loops borrow the store, so this takes `Arc<Self>` — the
    /// server holds the store behind an `Arc` anyway.
    #[must_use]
    pub fn start_maintenance(
        self: &Arc<Self>,
        intervals: MaintenanceIntervals,
    ) -> MaintenanceHandle {
        let mut tasks = Vec::new();

        if intervals.idempotency_prune_interval_ms > 0 {
            let store = Arc::clone(self);
            let period = duration_from_ms(intervals.idempotency_prune_interval_ms);
            tasks.push(tokio::spawn(async move {
                let mut ticker = tokio::time::interval(period);
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    ticker.tick().await;
                    store.safe_prune().await;
                }
            }));
        }

        if intervals.expired_session_prune_interval_ms > 0 {
            let store = Arc::clone(self);
            let period = duration_from_ms(intervals.expired_session_prune_interval_ms);
            tasks.push(tokio::spawn(async move {
                let mut ticker = tokio::time::interval(period);
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    ticker.tick().await;
                    store.safe_expired_session_prune().await;
                }
            }));
        }

        MaintenanceHandle { tasks }
    }

    // ---- §7.5 schema identity --------------------------------------------

    /// Record the schema identity row (§7.5): `INSERT OR IGNORE INTO
    /// schema_versions (schema_hash, manifest, created_at)` with
    /// `manifest = msgpack(encode(schema))`.
    async fn record_schema(&self) -> Result<(), StoreError> {
        let manifest = encode_packed(&self.schema)?;
        let created_at = iso_from_epoch_ms(self.clock.now_ms());
        self.driver
            .run(
                "INSERT OR IGNORE INTO schema_versions (schema_hash, manifest, created_at)
                  VALUES (?, ?, ?)",
                &[
                    self.schema.hash.as_str().into(),
                    manifest.into(),
                    created_at.into(),
                ],
            )
            .await?;
        Ok(())
    }

    /// List applied migrations from the ledger (TS `listAppliedMigrations`).
    pub async fn list_applied_migrations(&self) -> Result<Vec<AppliedMigrationRow>, StoreError> {
        migrations::list_applied_migrations(&self.driver).await
    }

    /// Cheap liveness probe (TS `pingDatabase`): `SELECT 1`.
    pub async fn ping_database(&self) -> bool {
        match self.driver.get("SELECT 1 AS ok", &[]).await {
            Ok(Some(row)) => row.i64("ok") == Some(1),
            _ => false,
        }
    }

    // ---- projection extension points (FR-244) ----------------------------
    //
    // The TS facade fans every write to the projection registry before firing
    // the write listener. That subsystem is a later story, so these are
    // deliberate no-op seams that preserve the funnel's shape and call sites.
    // (Search, FR-245, is live — see `run_search_projector`.) When FR-244
    // lands, fill these in.

    /// FR-244 extension point: notify object-sourced projections of an upsert.
    #[allow(clippy::unused_self)]
    fn notify_projection_object_upsert(
        &self,
        _tenant_id: &str,
        _app_id: &str,
        _object_type: &str,
        _object_id: &str,
        _object: &Value,
    ) {
        // TODO(FR-244): route to the (per-app) projection registry.
    }

    /// FR-244 extension point: notify stream-sourced projections of an append.
    #[allow(clippy::unused_self)]
    fn notify_projection_stream_append(&self, _event: &StoredEvent) {
        // TODO(FR-244): route to the (per-app) projection registry.
    }
}

/// Recurring-maintenance interval configuration (§7.2). An interval of `0`
/// disables that timer.
#[derive(Debug, Clone, Copy)]
pub struct MaintenanceIntervals {
    /// Idempotency-keys prune cadence (ms).
    pub idempotency_prune_interval_ms: i64,
    /// Expired-session prune cadence (ms).
    pub expired_session_prune_interval_ms: i64,
}

impl Default for MaintenanceIntervals {
    fn default() -> Self {
        Self {
            idempotency_prune_interval_ms: DEFAULT_IDEMPOTENCY_KEY_PRUNE_INTERVAL_MS,
            expired_session_prune_interval_ms: DEFAULT_EXPIRED_SESSION_PRUNE_INTERVAL_MS,
        }
    }
}

/// Handle to the spawned maintenance loops. Dropping it aborts every loop
/// (mirrors TS `close()` clearing the timers).
pub struct MaintenanceHandle {
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl MaintenanceHandle {
    /// Abort every maintenance loop.
    pub fn stop(self) {
        drop(self);
    }
}

impl Drop for MaintenanceHandle {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

/// §7.7 app-scoped proxy (`store-app-scoped.ts`). A view that injects the pinned
/// `app_id` into the object/stream/presence/signal/job write facades, deferring
/// to the underlying [`FrickStore`] for everything else. The injection is
/// "default, don't override"; reads delegate unchanged.
pub struct AppScopedStore<'a> {
    store: &'a FrickStore,
    app_id: String,
}

impl AppScopedStore<'_> {
    /// The underlying store (TS: every non-write property delegates straight
    /// through).
    #[must_use]
    pub fn store(&self) -> &FrickStore {
        self.store
    }

    /// The pinned app id this view injects.
    #[must_use]
    pub fn app_id(&self) -> &str {
        &self.app_id
    }

    /// Object write pinned to this view's app id (TS app-scoped `upsertObject`).
    pub async fn upsert_object(
        &self,
        tenant_id: &str,
        object_type: &str,
        object_id: &str,
        value: &Value,
        version: i64,
    ) -> Result<(), StoreError> {
        self.store
            .upsert_object(
                tenant_id,
                object_type,
                object_id,
                value,
                version,
                &self.app_id,
            )
            .await
    }

    /// Stream append pinned to this view's app id.
    #[allow(clippy::too_many_arguments)]
    pub async fn append_event(
        &self,
        tenant_id: &str,
        stream: &str,
        stream_id: &str,
        replica_id: &str,
        request_id: &str,
        event: &str,
        payload: &Value,
    ) -> Result<AppendResult, StoreError> {
        self.store
            .append_event(
                tenant_id,
                stream,
                stream_id,
                replica_id,
                request_id,
                event,
                payload,
                &self.app_id,
            )
            .await
    }

    /// Presence write pinned to this view's app id.
    pub async fn set_presence(
        &self,
        tenant_id: &str,
        presence_type: &str,
        presence_key: &str,
        value: &Value,
        ttl_ms: i64,
    ) -> Result<(), StoreError> {
        self.store
            .set_presence(
                tenant_id,
                presence_type,
                presence_key,
                value,
                ttl_ms,
                &self.app_id,
            )
            .await
    }

    /// Presence clear pinned to this view's app id.
    pub async fn clear_presence(
        &self,
        tenant_id: &str,
        presence_type: &str,
        presence_key: &str,
    ) -> Result<(), StoreError> {
        self.store
            .clear_presence(tenant_id, presence_type, presence_key, &self.app_id)
            .await
    }

    /// Signal enqueue pinned to this view's app id.
    pub async fn enqueue_signal(
        &self,
        tenant_id: &str,
        signal_type: &str,
        signal_key: &str,
        value: &Value,
        ttl_ms: Option<i64>,
    ) -> Result<(), StoreError> {
        self.store
            .enqueue_signal(
                tenant_id,
                signal_type,
                signal_key,
                value,
                ttl_ms,
                &self.app_id,
            )
            .await
    }

    /// Job enqueue pinned to this view's app id (structured-input form only).
    /// Fills the omitted `app_id`; an explicit one still wins (TS "default,
    /// don't override").
    pub async fn enqueue_job(&self, mut input: EnqueueInput) -> Result<StoredJob, StoreError> {
        if input.app_id.is_none() {
            input.app_id = Some(self.app_id.clone());
        }
        self.store.enqueue_job(input).await
    }
}

/// One `blob_derivatives` row, mapped to its camelCase HTTP shape (TS
/// `DerivativeRow`, blob-derivative-store.ts:148-183). `metadata` is the
/// JSON-decoded `metadata` column (omitted/`None` when the column is NULL or
/// fails to parse, matching the TS swallow-on-corrupt behavior). The byte
/// `content` column is NOT carried here — read it via
/// [`FrickStore::read_derivative`].
#[derive(Debug, Clone, PartialEq)]
pub struct DerivativeRow {
    pub parent_blob_id: String,
    pub derivative_id: String,
    pub tenant_id: String,
    pub processor_id: String,
    pub mime_type: String,
    pub byte_length: i64,
    pub content_hash: String,
    pub storage_key: String,
    pub created_at: String,
    /// Decoded `metadata` JSON; `None` when absent or unparsable.
    pub metadata: Option<serde_json::Value>,
}

/// Result of [`FrickStore::read_derivative`]: the mapped row plus its inline
/// bytes (TS `{ row, bytes }`; `bytes` is empty when the `content` column is
/// NULL).
#[derive(Debug, Clone, PartialEq)]
pub struct DerivativeReadResult {
    pub row: DerivativeRow,
    pub bytes: Vec<u8>,
}

impl FrickStore {
    /// `BlobDerivativeStore.listForParent` (blob-derivative-store.ts:120-128):
    /// every derivative row for a parent, `ORDER BY derivative_id ASC`. NOT
    /// app-scoped (the `blob_derivatives` table has no `app_id` column, map 05
    /// §3.1); the caller gates access by reading the parent metadata with the
    /// active app id first.
    pub async fn list_derivatives(
        &self,
        parent_blob_id: &str,
        tenant_id: &str,
    ) -> Result<Vec<DerivativeRow>, StoreError> {
        let rows = self
            .driver
            .all(
                "SELECT * FROM blob_derivatives
                    WHERE tenant_id = ? AND parent_blob_id = ?
                    ORDER BY derivative_id ASC",
                &[tenant_id.into(), parent_blob_id.into()],
            )
            .await?;
        Ok(rows.iter().map(map_derivative_row).collect())
    }

    /// `BlobDerivativeStore.read` (blob-derivative-store.ts:144-159): a single
    /// derivative row plus its inline bytes, or `None`. Bytes are empty when
    /// the `content` column is NULL.
    pub async fn read_derivative(
        &self,
        parent_blob_id: &str,
        derivative_id: &str,
        tenant_id: &str,
    ) -> Result<Option<DerivativeReadResult>, StoreError> {
        let row = self
            .driver
            .get(
                "SELECT * FROM blob_derivatives
                    WHERE tenant_id = ? AND parent_blob_id = ? AND derivative_id = ?
                    LIMIT 1",
                &[
                    tenant_id.into(),
                    parent_blob_id.into(),
                    derivative_id.into(),
                ],
            )
            .await?;
        Ok(row.as_ref().map(|row| {
            let bytes = row.blob("content").map(<[u8]>::to_vec).unwrap_or_default();
            DerivativeReadResult {
                row: map_derivative_row(row),
                bytes,
            }
        }))
    }
}

/// `mapRow` (blob-derivative-store.ts:162-183): a `SELECT *` row → a
/// [`DerivativeRow`]. The `metadata` column is JSON-decoded; a NULL or
/// unparsable value yields `None` (the TS swallows the parse error).
fn map_derivative_row(row: &crate::driver::SqlRow) -> DerivativeRow {
    let metadata = row
        .text("metadata")
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok());
    DerivativeRow {
        parent_blob_id: row.text("parent_blob_id").unwrap_or_default().to_owned(),
        derivative_id: row.text("derivative_id").unwrap_or_default().to_owned(),
        tenant_id: row.text("tenant_id").unwrap_or_default().to_owned(),
        processor_id: row.text("processor_id").unwrap_or_default().to_owned(),
        mime_type: row.text("mime_type").unwrap_or_default().to_owned(),
        byte_length: row.i64("byte_length").unwrap_or_default(),
        content_hash: row.text("content_hash").unwrap_or_default().to_owned(),
        storage_key: row.text("storage_key").unwrap_or_default().to_owned(),
        created_at: row.text("created_at").unwrap_or_default().to_owned(),
        metadata,
    }
}

/// Render epoch milliseconds as an ISO-8601 UTC string with millisecond
/// precision and a trailing `Z` — the JS `Date#toISOString` shape the stored
/// timestamps use. Re-exported from the stream store's helper for consistency.
fn iso_from_epoch_ms(epoch_ms: i64) -> String {
    crate::stores::job::epoch_ms_to_iso(epoch_ms)
}

/// Convert a non-negative ms interval to a [`std::time::Duration`].
fn duration_from_ms(ms: i64) -> std::time::Duration {
    std::time::Duration::from_millis(ms.max(0).unsigned_abs())
}

/// Static event-kind label for log fields.
fn event_kind(event: &FrickStoreWriteEvent) -> &'static str {
    match event {
        FrickStoreWriteEvent::ObjectUpsert { .. } => "objectUpsert",
        FrickStoreWriteEvent::ObjectDelete { .. } => "objectDelete",
        FrickStoreWriteEvent::StreamAppend { .. } => "streamAppend",
    }
}

#[cfg(test)]
mod tests;
