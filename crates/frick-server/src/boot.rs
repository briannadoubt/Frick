//! Server construction, listen, and graceful shutdown
//! (`createFrickServer` / `listen` / `close`, `src/server.ts`).

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use frick_protocol::FrickSchema;
use frick_store::{FrickStore, FrickStoreOptions, StoreError};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::config::{DbDriver, FrickConfig};
use crate::gateway::GatewayHub;
use crate::http::{AppState, AppStateInner, public_router};
use crate::jobs::{JobHandlerRegistry, JobWorker, JobWorkerHandle, JobWorkerOptions};
use crate::push::PUSH_DELIVER_JOB_TYPE;

/// A running (or constructed-but-not-yet-listening) server.
pub struct FrickServer {
    pub state: AppState,
    pub config: FrickConfig,
    /// The live WebSocket hub. Held here so it (and the store write-listener
    /// funnel it owns) outlive the server.
    pub gateway: Arc<GatewayHub>,
    /// The shared durable-job handler registry. Resolves `push.deliver` (FR-265)
    /// to the notification router, plus any app-provided handlers. Held so the
    /// worker (and tests) can resolve handlers from the same instance.
    pub jobs: Arc<JobHandlerRegistry>,
    shutdown: Option<oneshot::Sender<()>>,
    join: Option<tokio::task::JoinHandle<()>>,
    /// The durable-job worker loop, started in [`FrickServer::listen`] and
    /// aborted on [`FrickServer::close`] (or drop). `None` before `listen`.
    worker: Option<JobWorkerHandle>,
    bound_port: u16,
}

/// Construction failure.
#[derive(Debug, thiserror::Error)]
pub enum BootError {
    #[error("{0}")]
    Config(#[from] crate::config::FrickConfigError),
    #[error("{0}")]
    Store(#[from] StoreError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// Determinism + transport seams for [`create_frick_server_with_seams`]. The
/// public [`create_frick_server`] wires [`BootSeams::production`]; the boot-wiring
/// tests pass recording push transports + a fixed credential env so the whole
/// `enqueue → worker → router → adapter → transport` path is driven offline.
pub struct BootSeams {
    /// Push clock (JWT `iat`/`exp`, `attemptedAt`).
    pub push_clock: crate::push::SharedPushClock,
    /// Delivery-telemetry sink.
    pub push_telemetry: crate::push::SharedPushTelemetry,
    /// Per-tenant credential env (`FRICK_PUSH_CRED_KEY`).
    pub credential_env: Arc<dyn crate::push::credentials::CredentialEnv + Send + Sync>,
    /// The live APNs / FCM / Web Push HTTP transports.
    pub push_transports: crate::push::PushTransports,
}

impl BootSeams {
    /// Production seams: system clock, no-op telemetry, process credential env,
    /// and the live `reqwest` transports.
    #[must_use]
    pub fn production() -> Self {
        Self {
            push_clock: Arc::new(crate::push::SystemPushClock),
            push_telemetry: Arc::new(crate::push::NoopTelemetry),
            credential_env: Arc::new(crate::push::credentials::ProcessCredentialEnv),
            push_transports: crate::push::PushTransports::production(),
        }
    }
}

/// Build a server from config + schema (`createFrickServer`). The store is
/// opened and migrated here; call [`FrickServer::listen`] to bind the socket.
pub async fn create_frick_server(
    config: FrickConfig,
    schema: FrickSchema,
) -> Result<FrickServer, BootError> {
    create_frick_server_with_seams(config, schema, BootSeams::production()).await
}

/// [`create_frick_server`] with explicit push seams (recording transports + a
/// fixed credential env for the boot-wiring tests). Production calls
/// [`create_frick_server`], which passes [`BootSeams::production`].
///
/// # Panics
///
/// Panics if registering the `push.deliver` handler collides — impossible here
/// because the registry is freshly constructed and `push.deliver` is the only
/// handler registered at boot. The `expect` documents that boot invariant.
pub async fn create_frick_server_with_seams(
    config: FrickConfig,
    schema: FrickSchema,
    seams: BootSeams,
) -> Result<FrickServer, BootError> {
    let options = FrickStoreOptions {
        path: config.db_path.clone(),
        db_driver: match config.db_driver {
            DbDriver::Sqlite => frick_store::StoreDriverKind::Sqlite,
            DbDriver::Postgres => frick_store::StoreDriverKind::Postgres,
        },
        database_url: config.database_url.clone(),
        schema: Some(schema.clone()),
        idempotency_replay_window_ms: Some(config.idempotency_replay_window_ms),
        idempotency_key_retention_ms: Some(config.idempotency_key_retention_ms),
        ..FrickStoreOptions::default()
    };
    let store = Arc::new(FrickStore::open(options).await?);

    // Push subsystem (FR-265): build the adapter registry (APNs / FCM / Web Push
    // over the supplied transports, plus the default `test` adapter) and the
    // notification router over the shared store. Per-tenant credentials are read
    // lazily via the `FRICK_PUSH_CRED_KEY` env seam — a tenant with no creds for
    // a platform simply yields a `skipped` delivery, so this never panics.
    let push = crate::push::build_push_subsystem(
        Arc::clone(&store),
        seams.push_clock,
        seams.push_telemetry,
        seams.credential_env,
        seams.push_transports,
    );

    // Durable-job handler registry: register the `push.deliver` handler so a
    // push-deliver job claimed by the worker now resolves a REAL handler (the
    // notification router) instead of dead-lettering as `jobs.unknownHandler`.
    let mut jobs = JobHandlerRegistry::new();
    jobs.register(PUSH_DELIVER_JOB_TYPE, push.router.job_handler())
        .expect("push.deliver is the only handler registered for that type at boot");
    let jobs = Arc::new(jobs);

    let state = Arc::new(AppStateInner {
        config: config.clone(),
        store,
        schema,
        started_at: now_iso(),
        auth_limiter: std::sync::Mutex::new(crate::http::AuthLimiter::default()),
        projections: crate::projections::ProjectionRegistry::new(),
        search: crate::search::SearchRegistry::new(),
        push_registry: Arc::clone(&push.registry),
        notification_router: Arc::clone(&push.router),
    });

    // The gateway hub owns the live connections and the fan-out funnel. The
    // store's single write listener (FR-114) drives BOTH the gateway's
    // object/stream fan-out AND the projection engine (objectUpsert +
    // streamAppend; deletes never reach projections — map 05 §1.4).
    let gateway = GatewayHub::new(Arc::clone(&state));
    {
        let gateway_listener = gateway.write_listener();
        let projections = state.projections.clone();
        state.store.set_write_listener(Box::new(move |event| {
            gateway_listener(event);
            crate::projections::drive_projection_write(&projections, event);
        }));
    }
    // Search projector (FR-245, map 03 §13): the store applies the SearchOps
    // this registry derives from each object/stream write to its FTS tables, so
    // registered indexes stay in sync without the gateway in the loop. The
    // projector is pure (it never re-enters the store). Detached on close.
    {
        let search = state.search.clone();
        state
            .store
            .set_search_projector(Box::new(move |event| search.project_event(event)));
    }
    // Projection deltas fan out over the gateway to projection subscribers.
    {
        let weak = Arc::downgrade(&gateway);
        state
            .projections
            .set_delta_listener(Some(Box::new(move |notice| {
                if let Some(hub) = weak.upgrade() {
                    hub.publish_projection_delta(notice);
                }
            })));
    }

    Ok(FrickServer {
        state,
        config,
        gateway,
        jobs,
        shutdown: None,
        join: None,
        worker: None,
        bound_port: 0,
    })
}

impl FrickServer {
    /// Bind the socket and start serving in the background
    /// (`listen`). Returns the bound port (useful when `port == 0`).
    pub async fn listen(&mut self) -> Result<u16, BootError> {
        let address = format!("{}:{}", self.config.host, self.config.port);
        let listener = TcpListener::bind(&address).await?;
        let bound_port = listener.local_addr()?.port();
        self.bound_port = bound_port;

        let router = public_router(Arc::clone(&self.state))
            .merge(crate::auth_routes::auth_router(Arc::clone(&self.state)))
            .merge(crate::routes::dataplane_router(Arc::clone(&self.state)))
            .merge(crate::routes::admin::admin_router(Arc::clone(&self.state)))
            // Admin push credential + deliver routes (FR-265). Dispatches an
            // enqueue through the SAME `NotificationRouter` the job worker
            // resolves under `push.deliver`.
            .merge(crate::routes::admin_push::admin_push_router(
                Arc::clone(&self.state.notification_router),
                Arc::clone(&self.state),
            ))
            .merge(crate::routes::inspect::inspect_router(Arc::clone(
                &self.state,
            )))
            .merge(self.gateway.router())
            // CORS mirrors the TS `setCors`/preflight contract so browser
            // clients on a separate origin get the allowlist-driven
            // `Access-Control-*` headers (FR-255 review).
            .layer(crate::cors::cors_layer(&self.config.allowed_origins));
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        self.shutdown = Some(shutdown_tx);

        // Start the durable-job worker so enqueued `push.deliver` (and any
        // app-provided) jobs are actually claimed and dispatched. The worker
        // reads the store through `AppStateInner`'s `StoreProvider` impl and
        // resolves handlers from the shared registry; its loop is aborted on
        // `close` (or drop). Started here (not in `create_frick_server`) so a
        // constructed-but-not-listening server never spawns a timer.
        let worker = Arc::new(JobWorker::new(JobWorkerOptions {
            store: Arc::clone(&self.state) as Arc<dyn crate::jobs::StoreProvider>,
            registry: Arc::clone(&self.jobs),
            worker_id: format!("worker-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]),
            poll_interval_ms: None,
            claim_batch_size: None,
        }));
        self.worker = Some(worker.start());

        let join = tokio::spawn(async move {
            let server = axum::serve(listener, router);
            let graceful = server.with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            });
            if let Err(error) = graceful.await {
                tracing::error!(target: "frick.server", %error, "serve loop failed");
            }
        });
        self.join = Some(join);

        tracing::info!(
            target: "frick.server",
            schema_id = %self.state.schema.schema_id,
            schema_revision = self.state.schema.schema_revision,
            host = %self.config.host,
            port = bound_port,
            env = %self.config.env.as_str(),
            "frick.server.listen"
        );
        Ok(bound_port)
    }

    /// The port the server is bound to (0 before [`Self::listen`]).
    #[must_use]
    pub fn port(&self) -> u16 {
        self.bound_port
    }

    /// The base HTTP URL.
    #[must_use]
    pub fn http_url(&self) -> String {
        format!("http://{}:{}", self.config.host, self.bound_port)
    }

    /// Graceful shutdown (`close`): signal the serve loop and await it.
    /// Idempotent.
    pub async fn close(&mut self) {
        // Stop the durable-job worker loop first so no new job is claimed during
        // teardown.
        if let Some(worker) = self.worker.take() {
            worker.stop();
        }
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(join) = self.join.take() {
            let _ = join.await;
        }
        // Release any adapter-held resources (the APNs HTTP/2 sessions, etc.).
        self.state.push_registry.close_all().await;
        // Detach the write-listener funnel so the store no longer holds the
        // gateway's closure.
        self.state.store.clear_write_listener();
        // Detach the search projector so the store no longer holds the search
        // registry's closure.
        self.state.store.clear_search_projector();
        tracing::info!(target: "frick.server", "frick.server.closed");
    }
}

/// Current time as an ISO-8601 UTC millisecond string. Used for the
/// `startedAt` log/inspection field.
fn now_iso() -> String {
    let total_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
    iso_from_epoch_ms(total_ms)
}

/// Format an epoch-millisecond instant as a `Date.toISOString`-compatible UTC
/// string. Shared with the auth-route session minting.
#[must_use]
pub fn iso_from_epoch_ms(total_ms: i64) -> String {
    let (days, ms_of_day) = (
        total_ms.div_euclid(86_400_000),
        total_ms.rem_euclid(86_400_000),
    );
    let (year, month, day) = civil_from_days(days);
    let (hour, minute) = (ms_of_day / 3_600_000, (ms_of_day / 60_000) % 60);
    let (second, milli) = ((ms_of_day / 1_000) % 60, ms_of_day % 1_000);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z")
}

/// Days since 1970-01-01 → (year, month, day). Howard Hinnant's algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = u32::try_from(doy - (153 * mp + 2) / 5 + 1).unwrap_or(1);
    let month = u32::try_from(if mp < 10 { mp + 3 } else { mp - 9 }).unwrap_or(1);
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::load_frick_config;
    use std::collections::BTreeMap;

    fn test_config() -> FrickConfig {
        let mut env = BTreeMap::new();
        env.insert("FRICK_ENV".to_string(), "test".to_string());
        env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
        env.insert("FRICK_PORT".to_string(), "0".to_string());
        load_frick_config(&env).unwrap()
    }

    #[tokio::test]
    async fn server_boots_listens_and_serves_health() {
        let schema = frick_protocol::foundation_schema();
        let mut server = create_frick_server(test_config(), schema).await.unwrap();
        let port = server.listen().await.unwrap();
        assert!(port > 0);

        let body = reqwest_get(&format!("http://127.0.0.1:{port}/health")).await;
        assert!(body.contains("\"ok\":true"), "health body was {body}");

        let ready = reqwest_get(&format!("http://127.0.0.1:{port}/ready")).await;
        assert!(
            ready.contains("\"status\":\"ready\""),
            "ready body was {ready}"
        );

        server.close().await;
    }

    /// The Postgres driver is now wired (FR-242): construction reaches the PG
    /// migration runner, which fails against an unreachable database rather
    /// than being rejected up front. (Live PG behavior is covered by
    /// `frick-store`'s `FRICK_DATABASE_URL`-gated integration tests.)
    #[tokio::test]
    async fn postgres_driver_connects_and_fails_without_a_reachable_db() {
        let mut env = BTreeMap::new();
        env.insert("FRICK_DB_DRIVER".to_string(), "postgres".to_string());
        // Port 1 is reliably connection-refused (fast, deterministic).
        env.insert(
            "FRICK_DATABASE_URL".to_string(),
            "postgres://postgres@127.0.0.1:1/frick_unreachable".to_string(),
        );
        let config = load_frick_config(&env).unwrap();
        let result = create_frick_server(config, frick_protocol::foundation_schema()).await;
        assert!(
            result.is_err(),
            "an unreachable Postgres must fail construction"
        );
    }

    /// Minimal blocking HTTP GET (avoids pulling a full client dep into tests).
    async fn reqwest_get(url: &str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let url = url.strip_prefix("http://").unwrap();
        let (host_port, path) = url.split_once('/').map_or((url, ""), |(h, p)| (h, p));
        let mut stream = tokio::net::TcpStream::connect(host_port).await.unwrap();
        let request =
            format!("GET /{path} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }
}
