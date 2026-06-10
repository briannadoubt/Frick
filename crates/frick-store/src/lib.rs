//! Frick storage layer (FR-241/FR-242): the `SqlDriver` seam, the framework
//! migration runner, and the durable + cache stores, ported from
//! `apps/server/src/storage/`. Spec: `internal/rust-rewrite/maps/03-store-layer.md`.

pub mod driver;
pub mod error;
pub mod facade;
pub mod migrations;
pub mod packed;
pub mod stores;

pub use driver::{RunResult, SqlDialect, SqlDriver, SqlExec, SqlRow, SqlValue};
pub use error::StoreError;
pub use facade::{
    AppScopedStore, DEFAULT_APP_ID, DEFAULT_TENANT_ID, FrickStore, FrickStoreOptions,
    FrickStoreWriteEvent, FrickStoreWriteListener, MaintenanceHandle, MaintenanceIntervals,
    PruneResult, StoreDriverKind,
};
