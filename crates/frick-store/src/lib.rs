//! Frick storage layer (FR-241/FR-242): the `SqlDriver` seam, the framework
//! migration runner, and the durable + cache stores, ported from
//! `apps/server/src/storage/`. Spec: `internal/rust-rewrite/maps/03-store-layer.md`.

pub mod backup;
pub mod driver;
pub mod error;
pub mod facade;
pub mod migrations;
pub mod packed;
pub mod stores;

pub use backup::{
    DumpOptions, FRICK_DUMP_FORMAT, RestoreError, RestoreOptions, RestoreRefusal, RestoreReport,
    SchemaCompatibility, SkippedRow,
};
pub use driver::{RunResult, SqlDialect, SqlDriver, SqlExec, SqlRow, SqlValue};
pub use error::StoreError;
pub use facade::{
    AppScopedStore, DEFAULT_APP_ID, DEFAULT_TENANT_ID, DerivativeReadResult, DerivativeRecordInput,
    DerivativeRow, FrickStore, FrickStoreOptions, FrickStoreSearchProjector, FrickStoreWriteEvent,
    FrickStoreWriteListener, MaintenanceHandle, MaintenanceIntervals, PruneResult, StoreDriverKind,
};
pub use stores::blob::derivative_storage_key;
pub use stores::search::{
    DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, SEARCH_ADAPTER_ID, SearchFilterValue, SearchHit,
    SearchOp, SearchQueryResult,
};
