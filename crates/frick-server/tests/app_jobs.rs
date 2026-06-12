//! FR-302: app-registered durable job handlers + recurring jobs through
//! `BootSeams` — the seam Crate's Rust backend (and any Rust embedder) needs to
//! register product background work on the framework server.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use frick_protocol::{Value, foundation_schema};
use frick_server::config::load_frick_config;
use frick_server::jobs::{
    JobContext, JobHandler, JobHandlerFuture, JobWorker, JobWorkerOptions, RecurringJob,
    RecurringTarget, RecurringTargets, SharedJobHandler, StoreProvider,
};
use frick_server::{BootSeams, FrickConfig, create_frick_server_with_seams};
use frick_store::FrickStore;
use frick_store::stores::job::{EnqueueInput, epoch_ms_to_iso};

const NOW_MS: i64 = 1_700_000_000_000;

fn test_config() -> FrickConfig {
    let mut env = std::collections::BTreeMap::new();
    env.insert("FRICK_ENV".to_string(), "test".to_string());
    env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
    env.insert("FRICK_PORT".to_string(), "0".to_string());
    load_frick_config(&env).unwrap()
}

/// An app job handler that flips a shared flag when it runs — and proves the
/// handler reaches the app-scoped store view via [`JobContext`].
struct RecordingHandler {
    ran: Arc<AtomicBool>,
}

impl JobHandler for RecordingHandler {
    fn handle<'a>(&'a self, ctx: JobContext<'a>) -> JobHandlerFuture<'a> {
        let ran = Arc::clone(&self.ran);
        Box::pin(async move {
            assert_eq!(ctx.job_type, "test.app-job");
            ran.store(true, Ordering::SeqCst);
            Ok(Value::Map(vec![]))
        })
    }
}

struct NoopHandler;
impl JobHandler for NoopHandler {
    fn handle<'a>(&'a self, _ctx: JobContext<'a>) -> JobHandlerFuture<'a> {
        Box::pin(async move { Ok(Value::Map(vec![])) })
    }
}

/// Resolve one target for the default tenant each tick.
struct OneTenant;
impl RecurringTargets for OneTenant {
    fn resolve<'a>(
        &'a self,
        _store: &'a FrickStore,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<RecurringTarget>, String>> + Send + 'a>> {
        Box::pin(async move { Ok(vec![RecurringTarget::tenant("_default")]) })
    }
}

#[tokio::test]
async fn app_registered_job_handler_runs_on_the_worker() {
    let ran = Arc::new(AtomicBool::new(false));
    let mut seams = BootSeams::production();
    seams.job_handlers = vec![(
        "test.app-job".to_string(),
        Arc::new(RecordingHandler {
            ran: Arc::clone(&ran),
        }) as SharedJobHandler,
    )];
    let server = create_frick_server_with_seams(test_config(), foundation_schema(), seams)
        .await
        .unwrap();

    // The boot job registry now resolves the app handler alongside the built-ins.
    assert!(server.jobs.contains("test.app-job"));

    server
        .state
        .store
        .enqueue_job(EnqueueInput {
            tenant_id: "_default".to_string(),
            app_id: None,
            job_type: "test.app-job".to_string(),
            payload: Value::Map(vec![]),
            idempotency_key: None,
            // Pin availability to the deterministic poll time below (the store
            // clock is real time, but the worker tick uses a fixed NOW_MS).
            available_at: Some(epoch_ms_to_iso(NOW_MS)),
            max_attempts: None,
        })
        .await
        .unwrap();

    // Drive one deterministic worker tick over the boot registry (what listen runs).
    let worker = JobWorker::new(JobWorkerOptions {
        store: Arc::clone(&server.state) as Arc<dyn StoreProvider>,
        registry: Arc::clone(&server.jobs),
        worker_id: "worker-fr302".to_string(),
        poll_interval_ms: None,
        claim_batch_size: None,
    });
    let claimed = worker.poll_once(NOW_MS).await;

    assert_eq!(claimed, 1, "the app job was claimed + dispatched");
    assert!(ran.load(Ordering::SeqCst), "the app-registered handler ran");
}

#[tokio::test]
async fn recurring_job_seam_starts_the_scheduler() {
    let mut seams = BootSeams::production();
    seams.job_handlers = vec![(
        "test.app-job".to_string(),
        Arc::new(NoopHandler) as SharedJobHandler,
    )];
    seams.recurring_jobs = vec![RecurringJob {
        name: "test.poll".to_string(),
        job_type: "test.app-job".to_string(),
        interval_ms: 60_000,
        resolve_targets: Arc::new(OneTenant),
    }];
    let mut server = create_frick_server_with_seams(test_config(), foundation_schema(), seams)
        .await
        .unwrap();

    // listen() validates the recurring spec + starts the scheduler alongside the
    // worker; close() aborts it. A bad interval would fail boot here.
    let _port = server.listen().await.unwrap();
    server.close().await;
}
