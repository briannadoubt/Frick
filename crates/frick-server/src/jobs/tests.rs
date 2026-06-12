//! Tests for the job worker + recurring scheduler, driven deterministically
//! against an in-memory [`FrickStore`] via `poll_once` / `tick_once` (no
//! wall-clock timers).

use std::sync::{Arc, Mutex};

use frick_protocol::Value;
use frick_store::facade::seam::{FixedClock, SeededIdGen};
use frick_store::stores::job::{
    EnqueueInput, JobStatus, ListJobsFilter, recurring_idempotency_key, recurring_window_start,
};
use frick_store::{FrickStore, FrickStoreOptions};

use super::handler::{JobContext, JobError, JobHandler, JobHandlerFuture, JobHandlerRegistry};
use super::recurring::{
    RecurringJob, RecurringRegistry, RecurringScheduler, RecurringSchedulerOptions,
    RecurringTarget, RecurringTargets,
};
use super::worker::{JobWorker, JobWorkerOptions};
use super::{ArcStoreProvider, StoreProvider};

const NOW_MS: i64 = 1_000_000_000_000; // 2001-09-09T01:46:40.000Z

/// Recorded `(job_id, attempt_count)` per handler invocation.
type InvocationLog = Arc<Mutex<Vec<(i64, i64)>>>;

/// An in-memory store with the clock PINNED at [`NOW_MS`] so `enqueue_job`
/// (which reads the facade clock seam) stamps `available_at = NOW_MS`, letting
/// the worker claim at `NOW_MS` deterministically. The worker / scheduler
/// themselves thread `now_ms` into every store call, so they don't depend on
/// this clock — it only governs the test's setup enqueues.
async fn memory_store() -> Arc<FrickStore> {
    Arc::new(
        FrickStore::open_with_seams(
            FrickStoreOptions::memory(),
            Box::new(FixedClock::new(NOW_MS)),
            Box::new(SeededIdGen::new()),
        )
        .await
        .expect("open in-memory store"),
    )
}

fn provider(store: &Arc<FrickStore>) -> Arc<dyn StoreProvider> {
    Arc::new(ArcStoreProvider(Arc::clone(store)))
}

fn map(entries: &[(&str, Value)]) -> Value {
    Value::Map(
        entries
            .iter()
            .map(|(k, v)| ((*k).into(), v.clone()))
            .collect(),
    )
}

fn enqueue_input(tenant_id: &str, job_type: &str, payload: Value) -> EnqueueInput {
    EnqueueInput {
        tenant_id: tenant_id.to_string(),
        app_id: None,
        job_type: job_type.to_string(),
        payload,
        idempotency_key: None,
        available_at: None,
        max_attempts: None,
    }
}

/// A test handler that records (jobId, attemptCount) per invocation and returns
/// a configurable outcome.
enum Outcome {
    /// Complete with this result value.
    Complete(Value),
    /// Fail with this error (retryable / fatal per the JobError).
    Fail(JobError),
    /// Panic-free "throw": return a retryable error (what the worker would do
    /// for a thrown handler; here the handler just returns it directly).
    Throw,
}

struct RecordingHandler {
    invocations: InvocationLog,
    outcome: Mutex<Outcome>,
}

impl RecordingHandler {
    fn new(outcome: Outcome) -> (Arc<Self>, InvocationLog) {
        let invocations = Arc::new(Mutex::new(Vec::new()));
        let handler = Arc::new(Self {
            invocations: Arc::clone(&invocations),
            outcome: Mutex::new(outcome),
        });
        (handler, invocations)
    }
}

impl JobHandler for RecordingHandler {
    fn handle<'a>(&'a self, ctx: JobContext<'a>) -> JobHandlerFuture<'a> {
        Box::pin(async move {
            self.invocations
                .lock()
                .unwrap()
                .push((ctx.job_id, ctx.attempt_count));
            match &*self.outcome.lock().unwrap() {
                Outcome::Complete(value) => Ok(value.clone()),
                Outcome::Fail(error) => Err(error.clone()),
                Outcome::Throw => Err(JobError::retryable("server.internal", "boom")),
            }
        })
    }
}

fn registry_with(job_type: &str, handler: Arc<RecordingHandler>) -> Arc<JobHandlerRegistry> {
    let mut registry = JobHandlerRegistry::new();
    registry.register(job_type, handler).expect("register");
    Arc::new(registry)
}

fn worker(
    store: &Arc<FrickStore>,
    registry: Arc<JobHandlerRegistry>,
    batch: Option<i64>,
) -> JobWorker {
    JobWorker::new(JobWorkerOptions {
        store: provider(store),
        registry,
        worker_id: "worker-test".to_string(),
        poll_interval_ms: None,
        claim_batch_size: batch,
    })
}

#[test]
fn registry_rejects_duplicate_job_types_and_sorts_list() {
    let (a, _) = RecordingHandler::new(Outcome::Complete(Value::Nil));
    let (b, _) = RecordingHandler::new(Outcome::Complete(Value::Nil));
    let mut registry = JobHandlerRegistry::new();
    registry.register("zeta", a).unwrap();
    registry.register("alpha", b.clone()).unwrap();
    let err = registry
        .register("zeta", b)
        .expect_err("duplicate must throw");
    assert_eq!(err.job_type, "zeta");
    assert_eq!(err.reason(), "duplicateJobHandler");
    assert_eq!(
        err.to_string(),
        "A handler is already registered for job type \"zeta\""
    );
    assert_eq!(
        registry.list(),
        vec!["alpha".to_string(), "zeta".to_string()]
    );
    assert!(registry.contains("alpha"));
    assert!(!registry.contains("missing"));
}

#[tokio::test]
async fn worker_runs_the_handler_and_completes_the_job() {
    let store = memory_store().await;
    let (handler, invocations) =
        RecordingHandler::new(Outcome::Complete(map(&[("ok", true.into())])));
    let registry = registry_with("TestJob", Arc::clone(&handler));
    let worker = worker(&store, registry, None);

    let job = store
        .enqueue_job(enqueue_input(
            "_default",
            "TestJob",
            map(&[("hi", "there".into())]),
        ))
        .await
        .unwrap();

    let processed = worker.poll_once(NOW_MS).await;
    assert_eq!(processed, 1, "one job processed");

    // The handler ran exactly once, seeing the post-claim attempt count (1).
    let recorded = invocations.lock().unwrap().clone();
    assert_eq!(recorded, vec![(job.id, 1)]);

    // The job is completed and its result overwrote the payload.
    let row = store
        .jobs()
        .get_by_id(job.id, None, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.status, JobStatus::Completed);
    assert!(row.completed_at.is_some());
    assert_eq!(row.payload, map(&[("ok", true.into())]));
}

#[tokio::test]
async fn poll_once_on_an_empty_queue_does_nothing() {
    let store = memory_store().await;
    let (handler, invocations) = RecordingHandler::new(Outcome::Complete(Value::Nil));
    let registry = registry_with("TestJob", handler);
    let worker = worker(&store, registry, None);

    assert_eq!(worker.poll_once(NOW_MS).await, 0);
    assert!(invocations.lock().unwrap().is_empty());
}

#[tokio::test]
async fn unknown_job_type_dead_letters_without_a_handler() {
    let store = memory_store().await;
    // Register a handler for a DIFFERENT type so the registry is non-empty but
    // can't resolve the enqueued job.
    let (handler, invocations) = RecordingHandler::new(Outcome::Complete(Value::Nil));
    let registry = registry_with("OtherJob", handler);
    let worker = worker(&store, registry, None);

    let job = store
        .enqueue_job(enqueue_input("_default", "NoHandler", Value::Nil))
        .await
        .unwrap();
    worker.poll_once(NOW_MS).await;

    assert!(invocations.lock().unwrap().is_empty(), "handler never ran");
    let row = store
        .jobs()
        .get_by_id(job.id, None, None)
        .await
        .unwrap()
        .unwrap();
    // No handler → non-retryable failure → dead-lettered immediately.
    assert_eq!(row.status, JobStatus::DeadLettered);
    assert_eq!(row.last_error_code.as_deref(), Some("jobs.unknownHandler"));
    assert_eq!(
        row.last_error_message.as_deref(),
        Some("No handler registered for job type \"NoHandler\"")
    );
}

#[tokio::test]
async fn retryable_failure_rearms_with_backoff_then_dead_letters() {
    use frick_store::stores::job::job_backoff_ms;

    let store = memory_store().await;
    let (handler, invocations) =
        RecordingHandler::new(Outcome::Fail(JobError::retryable("test.transient", "boom")));
    let registry = registry_with("Flaky", Arc::clone(&handler));
    let worker = worker(&store, registry, None);

    // max_attempts = 2 so the second failure exhausts the budget.
    let mut input = enqueue_input("_default", "Flaky", Value::Nil);
    input.max_attempts = Some(2);
    let job = store.enqueue_job(input).await.unwrap();

    // First poll: claim (attempt → 1), handler fails retryably, store re-arms
    // with backoff(1) = 60s.
    worker.poll_once(NOW_MS).await;
    let row = store
        .jobs()
        .get_by_id(job.id, None, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.status, JobStatus::Ready, "re-armed for retry");
    assert_eq!(row.last_error_code.as_deref(), Some("test.transient"));
    assert_eq!(
        row.available_at,
        frick_store::stores::job::epoch_ms_to_iso(NOW_MS + job_backoff_ms(1)),
        "backed off by jobBackoffMs(1)",
    );

    // Backed off: a poll at the same instant claims nothing.
    assert_eq!(worker.poll_once(NOW_MS).await, 0);

    // Advance past the backoff: second claim (attempt → 2), fails again, budget
    // now exhausted → dead-letter.
    let later = NOW_MS + job_backoff_ms(1);
    worker.poll_once(later).await;
    let row = store
        .jobs()
        .get_by_id(job.id, None, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.status, JobStatus::DeadLettered, "budget exhausted");

    // The handler ran on both claims, seeing attempt counts 1 then 2.
    assert_eq!(
        invocations.lock().unwrap().clone(),
        vec![(job.id, 1), (job.id, 2)]
    );
}

#[tokio::test]
async fn fatal_failure_dead_letters_on_the_first_attempt() {
    let store = memory_store().await;
    let (handler, _) =
        RecordingHandler::new(Outcome::Fail(JobError::fatal("test.fatal", "no retry")));
    let registry = registry_with("Fatal", handler);
    let worker = worker(&store, registry, None);

    let mut input = enqueue_input("_default", "Fatal", Value::Nil);
    input.max_attempts = Some(10); // budget irrelevant for a non-retryable fail
    let job = store.enqueue_job(input).await.unwrap();
    worker.poll_once(NOW_MS).await;

    let row = store
        .jobs()
        .get_by_id(job.id, None, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.status, JobStatus::DeadLettered);
    assert_eq!(row.last_error_code.as_deref(), Some("test.fatal"));
}

#[tokio::test]
async fn handler_throw_is_a_retryable_failure() {
    let store = memory_store().await;
    let (handler, _) = RecordingHandler::new(Outcome::Throw);
    let registry = registry_with("Throws", handler);
    let worker = worker(&store, registry, None);

    let mut input = enqueue_input("_default", "Throws", Value::Nil);
    input.max_attempts = Some(5);
    let job = store.enqueue_job(input).await.unwrap();
    worker.poll_once(NOW_MS).await;

    let row = store
        .jobs()
        .get_by_id(job.id, None, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.status, JobStatus::Ready, "re-armed: throw is retryable");
    assert_eq!(row.last_error_code.as_deref(), Some("server.internal"));
}

#[tokio::test]
async fn worker_drains_a_batch_serially() {
    let store = memory_store().await;
    let (handler, invocations) = RecordingHandler::new(Outcome::Complete(Value::Nil));
    let registry = registry_with("Batch", Arc::clone(&handler));
    // Batch size 3, enqueue 5 → first poll drains 3, second drains the rest.
    let worker = worker(&store, registry, Some(3));

    for i in 0..5 {
        store
            .enqueue_job(enqueue_input("_default", "Batch", map(&[("i", i.into())])))
            .await
            .unwrap();
    }

    assert_eq!(worker.poll_once(NOW_MS).await, 3);
    assert_eq!(worker.poll_once(NOW_MS).await, 2);
    assert_eq!(worker.poll_once(NOW_MS).await, 0);
    assert_eq!(invocations.lock().unwrap().len(), 5);

    let completed = store
        .jobs()
        .list(&ListJobsFilter {
            status: Some(JobStatus::Completed),
            ..ListJobsFilter::default()
        })
        .await
        .unwrap();
    assert_eq!(completed.len(), 5);
}

// ---- recurring scheduler ----------------------------------------------------

/// A `RecurringTargets` returning a fixed list (or an error to exercise the
/// resolve-failure path).
struct FixedTargets(Result<Vec<RecurringTarget>, String>);

impl RecurringTargets for FixedTargets {
    fn resolve<'a>(
        &'a self,
        _store: &'a FrickStore,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Vec<RecurringTarget>, String>> + Send + 'a>,
    > {
        let result = self.0.clone();
        Box::pin(async move { result })
    }
}

fn scheduler(store: &Arc<FrickStore>, jobs: Vec<RecurringJob>) -> RecurringScheduler {
    let registry = Arc::new(RecurringRegistry::new(jobs).expect("valid intervals"));
    RecurringScheduler::new(RecurringSchedulerOptions {
        store: provider(store),
        registry,
        tick_interval_ms: None,
    })
}

#[test]
fn registry_rejects_intervals_below_the_minimum() {
    let result = RecurringRegistry::new(vec![RecurringJob {
        name: "too-fast".to_string(),
        job_type: "j".to_string(),
        interval_ms: 59_999,
        resolve_targets: Arc::new(FixedTargets(Ok(vec![]))),
    }]);
    let Err(err) = result else {
        panic!("below minimum must reject");
    };
    assert_eq!(err.name, "too-fast");
    assert_eq!(err.got, 59_999);
    assert_eq!(
        err.to_string(),
        "Recurring job \"too-fast\" intervalMs must be >= 60000 (got 59999)"
    );
}

#[tokio::test]
async fn recurring_tick_enqueues_with_the_window_idempotency_key_and_dedupes() {
    let store = memory_store().await;
    let interval_ms = 60_000;
    let scheduler = scheduler(
        &store,
        vec![RecurringJob {
            name: "poll".to_string(),
            job_type: "poll.job".to_string(),
            interval_ms,
            resolve_targets: Arc::new(FixedTargets(Ok(vec![RecurringTarget::tenant("tenant-1")]))),
        }],
    );

    // First tick enqueues one job for the current window.
    assert_eq!(scheduler.tick_once(NOW_MS).await, 1);
    let window = recurring_window_start(NOW_MS, interval_ms);
    let expected_key = recurring_idempotency_key("poll", None, "tenant-1", window);

    let jobs = store
        .jobs()
        .list(&ListJobsFilter {
            job_type: Some("poll.job".to_string()),
            ..ListJobsFilter::default()
        })
        .await
        .unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(
        jobs[0].idempotency_key.as_deref(),
        Some(expected_key.as_str())
    );
    assert_eq!(
        jobs[0].available_at,
        frick_store::stores::job::epoch_ms_to_iso(window),
        "available_at = window start",
    );

    // A second tick later in the SAME window is a no-op (dedupe on the key).
    assert_eq!(
        scheduler.tick_once(NOW_MS + 1_000).await,
        1,
        "dedupe returns existing row"
    );
    let jobs = store
        .jobs()
        .list(&ListJobsFilter {
            job_type: Some("poll.job".to_string()),
            ..ListJobsFilter::default()
        })
        .await
        .unwrap();
    assert_eq!(jobs.len(), 1, "no new row within the window");

    // The NEXT window mints a fresh key → a fresh row.
    let next = window + interval_ms;
    scheduler.tick_once(next).await;
    let jobs = store
        .jobs()
        .list(&ListJobsFilter {
            job_type: Some("poll.job".to_string()),
            ..ListJobsFilter::default()
        })
        .await
        .unwrap();
    assert_eq!(jobs.len(), 2, "a new window enqueues a new job");
}

#[tokio::test]
async fn recurring_tick_scopes_the_idempotency_key_by_app() {
    let store = memory_store().await;
    let interval_ms = 60_000;
    let scheduler = scheduler(
        &store,
        vec![RecurringJob {
            name: "sweep".to_string(),
            job_type: "sweep.job".to_string(),
            interval_ms,
            resolve_targets: Arc::new(FixedTargets(Ok(vec![
                RecurringTarget {
                    tenant_id: "tenant-1".to_string(),
                    app_id: Some("app-a".to_string()),
                    payload: None,
                },
                RecurringTarget {
                    tenant_id: "tenant-1".to_string(),
                    app_id: Some("app-b".to_string()),
                    payload: None,
                },
            ]))),
        }],
    );

    // Two apps, same tenant + window → two independent jobs (per-app key).
    assert_eq!(scheduler.tick_once(NOW_MS).await, 2);
    let window = recurring_window_start(NOW_MS, interval_ms);
    let jobs = store
        .jobs()
        .list(&ListJobsFilter {
            job_type: Some("sweep.job".to_string()),
            ..ListJobsFilter::default()
        })
        .await
        .unwrap();
    assert_eq!(jobs.len(), 2);
    let keys: Vec<String> = jobs
        .iter()
        .filter_map(|row| row.idempotency_key.clone())
        .collect();
    assert!(keys.contains(&recurring_idempotency_key(
        "sweep",
        Some("app-a"),
        "tenant-1",
        window
    )));
    assert!(keys.contains(&recurring_idempotency_key(
        "sweep",
        Some("app-b"),
        "tenant-1",
        window
    )));
}

#[tokio::test]
async fn recurring_tick_skips_a_job_when_resolve_targets_fails() {
    let store = memory_store().await;
    let scheduler = scheduler(
        &store,
        vec![RecurringJob {
            name: "broken".to_string(),
            job_type: "broken.job".to_string(),
            interval_ms: 60_000,
            resolve_targets: Arc::new(FixedTargets(Err("resolver blew up".to_string()))),
        }],
    );
    // The tick logs + skips; nothing enqueued, no panic.
    assert_eq!(scheduler.tick_once(NOW_MS).await, 0);
    let jobs = store.jobs().list(&ListJobsFilter::default()).await.unwrap();
    assert!(jobs.is_empty());
}

#[tokio::test]
async fn recurring_payload_defaults_to_an_empty_map() {
    let store = memory_store().await;
    let scheduler = scheduler(
        &store,
        vec![RecurringJob {
            name: "n".to_string(),
            job_type: "n.job".to_string(),
            interval_ms: 60_000,
            resolve_targets: Arc::new(FixedTargets(Ok(vec![RecurringTarget::tenant("t")]))),
        }],
    );
    scheduler.tick_once(NOW_MS).await;
    let jobs = store.jobs().list(&ListJobsFilter::default()).await.unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].payload, Value::Map(Vec::new()));
}
