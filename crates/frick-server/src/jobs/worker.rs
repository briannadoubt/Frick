//! In-process durable-job worker (`apps/server/src/jobs/worker.ts`; map 05
//! §2.9). Polls [`JobStore::claim`] on an interval, dispatches each claimed job
//! through the registered [`JobHandler`], then marks it complete / failed.
//!
//! Design (matching the TS worker):
//!   - one polling loop per worker instance (no thread pool)
//!   - jobs in a claim batch run **serially**, with an early exit between jobs
//!     when stop is requested
//!   - poll interval default 500 ms, claim batch size 5
//!   - the loop reads the system clock only at the loop boundary (the
//!     deterministic [`Self::poll_once`] takes an explicit `now_ms`)
//!   - unknown `jobType` → non-retryable failure (`jobs.unknownHandler`) so the
//!     row dead-letters rather than silently accumulating
//!
//! Determinism: every store call threads `now_ms`. Tests drive
//! [`JobWorker::poll_once`] with a fixed clock; the timer loop
//! ([`JobWorker::start`]) reads `SystemTime` once per tick at the boundary.
//!
//! [`JobStore::claim`]: frick_store::stores::job::JobStore::claim

use std::sync::Arc;

use frick_protocol::Value;
use frick_store::FrickStore;
use frick_store::stores::job::JobRow;

use super::handler::{JobContext, JobHandlerRegistry};
use super::{StoreProvider, now_ms_system};

/// TS `DEFAULT_POLL_INTERVAL_MS` (`worker.ts:64`).
pub const DEFAULT_POLL_INTERVAL_MS: u64 = 500;
/// TS `DEFAULT_CLAIM_BATCH_SIZE` (`worker.ts:65`).
pub const DEFAULT_CLAIM_BATCH_SIZE: i64 = 5;

/// Worker construction options (TS `FrickJobWorkerOptions`, `worker.ts:41-62`).
/// The telemetry / metrics / platform-event / per-app-registry knobs are later
/// stories; this story wires the polling-and-dispatch core.
pub struct JobWorkerOptions {
    /// Source of the [`FrickStore`] the loop polls and writes through. Held as
    /// `Arc<dyn StoreProvider>` so the loop can run in a `'static` task; the
    /// integrator implements [`StoreProvider`] for whatever owns the store
    /// (see the module-level wiring docs).
    pub store: Arc<dyn StoreProvider>,
    /// Shared handler registry resolved per claimed job by `jobType`.
    pub registry: Arc<JobHandlerRegistry>,
    /// Stable id baked into `claimed_by` / `last_error` rows for traceability
    /// (TS default `worker-<8 hex>`; the integrator supplies a stable one).
    pub worker_id: String,
    /// Poll cadence in ms. `None` ⇒ [`DEFAULT_POLL_INTERVAL_MS`].
    pub poll_interval_ms: Option<u64>,
    /// Jobs claimed per tick. `None` ⇒ [`DEFAULT_CLAIM_BATCH_SIZE`].
    pub claim_batch_size: Option<i64>,
}

/// The durable-job worker. Construct with [`JobWorker::new`]; drive it either
/// deterministically via [`JobWorker::poll_once`] (tests) or as a background
/// timer loop via [`JobWorker::start`] (production, integrator-gated).
pub struct JobWorker {
    store: Arc<dyn StoreProvider>,
    registry: Arc<JobHandlerRegistry>,
    worker_id: String,
    poll_interval_ms: u64,
    claim_batch_size: i64,
}

impl JobWorker {
    /// Build a worker from options.
    #[must_use]
    pub fn new(options: JobWorkerOptions) -> Self {
        Self {
            store: options.store,
            registry: options.registry,
            worker_id: options.worker_id,
            poll_interval_ms: options.poll_interval_ms.unwrap_or(DEFAULT_POLL_INTERVAL_MS),
            claim_batch_size: options.claim_batch_size.unwrap_or(DEFAULT_CLAIM_BATCH_SIZE),
        }
    }

    /// Stable worker id (TS `readonly workerId`).
    #[must_use]
    pub fn worker_id(&self) -> &str {
        &self.worker_id
    }

    /// Resolved poll interval (ms).
    #[must_use]
    pub fn poll_interval_ms(&self) -> u64 {
        self.poll_interval_ms
    }

    /// Resolved claim batch size.
    #[must_use]
    pub fn claim_batch_size(&self) -> i64 {
        self.claim_batch_size
    }

    /// Run exactly one tick: claim a batch (all job types, all apps —
    /// per-app scoping happens at dispatch, not at claim, matching TS) and
    /// dispatch each job serially. `now_ms` threads through every store call so
    /// the tick is fully deterministic. Returns the number of jobs processed.
    ///
    /// A failing claim/dispatch is logged (`frick.jobs.tick_error`) and
    /// swallowed — a tick failure never tears the worker down (TS `tick`'s
    /// catch). Errors here surface only when the claim query itself fails AND
    /// the caller wants to inspect it; the `Ok(count)` is the processed count.
    pub async fn poll_once(&self, now_ms: i64) -> usize {
        let store = self.store.store();
        // Claim across all job types and all apps (TS passes `undefined` for
        // both); per-app dispatch happens below via `store.forApp(job.appId)`.
        let claimed = match store
            .jobs()
            .claim(&self.worker_id, None, self.claim_batch_size, None, now_ms)
            .await
        {
            Ok(claimed) => claimed,
            Err(error) => {
                tracing::error!(
                    target: "frick.jobs.tick_error",
                    worker_id = %self.worker_id,
                    %error,
                    "job claim failed; will retry on the next tick",
                );
                return 0;
            }
        };
        let mut processed = 0;
        for job in claimed {
            self.run_job(store, job, now_ms).await;
            processed += 1;
        }
        processed
    }

    /// Dispatch one claimed job through its handler and apply the result.
    ///
    /// Per-app dispatch (FR-153): the handler resolves from the shared registry
    /// here; per-app handler registries are a later story (the registry is
    /// shared in this build). The job's app-scoped store view
    /// (`store.for_app(job.app_id)`) is handed to the handler so its writes
    /// land in the originating app's partition.
    async fn run_job(&self, store: &FrickStore, job: JobRow, now_ms: i64) {
        let Some(handler) = self.registry.resolve(&job.job_type) else {
            // No handler → non-retryable failure so the row dead-letters (TS
            // `jobs.unknownHandler`). Retrying without code changes can't help.
            self.fail_job(
                store,
                job.id,
                "jobs.unknownHandler",
                &format!("No handler registered for job type \"{}\"", job.job_type),
                false,
                now_ms,
            )
            .await;
            return;
        };

        let ctx = JobContext {
            tenant_id: job.tenant_id.clone(),
            app_id: job.app_id.clone(),
            job_id: job.id,
            job_type: job.job_type.clone(),
            payload: job.payload.clone(),
            attempt_count: job.attempt_count,
            store: store.for_app(Some(&job.app_id)),
        };

        match handler.handle(ctx).await {
            Ok(result) => self.complete_job(store, job.id, &result, now_ms).await,
            Err(error) => {
                tracing::error!(
                    target: "frick.jobs.handler_failed",
                    worker_id = %self.worker_id,
                    job_id = job.id,
                    job_type = %job.job_type,
                    error_code = %error.error_code,
                    error = %error.error_message,
                    retryable = error.retryable,
                    "job handler returned a failure",
                );
                self.fail_job(
                    store,
                    job.id,
                    &error.error_code,
                    &error.error_message,
                    error.retryable,
                    now_ms,
                )
                .await;
            }
        }
    }

    /// Complete a job (TS `applyResult` completed arm). A store error here is
    /// logged but never propagated — the next tick re-claims if the write was
    /// lost.
    async fn complete_job(&self, store: &FrickStore, job_id: i64, result: &Value, now_ms: i64) {
        if let Err(error) = store.jobs().complete(job_id, Some(result), now_ms).await {
            tracing::error!(
                target: "frick.jobs.complete_failed",
                worker_id = %self.worker_id,
                job_id,
                %error,
                "failed to mark job completed",
            );
        }
    }

    /// Fail a job (TS `applyResult` failed arm). The store applies the backoff /
    /// dead-letter decision per `retryable` and the attempt budget.
    async fn fail_job(
        &self,
        store: &FrickStore,
        job_id: i64,
        error_code: &str,
        error_message: &str,
        retryable: bool,
        now_ms: i64,
    ) {
        if let Err(error) = store
            .jobs()
            .fail(job_id, error_code, error_message, retryable, now_ms)
            .await
        {
            tracing::error!(
                target: "frick.jobs.fail_failed",
                worker_id = %self.worker_id,
                job_id,
                %error,
                "failed to mark job failed",
            );
        }
    }

    /// Start the background polling loop as a tokio task and return a
    /// [`JobWorkerHandle`] whose [`stop`](JobWorkerHandle::stop) (or drop)
    /// aborts it. The loop reads the system clock once per tick at the loop
    /// boundary, then calls [`Self::poll_once`].
    ///
    /// The integrator decides whether to call this: in TS the worker is enabled
    /// by default EXCEPT under a test runner (`server.ts:961-981`). This Rust
    /// API never auto-starts — `start` is explicit, so tests that only call
    /// [`Self::poll_once`] never spawn a timer.
    #[must_use]
    pub fn start(self: Arc<Self>) -> JobWorkerHandle {
        let period = std::time::Duration::from_millis(self.poll_interval_ms.max(1));
        tracing::info!(
            target: "frick.jobs.worker_start",
            worker_id = %self.worker_id,
            poll_interval_ms = self.poll_interval_ms,
            claim_batch_size = self.claim_batch_size,
            "frick.jobs.worker_start",
        );
        let task = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(period);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                ticker.tick().await;
                self.poll_once(now_ms_system()).await;
            }
        });
        JobWorkerHandle { task: Some(task) }
    }
}

/// Handle to the spawned worker loop (TS worker `stop()` semantics, simplified).
/// Dropping it aborts the loop; [`stop`](Self::stop) does so explicitly and
/// logs `frick.jobs.worker_stop`.
pub struct JobWorkerHandle {
    task: Option<tokio::task::JoinHandle<()>>,
}

impl JobWorkerHandle {
    /// Abort the polling loop. Idempotent.
    pub fn stop(mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
            tracing::info!(target: "frick.jobs.worker_stop", "frick.jobs.worker_stop");
        }
    }

    /// Whether the loop is still scheduled (has not been aborted).
    #[must_use]
    pub fn running(&self) -> bool {
        self.task.as_ref().is_some_and(|task| !task.is_finished())
    }
}

impl Drop for JobWorkerHandle {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}
