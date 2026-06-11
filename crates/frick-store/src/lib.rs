//! Frick storage layer (FR-241/FR-242): the `SqlDriver` seam, the framework
//! migration runner, and the durable + cache stores, ported from
//! `apps/server/src/storage/`. Spec: `internal/rust-rewrite/maps/03-store-layer.md`.

pub mod backup;
pub mod driver;
pub mod error;
pub mod facade;
pub mod migrations;
pub mod packed;
pub mod platform_events;
pub mod stores;

pub use backup::{
    DumpOptions, FRICK_DUMP_FORMAT, RestoreError, RestoreOptions, RestoreRefusal, RestoreReport,
    SchemaCompatibility, SkippedRow,
};
pub use driver::{RunResult, SqlDialect, SqlDriver, SqlExec, SqlRow, SqlValue};
pub use error::StoreError;
pub use facade::{
    AppScopedStore, DEFAULT_APP_ID, DEFAULT_RECENT_ERROR_LIMIT, DEFAULT_TENANT_ID,
    DerivativeReadResult, DerivativeRecordInput, DerivativeRow, DiagnosticsErrorEnvelope,
    FrickStore, FrickStoreOptions, FrickStoreSearchProjector, FrickStoreWriteEvent,
    FrickStoreWriteListener, IdempotencyCacheStats, MaintenanceHandle, MaintenanceIntervals,
    PruneResult, StoreDriverKind,
};
pub use platform_events::{
    DEFAULT_PLATFORM_EVENTS_CLAIM_TIMEOUT_MS, DEFAULT_PLATFORM_EVENTS_MAX_ROWS,
    DEFAULT_PLATFORM_EVENTS_PRUNE_INTERVAL_MS, DEFAULT_PLATFORM_EVENTS_RETENTION_MS,
    MemoryPlatformEvents, PLATFORM_EVENT_FAMILIES, PlatformEventClaimOptions,
    PlatformEventConsumerHealth, PlatformEventDelivery, PlatformEventDeliveryAttempt,
    PlatformEventEnvelope, PlatformEventHealth, PlatformEventInput, PlatformEventPublishReceipt,
    PlatformEventValidationError, PlatformEventsAdapter, PlatformEventsDriver,
    PlatformEventsPruneResult, SqlitePlatformEvents, is_platform_event_family,
    normalize_platform_event_input,
};
pub use stores::blob::derivative_storage_key;
pub use stores::blob_bytes::{FrickBlobDriver, S3BlobBytesConfig};
pub use stores::devtools_events::{
    DEFAULT_DEVTOOLS_EVENTS_MAX_ROWS, DEFAULT_DEVTOOLS_EVENTS_PRUNE_INTERVAL_MS,
    DEFAULT_DEVTOOLS_EVENTS_RETENTION_MS, DEFAULT_SUMMARY_WINDOW_MS, DevToolsEventInput,
    DevToolsEventListFilter, DevToolsEventRow, DevToolsEventStore, DevToolsEventsPruneResult,
    DevToolsEventsSummary, DevToolsKindCount,
};
pub use stores::search::{
    DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, SEARCH_ADAPTER_ID, SearchFilterValue, SearchHit,
    SearchOp, SearchQueryResult,
};
