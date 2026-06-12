//! Recurring-job scheduler (`apps/server/src/jobs/recurring.ts`; map 05 §2.10).
//!
//! Re-enqueues a registered job once per time window using an idempotency key
//! derived from the window start, so:
//!   - ticks that fire multiple times in the same window are no-ops
//!   - process restarts resume correctly — the next tick after restart covers
//!     any window that landed while the process was down
//!   - multi-tenant / multi-app fan-out is explicit: apps supply
//!     [`RecurringTargets`] which returns one [`RecurringTarget`] per enqueue
//!
//! The scheduler owns the timer and the idempotency strategy; the
//! [`JobWorker`](super::worker::JobWorker) owns retries and failure handling.
//!
//! Determinism: the window math and idempotency keys come from the finished
//! store helpers ([`recurring_window_start`] / [`recurring_idempotency_key`]),
//! and [`RecurringScheduler::tick_once`] takes an explicit `now_ms`. The timer
//! loop ([`RecurringScheduler::start`]) reads the system clock once per tick.
//!
//! Unlike the TS scheduler (which fires `enqueue` without `await`, leaking the
//! rejection), this awaits the enqueue and logs failures
//! (`frick.recurring.enqueue_failed`) — the documented preserve-or-fix in map
//! 05 §2.10 resolved in favour of awaiting.

use std::sync::Arc;

use frick_protocol::Value;
use frick_store::FrickStore;
use frick_store::stores::job::{
    EnqueueInput, RECURRING_MIN_INTERVAL_MS, epoch_ms_to_iso, recurring_idempotency_key,
    recurring_window_start,
};

use super::{StoreProvider, now_ms_system};

/// TS recurring `tickIntervalMs` default (`recurring.ts:121`).
pub const DEFAULT_TICK_INTERVAL_MS: u64 = 30_000;

/// One enqueue target produced by [`RecurringTargets::resolve`] (TS
/// `RecurringTarget`, `recurring.ts:42-47`).
#[derive(Debug, Clone, PartialEq)]
pub struct RecurringTarget {
    /// Tenant to enqueue under.
    pub tenant_id: String,
    /// App partition to enqueue under (FR-153). `None` ⇒ the default app AND
    /// the idempotency key omits the app segment (TS `appId !== undefined`).
    pub app_id: Option<String>,
    /// Payload for the enqueued job. `None` ⇒ an empty map (TS `payload ?? {}`).
    pub payload: Option<Value>,
}

impl RecurringTarget {
    /// A target for `tenant_id` in the default app with an empty payload.
    #[must_use]
    pub fn tenant(tenant_id: impl Into<String>) -> Self {
        Self {
            tenant_id: tenant_id.into(),
            app_id: None,
            payload: None,
        }
    }
}

/// App-provided target resolver for a recurring job (TS
/// `FrickRecurringJob.resolveTargets`, `recurring.ts:37-39`). Called on every
/// tick; lets apps fan out across linked tenants/apps without keeping their own
/// list. Boxed `Send + Sync` so the scheduler can run in a `'static` task.
pub trait RecurringTargets: Send + Sync {
    /// Resolve the targets to enqueue this tick. A failure is logged
    /// (`frick.recurring.resolve_targets_failed`) and the job is skipped this
    /// tick (TS catch behaviour).
    fn resolve<'a>(
        &'a self,
        store: &'a FrickStore,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Vec<RecurringTarget>, String>> + Send + 'a>,
    >;
}

/// A spec for one recurring job (TS `FrickRecurringJob`, `recurring.ts:22-40`).
pub struct RecurringJob {
    /// Stable name for this spec, e.g. `"discogs.poll-orders"`. Part of the
    /// idempotency key.
    pub name: String,
    /// The `jobType` (registered in the handler registry) that runs each tick.
    pub job_type: String,
    /// Interval between completions in ms. Minimum [`RECURRING_MIN_INTERVAL_MS`]
    /// (validated by [`RecurringRegistry::new`]).
    pub interval_ms: i64,
    /// Resolver for the per-tick fan-out targets.
    pub resolve_targets: Arc<dyn RecurringTargets>,
}

/// Raised by [`RecurringRegistry::new`] when a spec's `interval_ms` is below
/// the minimum (TS `createFrickRecurringRegistry` throws, `recurring.ts:107`).
/// Same message shape for parity.
#[derive(Debug, Clone, thiserror::Error)]
#[error("Recurring job \"{name}\" intervalMs must be >= {minimum} (got {got})")]
pub struct RecurringIntervalError {
    /// The offending spec name.
    pub name: String,
    /// The minimum interval ([`RECURRING_MIN_INTERVAL_MS`]).
    pub minimum: i64,
    /// The rejected interval.
    pub got: i64,
}

/// The validated set of recurring specs (TS `FrickRecurringRegistry`). Holds
/// registration order.
pub struct RecurringRegistry {
    jobs: Vec<Arc<RecurringJob>>,
}

impl RecurringRegistry {
    /// Validate every spec's interval and build the registry. Rejects the first
    /// spec with `interval_ms < RECURRING_MIN_INTERVAL_MS` (TS boot throw).
    pub fn new(jobs: Vec<RecurringJob>) -> Result<Self, RecurringIntervalError> {
        for job in &jobs {
            if job.interval_ms < RECURRING_MIN_INTERVAL_MS {
                return Err(RecurringIntervalError {
                    name: job.name.clone(),
                    minimum: RECURRING_MIN_INTERVAL_MS,
                    got: job.interval_ms,
                });
            }
        }
        Ok(Self {
            jobs: jobs.into_iter().map(Arc::new).collect(),
        })
    }

    /// The registered specs, in registration order (TS `list()`).
    #[must_use]
    pub fn list(&self) -> &[Arc<RecurringJob>] {
        &self.jobs
    }

    /// Whether there are any recurring specs (the integrator only starts the
    /// timer when this is true, mirroring TS `recurringJobs.length > 0`).
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.jobs.is_empty()
    }
}

/// Recurring scheduler construction options (TS `RecurringSchedulerOptions`).
pub struct RecurringSchedulerOptions {
    /// Source of the [`FrickStore`] for `resolveTargets` and `enqueue`.
    pub store: Arc<dyn StoreProvider>,
    /// The validated recurring specs.
    pub registry: Arc<RecurringRegistry>,
    /// Tick cadence in ms. `None` ⇒ [`DEFAULT_TICK_INTERVAL_MS`].
    pub tick_interval_ms: Option<u64>,
}

/// The recurring scheduler. Drive deterministically via
/// [`RecurringScheduler::tick_once`] (tests) or as a timer loop via
/// [`RecurringScheduler::start`] (production, integrator-gated).
pub struct RecurringScheduler {
    store: Arc<dyn StoreProvider>,
    registry: Arc<RecurringRegistry>,
    tick_interval_ms: u64,
}

impl RecurringScheduler {
    /// Build a scheduler from options.
    #[must_use]
    pub fn new(options: RecurringSchedulerOptions) -> Self {
        Self {
            store: options.store,
            registry: options.registry,
            tick_interval_ms: options.tick_interval_ms.unwrap_or(DEFAULT_TICK_INTERVAL_MS),
        }
    }

    /// Resolved tick interval (ms).
    #[must_use]
    pub fn tick_interval_ms(&self) -> u64 {
        self.tick_interval_ms
    }

    /// Run exactly one scheduling tick at `now_ms`: for each recurring spec,
    /// resolve targets and enqueue one job per target with the per-window
    /// idempotency key. Window dedupe rides the jobs unique idempotency index,
    /// so repeated ticks within a window are no-ops. Returns the number of
    /// `enqueue` calls that succeeded (deduped re-enqueues count as success,
    /// matching the store returning the existing row).
    ///
    /// `resolveTargets` failures are logged and skip that spec for the tick;
    /// per-target enqueue failures are logged and skip that target — neither
    /// aborts the tick (TS catch behaviour).
    pub async fn tick_once(&self, now_ms: i64) -> usize {
        let store = self.store.store();
        let mut enqueued = 0;
        // Clone the spec handles up front so we never hold a borrow across the
        // `.await`s (the registry is `Arc`-shared and immutable anyway).
        let jobs: Vec<Arc<RecurringJob>> = self.registry.list().to_vec();
        for job in jobs {
            let window_start = recurring_window_start(now_ms, job.interval_ms);
            let targets = match job.resolve_targets.resolve(store).await {
                Ok(targets) => targets,
                Err(error) => {
                    tracing::error!(
                        target: "frick.recurring.resolve_targets_failed",
                        job_name = %job.name,
                        %error,
                        "resolveTargets failed; skipping this recurring job for the tick",
                    );
                    continue;
                }
            };
            for target in targets {
                let idempotency_key = recurring_idempotency_key(
                    &job.name,
                    target.app_id.as_deref(),
                    &target.tenant_id,
                    window_start,
                );
                let input = EnqueueInput {
                    tenant_id: target.tenant_id.clone(),
                    app_id: target.app_id.clone(),
                    job_type: job.job_type.clone(),
                    payload: target.payload.clone().unwrap_or_else(empty_map),
                    idempotency_key: Some(idempotency_key),
                    available_at: Some(epoch_ms_to_iso(window_start)),
                    max_attempts: None,
                };
                // Awaited (unlike TS, which leaks the rejection): a failure is
                // logged per target and the tick continues.
                match store.jobs().enqueue(input, now_ms).await {
                    Ok(_) => enqueued += 1,
                    Err(error) => {
                        tracing::error!(
                            target: "frick.recurring.enqueue_failed",
                            job_name = %job.name,
                            tenant_id = %target.tenant_id,
                            %error,
                            "recurring enqueue failed",
                        );
                    }
                }
            }
        }
        enqueued
    }

    /// Start the background timer loop as a tokio task and return a
    /// [`RecurringSchedulerHandle`] whose [`stop`](RecurringSchedulerHandle::stop)
    /// (or drop) aborts it. Reads the system clock once per tick at the loop
    /// boundary, then calls [`Self::tick_once`].
    ///
    /// The integrator gates this: TS starts the timer only outside a test
    /// runner AND only when at least one recurring spec exists
    /// (`server.ts:1021-1023`). This Rust API never auto-starts.
    #[must_use]
    pub fn start(self: Arc<Self>) -> RecurringSchedulerHandle {
        let period = std::time::Duration::from_millis(self.tick_interval_ms.max(1));
        let task = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(period);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            // First immediate tick is fine — the idempotency key dedupes it
            // against any already-enqueued window.
            loop {
                ticker.tick().await;
                self.tick_once(now_ms_system()).await;
            }
        });
        RecurringSchedulerHandle { task: Some(task) }
    }
}

/// An empty msgpack map — the default recurring payload (TS `payload ?? {}`).
fn empty_map() -> Value {
    Value::Map(Vec::new())
}

/// Handle to the spawned scheduler loop. Dropping it aborts the loop.
pub struct RecurringSchedulerHandle {
    task: Option<tokio::task::JoinHandle<()>>,
}

impl RecurringSchedulerHandle {
    /// Abort the scheduler loop. Idempotent.
    pub fn stop(mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }

    /// Whether the loop is still scheduled.
    #[must_use]
    pub fn running(&self) -> bool {
        self.task.as_ref().is_some_and(|task| !task.is_finished())
    }
}

impl Drop for RecurringSchedulerHandle {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}
