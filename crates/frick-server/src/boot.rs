//! Server construction, listen, and graceful shutdown
//! (`createFrickServer` / `listen` / `close`, `src/server.ts`).

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use frick_protocol::FrickSchema;
use frick_store::{FrickStore, FrickStoreOptions, StoreError};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::apps::AppDefinition;
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
    /// JWKS resolver for the Sign in with Apple / Google verify routes (FR-269).
    /// Production wires a cached `reqwest` fetcher; tests inject a fixed key set
    /// so the provider-verify path runs offline.
    jwks_provider: crate::auth::SharedJwksProvider,
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
    /// The outbound-email router (FR-268). Production wires a
    /// [`crate::email::NoopEmailAdapter`] (logs + succeeds); tests inject a
    /// [`crate::email::RecordingEmailAdapter`]; FR-271 will plug a Resend
    /// adapter here. This is the documented email-seam injection point.
    pub email_router: Arc<crate::email::EmailRouter>,
    /// JWKS resolver for the Apple/Google id-token verify routes (FR-269).
    /// Production fetches + caches over HTTPS; tests inject a fixed key set so
    /// the whole verification path is exercised without a network.
    pub jwks_provider: crate::auth::SharedJwksProvider,
    /// App-provided blob processors (FR-272). Registered into the shared
    /// [`BlobProcessorRegistry`](crate::blob_processors::BlobProcessorRegistry)
    /// at boot, in order; a duplicate id is a [`BootError::Config`]. Empty for
    /// the foundation (no stock processors are auto-registered). This is the
    /// documented insertion point for sync validators / async image / moderation
    /// processors.
    pub blob_processors: Vec<crate::blob_processors::SharedBlobProcessor>,
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
            // Default: a Noop-backed router. `forgot-password` still returns 200
            // (the Noop adapter logs + succeeds); FR-271 swaps in Resend.
            email_router: Arc::new(crate::email::EmailRouter::noop()),
            // Production JWKS: a cached `reqwest` fetcher hitting Apple/Google's
            // published key sets (refetched on an unknown `kid`).
            jwks_provider: Arc::new(crate::auth::ReqwestJwksProvider::default()),
            // No stock blob processors auto-register; an app supplies its own.
            blob_processors: Vec::new(),
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
/// Panics if registering the `push.deliver` or `blob.process` handler collides
/// — impossible here because the registry is freshly constructed and each is
/// registered exactly once at boot. The `expect`s document that boot invariant.
pub async fn create_frick_server_with_seams(
    config: FrickConfig,
    schema: FrickSchema,
    seams: BootSeams,
) -> Result<FrickServer, BootError> {
    // Single-app boot: the store opens with `schema`, and the registry holds the
    // one `_default` app (base_path `""`) whose per-app registries ARE the
    // top-level `state.projections` / `state.search` handles. `storage_app_id`
    // always returns `_default` here, so storage stays byte-for-byte identical
    // to the pre-FR-277 path.
    let default_projections = crate::projections::ProjectionRegistry::new();
    let default_search = crate::search::SearchRegistry::new();
    let registry = crate::apps::FrickAppRegistry::new(vec![crate::apps::AppEntry {
        id: crate::principal::DEFAULT_APP_ID.to_string(),
        base_path: String::new(),
        schema: schema.clone(),
        projections: default_projections.clone(),
        search: default_search.clone(),
    }])
    .map_err(BootError::Config)?;
    build_server(
        config,
        schema,
        registry,
        default_projections,
        default_search,
        seams,
    )
    .await
}

/// Build a multi-app server (FR-277): one [`crate::apps::AppEntry`] per
/// [`AppDefinition`], all partitioning the shared store by `app_id`. The store
/// opens with `store_schema` (the foundation schema in TS multi-app mode, so
/// HTTP error envelopes carry the foundation hash/revision even on a multi-app
/// server — map 02 §13.3). `state.schema` / `state.projections` / `state.search`
/// are the ROOT app's values: the entry whose `base_path` is `""` (or, if there
/// is none, the first app). Server-wide projections/search registered through
/// those top-level handles therefore drive the root app.
///
/// Per-app projections + search are registered AFTER construction via the
/// registry handles, e.g.
/// `server.state.apps.get("chat").unwrap().projections.register(..)`. The store
/// write funnel routes each write to the per-app projection / search registry of
/// the app that owns it (`event.app_id()`), so app A's projections never fire on
/// app B's writes ([`app_projections_for_event`] / [`app_search_for_event`]).
///
/// # Errors
/// - [`BootError::Config`] when the app set fails validation (duplicate id /
///   base_path, malformed base_path).
/// - [`BootError::Store`] / [`BootError::Io`] from store open + migration.
///
/// # Panics
/// Panics only via the boot `push.deliver` / `blob.process` registration
/// invariant (see [`create_frick_server_with_seams`]).
pub async fn create_frick_server_with_apps(
    config: FrickConfig,
    store_schema: FrickSchema,
    apps: Vec<AppDefinition>,
    seams: BootSeams,
) -> Result<FrickServer, BootError> {
    // Build each app's `AppEntry` with its own per-app registries. The root app
    // (base_path `""`, else the first app) reuses the handles that become
    // `state.projections` / `state.search`, so server-wide registration through
    // the top-level fields drives it. `state.schema` tracks the STORE schema
    // (the error-envelope contract — map 02 §13.3); the root app's own schema
    // lives on its `AppEntry`.
    let root_index = apps
        .iter()
        .position(|app| app.base_path.is_empty())
        .unwrap_or(0);
    let mut root_projections = crate::projections::ProjectionRegistry::new();
    let mut root_search = crate::search::SearchRegistry::new();

    let entries: Vec<crate::apps::AppEntry> = apps
        .into_iter()
        .enumerate()
        .map(|(index, def)| {
            let projections = crate::projections::ProjectionRegistry::new();
            let search = crate::search::SearchRegistry::new();
            if index == root_index {
                root_projections = projections.clone();
                root_search = search.clone();
            }
            crate::apps::AppEntry {
                id: def.id,
                base_path: def.base_path,
                schema: def.schema,
                projections,
                search,
            }
        })
        .collect();

    let registry = crate::apps::FrickAppRegistry::new(entries).map_err(BootError::Config)?;
    build_server(
        config,
        store_schema,
        registry,
        root_projections,
        root_search,
        seams,
    )
    .await
}

/// Build the shared blob-processor/validator registry (FR-272) from the boot
/// seam. A duplicate processor id fails the boot with a [`BootError::Config`]
/// (fail loud, mirroring the TS register-throws so a mis-registered processor
/// surfaces at startup, not at the first upload).
fn build_blob_processor_registry(
    processors: Vec<crate::blob_processors::SharedBlobProcessor>,
) -> Result<Arc<crate::blob_processors::BlobProcessorRegistry>, BootError> {
    let mut registry = crate::blob_processors::BlobProcessorRegistry::new();
    for processor in processors {
        registry
            .register(processor)
            .map_err(|err| BootError::Config(crate::config::FrickConfigError(err.to_string())))?;
    }
    Ok(Arc::new(registry))
}

/// The shared server-construction body for both the single-app and multi-app
/// boot paths. `state_projections` / `state_search` become the top-level
/// `AppStateInner` fields and MUST be `Arc`-clones of the root app's per-app
/// registries (so the store write funnel + the gateway drive the same interiors
/// the registry exposes for the root app).
async fn build_server(
    config: FrickConfig,
    schema: FrickSchema,
    registry: crate::apps::FrickAppRegistry,
    state_projections: crate::projections::ProjectionRegistry,
    state_search: crate::search::SearchRegistry,
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

    // Blob processor/validator registry (FR-272). App-provided processors come
    // in via `seams.blob_processors` (empty for the foundation). The seam wires
    // the upload pipeline (sync validate → 415, async enqueue) + the
    // `blob.process` handler without further boot changes.
    let blob_processors = build_blob_processor_registry(seams.blob_processors)?;

    // Durable-job handler registry: register the `push.deliver` handler (the
    // notification router) and the `blob.process` handler (the blob processor
    // pipeline) so a job claimed by the worker resolves a REAL handler instead
    // of dead-lettering as `jobs.unknownHandler`.
    let mut jobs = JobHandlerRegistry::new();
    jobs.register(PUSH_DELIVER_JOB_TYPE, push.router.job_handler())
        .expect("push.deliver is the only handler registered for that type at boot");
    jobs.register(
        crate::blob_processors::BLOB_PROCESS_JOB_TYPE,
        crate::blob_processors::BlobProcessHandler::new(Arc::clone(&blob_processors))
            .into_job_handler(),
    )
    .expect("blob.process is the only handler registered for that type at boot");
    let jobs = Arc::new(jobs);

    let apps = Arc::new(registry);

    let state = Arc::new(AppStateInner {
        config: config.clone(),
        store,
        schema,
        started_at: now_iso(),
        auth_limiter: std::sync::Mutex::new(crate::http::AuthLimiter::default()),
        projections: state_projections,
        search: state_search,
        push_registry: Arc::clone(&push.registry),
        notification_router: Arc::clone(&push.router),
        email_router: Arc::clone(&seams.email_router),
        apps,
        blob_processors,
    });

    // The gateway hub owns the live connections and the fan-out funnel. The
    // store's single write listener (FR-114) drives BOTH the gateway's
    // object/stream fan-out AND the projection engine (objectUpsert +
    // streamAppend; deletes never reach projections — map 05 §1.4).
    //
    // FR-277 per-app routing (tenant-app-isolation): on a genuine multi-app
    // server each write is routed to the per-app projection / search registry
    // of the app that owns the write (`event.app_id()`), so app A's projection
    // never fires on app B's writes and vice-versa. On a single-app server the
    // registry lookup always resolves the `_default` app, whose registries ARE
    // the `state.projections` / `state.search` handles, so behavior is
    // byte-for-byte identical.
    let gateway = GatewayHub::new(Arc::clone(&state));
    {
        let gateway_listener = gateway.write_listener();
        let state_for_listener = Arc::clone(&state);
        state.store.set_write_listener(Box::new(move |event| {
            gateway_listener(event);
            let projections = app_projections_for_event(&state_for_listener, event);
            crate::projections::drive_projection_write(projections, event);
        }));
    }
    // Search projector (FR-245, map 03 §13): the store applies the SearchOps
    // this registry derives from each object/stream write to its FTS tables, so
    // registered indexes stay in sync without the gateway in the loop. The
    // projector is pure (it never re-enters the store). Detached on close.
    // Routed to the writing app's per-app search registry (FR-277).
    {
        let state_for_search = Arc::clone(&state);
        state.store.set_search_projector(Box::new(move |event| {
            let app_id = event_app_id(event).to_string();
            let apps = &state_for_search.apps;
            // Namespace the stored index name by the writing app (multi-app
            // only) so two apps' same-named indexes never share FTS rows; the
            // `POST /search` route scopes its query the same way (FR-277).
            app_search_for_event(&state_for_search, event)
                .project_event(event)
                .into_iter()
                .map(|op| scope_search_op(apps, &app_id, op))
                .collect()
        }));
    }
    // Projection deltas fan out over the gateway to projection subscribers.
    // Each notice carries its `app_id`, so the gateway fans it out only to that
    // app's subscribers. On a multi-app server every app's per-app projection
    // registry gets its own listener (so a delta from any app reaches the
    // gateway); on a single-app server this is just `state.projections` (which
    // IS the `_default` app's registry — the same interior — so the loop wires
    // it exactly once).
    {
        let install = |registry: &crate::projections::ProjectionRegistry| {
            let weak = Arc::downgrade(&gateway);
            registry.set_delta_listener(Some(Box::new(move |notice| {
                if let Some(hub) = weak.upgrade() {
                    hub.publish_projection_delta(notice);
                }
            })));
        };
        if state.apps.is_multi_app() {
            for descriptor in state.apps.descriptors() {
                if let Some(app) = state.apps.get(&descriptor.id) {
                    install(&app.projections);
                }
            }
        } else {
            install(&state.projections);
        }
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
        jwks_provider: seams.jwks_provider,
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

        // Data plane (FR-277, `dispatchHttp` step 4): on a genuine multi-app
        // server each app's `dataplane_router` is `nest`ed under its base_path
        // (the nest strips the prefix so the inner routes match, and a per-app
        // layer stamps the storage app id + registry id onto the request — so
        // `/a/objects` writes partition under app A and `/b/objects` under app
        // B). On a single-app server the data plane is merged flat at the root
        // with NO per-app layer, so the `ActiveApp` extractor falls back to
        // `_default` and every byte of the single-app path is unchanged.
        let dataplane = if self.state.apps.is_multi_app() {
            crate::routes::multi_app_dataplane_router(&self.state)
        } else {
            crate::routes::dataplane_router(Arc::clone(&self.state))
        };
        let router = public_router(Arc::clone(&self.state))
            .merge(crate::auth_routes::auth_router(Arc::clone(&self.state)))
            // Sign in with Apple / Google id-token verify routes (FR-269). The
            // JWKS resolver is the injected seam (cached `reqwest` in prod).
            .merge(crate::auth::provider_auth_router(
                Arc::clone(&self.state),
                Arc::clone(&self.jwks_provider),
            ))
            .merge(dataplane)
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

/// The storage app id a store-write event was made under. The enum has no
/// accessor (the `StreamAppend` variant carries it on the nested event), so this
/// is the single place that reaches in.
fn event_app_id(event: &frick_store::FrickStoreWriteEvent) -> &str {
    match event {
        frick_store::FrickStoreWriteEvent::ObjectUpsert { app_id, .. }
        | frick_store::FrickStoreWriteEvent::ObjectDelete { app_id, .. } => app_id,
        frick_store::FrickStoreWriteEvent::StreamAppend { event, .. } => &event.app_id,
    }
}

/// The projection registry that should observe a store write (FR-277): on a
/// genuine multi-app server the per-app registry of the app that owns the write
/// ([`event_app_id`]), else the shared `_default` registry on `state`. A write
/// whose `app_id` matches no registered app (impossible on a well-formed
/// multi-app server, but defensive) falls back to the `_default` registry.
fn app_projections_for_event<'a>(
    state: &'a AppStateInner,
    event: &frick_store::FrickStoreWriteEvent,
) -> &'a crate::projections::ProjectionRegistry {
    if state.apps.is_multi_app() {
        state
            .apps
            .get(event_app_id(event))
            .map_or(&state.projections, |app| &app.projections)
    } else {
        &state.projections
    }
}

/// The search registry that should index a store write (FR-277); see
/// [`app_projections_for_event`].
fn app_search_for_event<'a>(
    state: &'a AppStateInner,
    event: &frick_store::FrickStoreWriteEvent,
) -> &'a crate::search::SearchRegistry {
    if state.apps.is_multi_app() {
        state
            .apps
            .get(event_app_id(event))
            .map_or(&state.search, |app| &app.search)
    } else {
        &state.search
    }
}

/// Rewrite a derived [`SearchOp`]'s index name to the app-scoped storage key
/// (FR-277). `app_id` is the writing app's storage id; on a single-app server
/// `scoped_index_name` is the identity, so this is a no-op there.
fn scope_search_op(
    apps: &crate::apps::FrickAppRegistry,
    app_id: &str,
    op: frick_store::SearchOp,
) -> frick_store::SearchOp {
    use frick_store::SearchOp;
    match op {
        SearchOp::Upsert {
            index,
            doc_id,
            text,
            fields,
        } => SearchOp::Upsert {
            index: apps.scoped_index_name(app_id, &index),
            doc_id,
            text,
            fields,
        },
        SearchOp::Delete { index, doc_id } => SearchOp::Delete {
            index: apps.scoped_index_name(app_id, &index),
            doc_id,
        },
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

    /// Backward-compat invariant (FR-277): the single-app boot path builds a
    /// one-app `_default` registry, so `is_multi_app()` is false and storage
    /// stays pinned to `_default`. Also asserts the `_default` app's projection
    /// registry shares its `Arc` interior with `state.projections`.
    #[tokio::test]
    async fn single_app_boot_builds_default_registry() {
        let schema = frick_protocol::foundation_schema();
        let server = create_frick_server(test_config(), schema).await.unwrap();
        let apps = &server.state.apps;
        assert_eq!(apps.len(), 1);
        assert!(!apps.is_multi_app());
        assert_eq!(apps.storage_app_id("anything"), crate::DEFAULT_APP_ID);

        // The `_default` app entry's projection handle is the SAME interior as
        // `state.projections`: a projection registered through the state field
        // is visible via the registry.
        let default_app = apps.get(crate::DEFAULT_APP_ID).expect("default app");
        server
            .state
            .projections
            .register(crate::projections::FrickProjection::new(
                "p1",
                vec![crate::projections::FrickProjectionSource::object("Note")],
                Box::new(NoopProjection),
            ))
            .unwrap();
        assert!(default_app.projections.contains("p1"));
    }

    /// The multi-app boot path (FR-277) registers every app, flips
    /// `is_multi_app()`, and resolves storage app ids by base_path.
    #[tokio::test]
    async fn multi_app_boot_registers_all_apps() {
        let foundation = frick_protocol::foundation_schema();
        let mut chat = frick_protocol::foundation_schema();
        chat.schema_id = "chat.schema".to_string();
        let apps = vec![
            AppDefinition::new("root", "", foundation.clone()),
            AppDefinition::new("chat", "/chat", chat),
        ];
        let server =
            create_frick_server_with_apps(test_config(), foundation, apps, BootSeams::production())
                .await
                .unwrap();
        let registry = &server.state.apps;
        assert_eq!(registry.len(), 2);
        assert!(registry.is_multi_app());
        assert_eq!(registry.storage_app_id("chat"), "chat");
        let resolution = registry.resolve_by_path("/chat/rooms").unwrap();
        assert_eq!(resolution.app_id, "chat");
        assert_eq!(resolution.relative_path, "/rooms");
    }

    /// A no-op projection handler for the registry-wiring assertion above.
    struct NoopProjection;
    impl crate::projections::FrickProjectionHandler for NoopProjection {
        fn apply(
            &self,
            _event: &crate::projections::FrickProjectionWriteEvent,
            _ctx: &crate::projections::FrickProjectionContext,
        ) -> crate::projections::ProjectionApplyResult {
            crate::projections::ProjectionApplyResult::none()
        }
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
