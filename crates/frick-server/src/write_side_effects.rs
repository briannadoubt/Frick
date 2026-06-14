//! App-registered post-commit write side-effects (FR-304).
//!
//! The data plane already drives synchronous projections off the store write
//! funnel, but app backends sometimes need *async* post-commit work — a store
//! read, a `enqueue_job`, a notification intent, a durable audit row — that
//! must not fail or block the originating write. A [`WriteSideEffect`] runs
//! detached after a write commits, with an owned store handle; its errors are
//! logged, never propagated. Registered via
//! [`crate::boot::BootSeams::write_side_effects`] and dispatched from the
//! gateway's store-write funnel for every event kind (object upsert/delete,
//! stream append), carrying the event's `app_id` for multi-app routing.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use frick_store::{FrickStore, FrickStoreWriteEvent};

/// A detached, `'static` future a side-effect returns — it owns the event +
/// store handle it was built from, so it can be spawned to run after the write.
pub type WriteSideEffectFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

/// An app-registered post-commit side-effect (FR-304). `on_write` builds an
/// owned future from the (cloned) event and a store handle, so the runtime can
/// spawn it detached — it must not assume it runs before the next write, and an
/// `Err` is logged rather than surfaced to the writer.
pub trait WriteSideEffect: Send + Sync {
    fn on_write(
        &self,
        event: FrickStoreWriteEvent,
        store: Arc<FrickStore>,
    ) -> WriteSideEffectFuture;
}

/// Boxed, shareable side-effect (registered in [`BootSeams`] / cloned per write).
///
/// [`BootSeams`]: crate::boot::BootSeams
pub type SharedWriteSideEffect = Arc<dyn WriteSideEffect>;
