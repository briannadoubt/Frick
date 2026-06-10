//! Storage-layer errors. Migration error *names and message formats* mirror
//! the TS classes in `apps/server/src/storage/migrations.ts` exactly — the
//! conformance bar treats those strings as contract.

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// Generic driver/IO failure.
    #[error("{0}")]
    Driver(String),

    /// `FrickMigrationError` — applying a migration failed.
    #[error("{0}")]
    Migration(String),

    /// `FrickMigrationChecksumError` — an applied migration's recorded
    /// checksum no longer matches its in-code definition.
    #[error("{0}")]
    MigrationChecksum(String),

    /// `FrickMigrationRevisionError` — the database is ahead of the server's
    /// supported schema revision.
    #[error("{0}")]
    MigrationRevision(String),

    /// A store-level semantic failure (conflict, cross-app access, ...);
    /// message text mirrors the TS error it ports.
    #[error("{0}")]
    Store(String),

    /// `FrickBlobStorageError` — blob bytes driver failure (FR-53/FR-54);
    /// message text mirrors `apps/server/src/storage/blob-bytes-driver.ts`.
    #[error("{0}")]
    BlobStorage(String),

    /// `FrickObjectVersionConflictError` (`storage/object-errors.ts`) —
    /// envelope code `storage.conflict`; the HTTP layer maps it to 409.
    /// `expected_version: None` expresses create-only intent and renders as
    /// `expected create` in the message, exactly like the TS class.
    #[error(
        "Version conflict on {object_type}/{object_id}: expected {}, actual {actual_version}",
        .expected_version.map_or_else(|| "create".to_owned(), |version| version.to_string())
    )]
    ObjectVersionConflict {
        tenant_id: String,
        object_type: String,
        object_id: String,
        expected_version: Option<i64>,
        actual_version: i64,
    },

    /// `FrickCrossAppAccessError` (`storage/object-errors.ts`) — envelope
    /// code `storage.crossAppDenied`, reason `appMismatch`; HTTP maps to 409.
    #[error(
        "Cross-app access denied on {object_type}/{object_id}: app '{requested_app_id}' may not write a row owned by app '{owner_app_id}'"
    )]
    CrossAppAccess {
        requested_app_id: String,
        owner_app_id: String,
        tenant_id: String,
        object_type: String,
        object_id: String,
    },
}

impl StoreError {
    #[must_use]
    pub fn driver(message: impl Into<String>) -> Self {
        Self::Driver(message.into())
    }

    #[must_use]
    pub fn store(message: impl Into<String>) -> Self {
        Self::Store(message.into())
    }

    #[must_use]
    pub fn blob_storage(message: impl Into<String>) -> Self {
        Self::BlobStorage(message.into())
    }

    // Takes the error by value so it can be used directly as
    // `.map_err(StoreError::sqlite)`.
    #[allow(clippy::needless_pass_by_value)]
    pub(crate) fn sqlite(err: rusqlite::Error) -> Self {
        Self::Driver(err.to_string())
    }
}
