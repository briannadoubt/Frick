//! Durable background jobs: the app-provided handler registry, the polling
//! worker, and the recurring scheduler (`apps/server/src/jobs/**`; map 05 §2,
//! map 02 §9). Built on the finished [`frick_store`] `JobStore` (claim /
//! complete / fail / enqueue and the backoff / dead-letter model) — this layer
//! adds dispatch, the handler trait, and the timers.
//!
//! # What lives here
//!
//! - [`handler`] — the [`JobHandler`] trait (app-provided, boxed `Send+Sync`),
//!   [`JobContext`] / [`JobError`], and the [`JobHandlerRegistry`]
//!   (duplicate `jobType` throws at registration; `list()` is sorted).
//! - [`worker`] — [`JobWorker`]: a tokio polling loop that claims a batch
//!   (default 5) every interval (default 500 ms), dispatches each job to its
//!   handler, and completes / fails it through the store. Exposes
//!   [`JobWorker::poll_once`] for deterministic, timer-free testing.
//! - [`recurring`] — [`RecurringScheduler`]: a tokio timer (default 30 s) that
//!   re-enqueues recurring specs once per window via the store's per-window
//!   idempotency key. Exposes [`RecurringScheduler::tick_once`] for tests.
//!
//! The framework job types `push.deliver` (FR-248), `blob.process`, and
//! `blob.gc` are **deferred** — this module ships no built-in handlers, only
//! the machinery to register and run app-provided ones.
//!
//! # Determinism
//!
//! Every store call threads `now_ms`. The deterministic entry points
//! ([`JobWorker::poll_once`] / [`RecurringScheduler::tick_once`]) take `now_ms`
//! as a parameter; the timer loops ([`JobWorker::start`] /
//! [`RecurringScheduler::start`]) read the system clock once per tick at the
//! loop boundary via [`now_ms_system`]. Tests never spawn a timer.
//!
//! # Integrator wiring (`create_frick_server` / boot)
//!
//! This module owns no global state and never auto-starts a timer — the
//! integrator decides. The store-access seam is the [`StoreProvider`] trait:
//! the worker and scheduler hold an `Arc<dyn StoreProvider>` so their loops can
//! run in a `'static` task while the store stays owned by the server state.
//!
//! 1. Build a shared [`JobHandlerRegistry`], register every app-provided
//!    handler (collision → [`DuplicateJobHandlerError`] at boot), and wrap it in
//!    an `Arc`.
//! 2. Provide a [`StoreProvider`]. The server holds the store inside
//!    `Arc<AppStateInner>`; implement [`StoreProvider`] for that type (one
//!    method returning `&self.store`) — or, if the store is held as
//!    `Arc<FrickStore>`, use the supplied [`ArcStoreProvider`].
//! 3. Construct the worker and (if any recurring specs) the scheduler:
//!
//!    ```ignore
//!    let registry = Arc::new(registry);
//!    let provider: Arc<dyn StoreProvider> = Arc::new(ArcStoreProvider(store.clone()));
//!    let worker = Arc::new(JobWorker::new(JobWorkerOptions {
//!        store: Arc::clone(&provider),
//!        registry: Arc::clone(&registry),
//!        worker_id: format!("worker-{}", &uuid[..8]),
//!        poll_interval_ms: config.jobs.poll_interval_ms, // None ⇒ 500
//!        claim_batch_size: None,                          // ⇒ 5
//!    }));
//!    let recurring = Arc::new(RecurringRegistry::new(specs)?); // boot-validates intervals
//!    let scheduler = Arc::new(RecurringScheduler::new(RecurringSchedulerOptions {
//!        store: provider,
//!        registry: Arc::clone(&recurring),
//!        tick_interval_ms: None, // ⇒ 30_000
//!    }));
//!    ```
//!
//! 4. Outside a test runner (TS `workerEnabledDefault = !inTestRunner`,
//!    `server.ts:961-981`), start the loops and keep the handles alive on the
//!    server (drop = abort, mirroring `close()`):
//!
//!    ```ignore
//!    let worker_handle = Arc::clone(&worker).start();
//!    let recurring_handle = (!recurring.is_empty())
//!        .then(|| Arc::clone(&scheduler).start());
//!    ```
//!
//!    On shutdown, `worker_handle.stop()` / `recurring_handle.map(|h| h.stop())`.
//!
//! [`JobHandler`]: handler::JobHandler
//! [`JobContext`]: handler::JobContext
//! [`JobError`]: handler::JobError
//! [`JobHandlerRegistry`]: handler::JobHandlerRegistry
//! [`DuplicateJobHandlerError`]: handler::DuplicateJobHandlerError
//! [`JobWorker`]: worker::JobWorker
//! [`JobWorker::poll_once`]: worker::JobWorker::poll_once
//! [`JobWorker::start`]: worker::JobWorker::start
//! [`RecurringScheduler`]: recurring::RecurringScheduler
//! [`RecurringScheduler::tick_once`]: recurring::RecurringScheduler::tick_once
//! [`RecurringScheduler::start`]: recurring::RecurringScheduler::start
//! [`RecurringRegistry::new`]: recurring::RecurringRegistry::new

pub mod handler;
pub mod recurring;
pub mod worker;

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use frick_store::FrickStore;

pub use handler::{
    DuplicateJobHandlerError, JobContext, JobError, JobHandler, JobHandlerFuture,
    JobHandlerRegistry, SharedJobHandler,
};
pub use recurring::{
    DEFAULT_TICK_INTERVAL_MS, RecurringIntervalError, RecurringJob, RecurringRegistry,
    RecurringScheduler, RecurringSchedulerHandle, RecurringSchedulerOptions, RecurringTarget,
    RecurringTargets,
};
pub use worker::{
    DEFAULT_CLAIM_BATCH_SIZE, DEFAULT_POLL_INTERVAL_MS, JobWorker, JobWorkerHandle,
    JobWorkerOptions,
};

/// Store-access seam for the job worker and recurring scheduler.
///
/// The worker / scheduler loops run in `'static` tokio tasks but need a
/// `&FrickStore` per tick. Rather than coupling this module to the server's
/// state type, both hold an `Arc<dyn StoreProvider>` and call [`store`] each
/// tick. The integrator implements this for whatever owns the store (e.g.
/// `AppStateInner`, whose `store: FrickStore` field is returned directly), or
/// uses [`ArcStoreProvider`] when the store is held as `Arc<FrickStore>`.
///
/// [`store`]: StoreProvider::store
pub trait StoreProvider: Send + Sync + 'static {
    /// The store the worker / scheduler reads and writes through.
    fn store(&self) -> &FrickStore;
}

/// A [`StoreProvider`] for a store held behind an `Arc`.
pub struct ArcStoreProvider(pub Arc<FrickStore>);

impl StoreProvider for ArcStoreProvider {
    fn store(&self) -> &FrickStore {
        &self.0
    }
}

/// Current wall-clock time as epoch milliseconds — read once per timer tick at
/// the loop boundary (the deterministic `*_once` methods take `now_ms`
/// explicitly, so this never appears in the tested code path).
#[must_use]
pub fn now_ms_system() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

#[cfg(test)]
mod tests;
