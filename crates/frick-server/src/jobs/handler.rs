//! Job-handler trait, context, result, and the per-`jobType` handler registry
//! (`apps/server/src/jobs/registry.ts`; map 05 §2.8).
//!
//! In the library-embed model job handlers are APP-PROVIDED: an app implements
//! [`JobHandler`] and registers it under a `jobType` string at boot. The
//! foundation schema ships no handlers, so the worker's tests register a test
//! handler. The framework job types `push.deliver` / `blob.process` /
//! `blob.gc` are DEFERRED (push = FR-248, blob GC later) and are NOT
//! implemented here — but the registry and worker fully support
//! app-registered handlers exactly as the TS version does.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use frick_protocol::Value;
use frick_store::FrickStore;

/// The future a [`JobHandler::handle`] call returns. Boxed + `Send` so the
/// worker can dispatch from a `'static` polling task without the unstable
/// `async fn in trait` + `Send` bound machinery (no `async-trait` dep).
pub type JobHandlerFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, JobError>> + Send + 'a>>;

/// Context handed to a [`JobHandler::handle`] call (TS `FrickJobContext`,
/// `registry.ts:17-32`). Everything a handler needs to do its work.
///
/// `store` is the job's app-scoped facade view (`store.forApp(job.appId)` in
/// TS): a handler's legacy writes default to the originating app's partition,
/// not `_default`. For the single-app default `app_id == "_default"`, so the
/// view is the store itself.
pub struct JobContext<'a> {
    /// Tenant the job belongs to.
    pub tenant_id: String,
    /// App partition the job belongs to (FR-153). `_default` for single-app.
    pub app_id: String,
    /// The job row's primary key.
    pub job_id: i64,
    /// The registered `jobType` this handler was resolved for.
    pub job_type: String,
    /// The decoded job payload (msgpack → [`Value`]).
    pub payload: Value,
    /// Post-claim attempt count (incremented at claim time by the store).
    pub attempt_count: i64,
    /// App-scoped store facade. Held as an owned [`AppScopedStore`] over the
    /// borrowed [`FrickStore`]; reads/writes delegate to the underlying store.
    ///
    /// [`AppScopedStore`]: frick_store::AppScopedStore
    pub store: frick_store::AppScopedStore<'a>,
}

impl JobContext<'_> {
    /// The underlying (un-scoped) store, for handlers that need cross-app
    /// reads. Prefer [`Self::store`] for writes so they land in the job's app.
    #[must_use]
    pub fn raw_store(&self) -> &FrickStore {
        self.store.store()
    }
}

/// Failure returned by a [`JobHandler`] (the `failed` arm of TS
/// `FrickJobResult`, `registry.ts:46-52`). The worker translates this into a
/// `store.jobs().fail(...)` call; `retryable` decides re-arm-with-backoff vs.
/// dead-letter (the store applies the backoff / budget check).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobError {
    /// Stable machine code persisted to `last_error_code` (TS default
    /// `"server.internal"` when a handler omits it; see the worker).
    pub error_code: String,
    /// Human-readable detail persisted to `last_error_message`.
    pub error_message: String,
    /// When `true` the store re-arms with backoff (until the attempt budget is
    /// exhausted); when `false` the job dead-letters immediately.
    pub retryable: bool,
}

impl JobError {
    /// A retryable failure (`server.internal` semantics): the store re-arms the
    /// job with backoff until `max_attempts` is reached.
    #[must_use]
    pub fn retryable(error_code: impl Into<String>, error_message: impl Into<String>) -> Self {
        Self {
            error_code: error_code.into(),
            error_message: error_message.into(),
            retryable: true,
        }
    }

    /// A non-retryable failure: the store dead-letters the job immediately.
    #[must_use]
    pub fn fatal(error_code: impl Into<String>, error_message: impl Into<String>) -> Self {
        Self {
            error_code: error_code.into(),
            error_message: error_message.into(),
            retryable: false,
        }
    }
}

/// An app-provided background-job handler. Boxed `Send + Sync` so the registry
/// can hold many of them behind one `Arc`-shared map and the worker can
/// dispatch from a `'static` polling task.
///
/// `handle` returns the completed-job result on `Ok` (becomes the row's
/// `packed` result) or a [`JobError`] on `Err` (the store re-arms with backoff
/// or dead-letters). A handler that returns `Ok(Value::Nil)` completes with a
/// nil result, mirroring a TS handler returning `{ status: "completed" }` with
/// no `result`.
pub trait JobHandler: Send + Sync {
    /// Run one job. `ctx` carries the payload, identifiers, attempt count, and
    /// an app-scoped store view. Implementations typically write the body as
    /// `Box::pin(async move { ... })`.
    fn handle<'a>(&'a self, ctx: JobContext<'a>) -> JobHandlerFuture<'a>;
}

/// Boxed, shareable handler. `Arc` so the worker can clone a handle out of the
/// registry and dispatch without holding a lock across the `.await`.
pub type SharedJobHandler = Arc<dyn JobHandler>;

/// Raised by [`JobHandlerRegistry::register`] when a `jobType` is registered
/// twice (TS `DuplicateJobHandlerError`, `registry.ts:62-68`). Same message and
/// `reason` so boot diagnostics match byte-for-byte.
#[derive(Debug, Clone, thiserror::Error)]
#[error("A handler is already registered for job type \"{job_type}\"")]
pub struct DuplicateJobHandlerError {
    /// The duplicate `jobType`.
    pub job_type: String,
}

impl DuplicateJobHandlerError {
    /// Stable machine-readable reason (TS `reason = "duplicateJobHandler"`).
    #[must_use]
    pub const fn reason(&self) -> &'static str {
        "duplicateJobHandler"
    }
}

/// Typed job-handler registry keyed by `jobType` (TS `FrickJobRegistry`,
/// `registry.ts:56-86`). Apps register one handler per type at boot; the worker
/// resolves handlers by string name when claiming jobs.
///
/// Registration throws loudly on a duplicate `jobType`: silently shadowing a
/// handler is an easy way to mis-route work, so the framework fails at boot
/// rather than at run time.
#[derive(Default)]
pub struct JobHandlerRegistry {
    handlers: HashMap<String, SharedJobHandler>,
}

impl JobHandlerRegistry {
    /// An empty registry.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register `handler` under `job_type`. Returns
    /// [`DuplicateJobHandlerError`] when a handler already exists for that type
    /// (TS `register` throws).
    pub fn register(
        &mut self,
        job_type: impl Into<String>,
        handler: SharedJobHandler,
    ) -> Result<(), DuplicateJobHandlerError> {
        let job_type = job_type.into();
        if self.handlers.contains_key(&job_type) {
            return Err(DuplicateJobHandlerError { job_type });
        }
        self.handlers.insert(job_type, handler);
        Ok(())
    }

    /// Resolve the handler for a `jobType`, or `None` when none is registered
    /// (TS `resolve`). The worker treats `None` as a non-retryable failure.
    #[must_use]
    pub fn resolve(&self, job_type: &str) -> Option<SharedJobHandler> {
        self.handlers.get(job_type).map(Arc::clone)
    }

    /// Registered `jobType` names, **sorted** (TS `list()`,
    /// `registry.ts:82-84`). Surfaced by `/_frick/inspect/jobs`.
    #[must_use]
    pub fn list(&self) -> Vec<String> {
        let mut names: Vec<String> = self.handlers.keys().cloned().collect();
        names.sort();
        names
    }

    /// Whether a handler is registered for `job_type`.
    #[must_use]
    pub fn contains(&self, job_type: &str) -> bool {
        self.handlers.contains_key(job_type)
    }
}
