//! The projection engine (FR-245, map 05 §1), ported from
//! `apps/server/src/projections/registry.ts` (the registry, matching, notify,
//! snapshot, and rebuild semantics) plus the `/projections` HTTP read surface
//! and the gateway live-delta wiring in `apps/server/src/server.ts` and
//! `apps/server/src/sync/gateway.ts`.
//!
//! A projection derives an app-readable view from one or more source write
//! streams (object upserts and stream appends). Each registered projection
//! owns a boxed [`FrickProjectionHandler`] the embedding app implements; the
//! [`ProjectionRegistry`] holds them in registration order, matches incoming
//! writes against their declared [`FrickProjectionSource`]s, applies the
//! handler, materializes the resulting row changes into a tenant-scoped
//! in-memory snapshot, and fans a [`ProjectionDeltaNotice`] to a single delta
//! listener (the sync gateway).
//!
//! ## What this module owns
//!
//! - [`ProjectionRegistry`] (TS `createFrickProjectionRegistry`): register /
//!   list / get / [`notify`](ProjectionRegistry::notify) /
//!   [`rebuild_all`](ProjectionRegistry::rebuild_all) /
//!   [`snapshot`](ProjectionRegistry::snapshot) /
//!   [`set_delta_listener`](ProjectionRegistry::set_delta_listener).
//! - The [`FrickStoreWriteEvent`] → [`FrickProjectionWriteEvent`] driver
//!   ([`drive_projection_write`]): the integrator installs it on the store so
//!   `objectUpsert` + `streamAppend` writes reach projections (NOT
//!   `objectDelete` — see the load-bearing quirk below).
//! - The HTTP read surface helpers ([`list_projections_body`],
//!   [`read_projection`]) the `/projections` routes call.
//! - The gateway helpers: [`ProjectionRegistry::snapshot`] (for the
//!   subscribe-time initial frame) and [`notice_to_payload`] (the
//!   [`ProjectionDeltaNotice`] → [`ProjectionDeltaPayload`] frame conversion).
//!
//! ## Load-bearing quirk preserved from TS (`store.ts` §1.4)
//!
//! `deleteObject` does NOT notify projections — only `objectUpsert` and
//! `streamAppend(created)` do. The registry's matcher can match an
//! `objectDelete` event (mirroring TS), but [`drive_projection_write`] never
//! emits one, so in practice projections never observe deletes. This is
//! behavioral parity, not an oversight.
//!
//! ## Determinism
//!
//! The registry holds no clock. Snapshot ordering is deterministic
//! (insertion-ordered, via [`indexmap::IndexMap`]). The delta listener and the
//! HTTP/gateway callers supply any time/ids they need from their own seams.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use frick_protocol::Value;
use frick_protocol::frame::{ProjectionDeltaChange, ProjectionDeltaPayload};
use frick_store::FrickStoreWriteEvent;
use indexmap::IndexMap;

use crate::error::ServerError;

/// `_default` tenant/app partition. The TS context defaults `appId` to
/// `_default`; the driver fills it from the originating write.
pub const DEFAULT_APP_ID: &str = "_default";

// ---- §1.1 source / event / change model -------------------------------------

/// The kind of source write that triggers a projection's handler
/// (`FrickProjectionSource`, registry.ts:20-34).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectionSourceKind {
    /// An object type: matches `objectUpsert` / `objectDelete` by type.
    Object,
    /// A stream type: matches `streamEvent` by stream type.
    Stream,
}

impl ProjectionSourceKind {
    /// The wire label used in `GET /projections` (`"object"` / `"stream"`).
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Object => "object",
            Self::Stream => "stream",
        }
    }
}

/// A declared projection source (`{ kind, type }`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrickProjectionSource {
    /// Object or stream.
    pub kind: ProjectionSourceKind,
    /// The schema object/stream type name this source matches.
    pub type_name: String,
}

impl FrickProjectionSource {
    /// An object-source matching `type_name`.
    #[must_use]
    pub fn object(type_name: impl Into<String>) -> Self {
        Self {
            kind: ProjectionSourceKind::Object,
            type_name: type_name.into(),
        }
    }

    /// A stream-source matching `type_name`.
    #[must_use]
    pub fn stream(type_name: impl Into<String>) -> Self {
        Self {
            kind: ProjectionSourceKind::Stream,
            type_name: type_name.into(),
        }
    }
}

/// A write dispatched to projection handlers (`FrickProjectionWriteEvent`,
/// registry.ts:36-55). The variants carry exactly the fields the TS shape does.
#[derive(Debug, Clone, PartialEq)]
pub enum FrickProjectionWriteEvent {
    /// A row was upserted. `object` is the post-write stored state.
    ObjectUpsert {
        tenant_id: String,
        app_id: String,
        object_type: String,
        object_id: String,
        object: Value,
    },
    /// A row was removed. NOTE: no driver emits this (the registry matches it
    /// for parity, but `deleteObject` never notifies projections — see module
    /// docs).
    ObjectDelete {
        tenant_id: String,
        app_id: String,
        object_type: String,
        object_id: String,
    },
    /// A stream event was appended (only on `created == true`).
    StreamEvent {
        tenant_id: String,
        app_id: String,
        stream_type: String,
        stream_id: String,
        /// The full stored event row (the TS `streamEvent` field).
        stream_event: Value,
    },
}

impl FrickProjectionWriteEvent {
    /// The originating write's tenant id.
    #[must_use]
    pub fn tenant_id(&self) -> &str {
        match self {
            Self::ObjectUpsert { tenant_id, .. }
            | Self::ObjectDelete { tenant_id, .. }
            | Self::StreamEvent { tenant_id, .. } => tenant_id,
        }
    }

    /// The originating write's app id.
    #[must_use]
    pub fn app_id(&self) -> &str {
        match self {
            Self::ObjectUpsert { app_id, .. }
            | Self::ObjectDelete { app_id, .. }
            | Self::StreamEvent { app_id, .. } => app_id,
        }
    }

    /// Whether `source` matches this event (registry.ts:210-217). Object
    /// sources match object upserts/deletes by type; stream sources match
    /// stream events by stream type.
    #[must_use]
    pub fn matches(&self, source: &FrickProjectionSource) -> bool {
        match source.kind {
            ProjectionSourceKind::Object => match self {
                Self::ObjectUpsert { object_type, .. } | Self::ObjectDelete { object_type, .. } => {
                    source.type_name == *object_type
                }
                Self::StreamEvent { .. } => false,
            },
            ProjectionSourceKind::Stream => match self {
                Self::StreamEvent { stream_type, .. } => source.type_name == *stream_type,
                Self::ObjectUpsert { .. } | Self::ObjectDelete { .. } => false,
            },
        }
    }
}

/// A single materialized row change (`ProjectionChange`, registry.ts:65-70).
/// `value == None` means "delete this row"; `Some(_)` replaces it.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectionChange {
    /// Projection-defined row key, e.g. `"{userId}:{conversationId}"`.
    pub key: String,
    /// `None` deletes the row; `Some(value)` upserts it.
    pub value: Option<Value>,
}

impl ProjectionChange {
    /// An upsert change.
    #[must_use]
    pub fn upsert(key: impl Into<String>, value: Value) -> Self {
        Self {
            key: key.into(),
            value: Some(value),
        }
    }

    /// A delete change.
    #[must_use]
    pub fn delete(key: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            value: None,
        }
    }
}

/// What a handler's `apply` returns (`ProjectionApplyResult`, registry.ts:72-74):
/// the row changes this event produced. An empty vec is the "no deltas" shape.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProjectionApplyResult {
    /// Row changes; empty for legacy handlers that emit no deltas.
    pub changes: Vec<ProjectionChange>,
}

impl ProjectionApplyResult {
    /// No changes (the legacy `void` return).
    #[must_use]
    pub fn none() -> Self {
        Self {
            changes: Vec::new(),
        }
    }

    /// A single-change result (`singleChange` helper, helpers.ts:38-40).
    #[must_use]
    pub fn single(key: impl Into<String>, value: Option<Value>) -> Self {
        Self {
            changes: vec![ProjectionChange {
                key: key.into(),
                value,
            }],
        }
    }
}

/// The notice handed to the delta listener (`ProjectionDeltaNotice`,
/// registry.ts:76-86). `app_id` is always present here (the Rust driver always
/// fills it from the originating write); the TS field-presence quirk only
/// mattered for an internal msgpack-fidelity edge the cluster bus normalized.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectionDeltaNotice {
    /// Registered projection name.
    pub projection: String,
    /// Tenant the delta belongs to (for gateway tenant-filtering).
    pub tenant_id: String,
    /// App partition the delta originated in (for gateway app-filtering).
    pub app_id: String,
    /// The row changes.
    pub changes: Vec<ProjectionChange>,
}

// ---- §1.1 handler / context --------------------------------------------------

/// Context handed to a projection handler (`FrickProjectionContext`,
/// registry.ts:57-63). The TS context carries `store` + `logger`; the embedding
/// app's handler closes over whatever store handle it needs, so we only thread
/// the tenant/app identity the registry knows. Handlers that read the store can
/// capture an `Arc<FrickStore>` at registration time.
#[derive(Debug, Clone)]
pub struct FrickProjectionContext {
    /// Tenant the originating write belongs to.
    pub tenant_id: String,
    /// App partition the originating write belongs to (`_default` single-app).
    pub app_id: String,
}

impl FrickProjectionContext {
    /// A context for `tenant_id` / `app_id`.
    #[must_use]
    pub fn new(tenant_id: impl Into<String>, app_id: impl Into<String>) -> Self {
        Self {
            tenant_id: tenant_id.into(),
            app_id: app_id.into(),
        }
    }
}

/// An app-provided projection handler (`FrickProjectionHandler`,
/// registry.ts:88-114). Boxed and `Send + Sync` so the registry can hold it
/// behind an `Arc<Mutex<…>>` shared across the store-write funnel and the HTTP
/// routes.
///
/// The foundation schema ships no projections; tests register a handler
/// implementing this trait.
pub trait FrickProjectionHandler: Send + Sync {
    /// Called after each matching source write succeeds. MUST be idempotent —
    /// the framework may replay events during a rebuild. Returns the row
    /// changes this event produced (empty for "no deltas").
    fn apply(
        &self,
        event: &FrickProjectionWriteEvent,
        ctx: &FrickProjectionContext,
    ) -> ProjectionApplyResult;

    /// Optional: rebuild the projection's state for `ctx`'s tenant. Wired to
    /// the admin rebuild route + [`ProjectionRegistry::rebuild_all`]. The
    /// default is "no rebuild support" (the admin route returns 405).
    fn rebuild(&self, _ctx: &FrickProjectionContext) {}

    /// Whether this handler implements [`rebuild`](Self::rebuild). The registry
    /// uses this to decide whether `rebuild_all` invokes it and whether the
    /// admin route returns 405 (TS `typeof handler.rebuild === "function"`).
    /// Override to `true` when you implement `rebuild`.
    fn supports_rebuild(&self) -> bool {
        false
    }

    /// Optional: serve `GET /projections/:name?<query>`. `None` (the default)
    /// yields HTTP 405. The query map is every URL search param; `query["key"]`
    /// doubles as the subscription authz key (§1.5).
    fn read(
        &self,
        _ctx: &FrickProjectionContext,
        _query: &BTreeMap<String, String>,
    ) -> Option<Value> {
        None
    }
}

/// A registered projection (`FrickProjection`, registry.ts:116-122).
pub struct FrickProjection {
    /// Stable identifier, e.g. `"activity-feed"`.
    pub name: String,
    /// Source writes that trigger `apply`.
    pub sources: Vec<FrickProjectionSource>,
    /// The app-provided handler.
    pub handler: Box<dyn FrickProjectionHandler>,
}

impl FrickProjection {
    /// Construct a projection definition.
    #[must_use]
    pub fn new(
        name: impl Into<String>,
        sources: Vec<FrickProjectionSource>,
        handler: Box<dyn FrickProjectionHandler>,
    ) -> Self {
        Self {
            name: name.into(),
            sources,
            handler,
        }
    }
}

/// A delta listener: the single consumer of [`ProjectionDeltaNotice`]s (the
/// sync gateway). Boxed `Fn`, matching the store's single-slot listener shape.
pub type ProjectionDeltaListener = Box<dyn Fn(&ProjectionDeltaNotice) + Send + Sync>;

// ---- §1.1 registry -----------------------------------------------------------

/// Tenant-scoped materialized rows for one projection:
/// `tenant_id -> (row_key -> row_value)`. Insertion-ordered so
/// [`ProjectionRegistry::snapshot`] reproduces JS Map iteration order.
type TenantRows = IndexMap<String, IndexMap<String, Value>>;

/// The locked interior of the registry.
struct RegistryInner {
    /// Registration-ordered projection names (drives `notify` / `rebuild_all`
    /// iteration order, registry.ts:52).
    order: Vec<String>,
    /// Projections by name (also the duplicate-name guard).
    by_name: IndexMap<String, FrickProjection>,
    /// Materialized snapshot state: `projection -> tenant -> rows` (registry.ts
    /// `rowsByProjection`). NOT persisted — volatile-by-design (§1.1).
    rows: IndexMap<String, TenantRows>,
    /// The single delta listener (the gateway), or `None`.
    delta_listener: Option<ProjectionDeltaListener>,
}

/// The projection registry (`createFrickProjectionRegistry`, registry.ts:164-285).
///
/// Cheaply cloneable: an `Arc` around the locked interior so the store-write
/// driver, the HTTP routes, and the gateway subscribe path all share one
/// registry.
#[derive(Clone)]
pub struct ProjectionRegistry {
    inner: Arc<Mutex<RegistryInner>>,
}

impl Default for ProjectionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ProjectionRegistry {
    /// An empty registry with no delta listener (`createFrickProjectionRegistry`
    /// with no `onDelta`).
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RegistryInner {
                order: Vec::new(),
                by_name: IndexMap::new(),
                rows: IndexMap::new(),
                delta_listener: None,
            })),
        }
    }

    /// Register a projection. Preserves registration order. A duplicate name is
    /// rejected with the exact TS message
    /// `Projection "<name>" is already registered` (registry.ts:202-208) as a
    /// [`ServerError::BadRequest`] (boot maps this to a config failure).
    ///
    /// # Errors
    /// Returns [`ServerError::BadRequest`] when `projection.name` is already
    /// registered.
    pub fn register(&self, projection: FrickProjection) -> Result<(), ServerError> {
        let mut inner = self.lock();
        if inner.by_name.contains_key(&projection.name) {
            return Err(ServerError::BadRequest {
                message: format!("Projection \"{}\" is already registered", projection.name),
            });
        }
        inner.order.push(projection.name.clone());
        inner.by_name.insert(projection.name.clone(), projection);
        Ok(())
    }

    /// The registered projection names, in registration order
    /// (`list()` projected to names — the handler box is not `Clone`).
    #[must_use]
    pub fn names(&self) -> Vec<String> {
        self.lock().order.clone()
    }

    /// Whether `name` is registered (`get(name).is_some()`).
    #[must_use]
    pub fn contains(&self, name: &str) -> bool {
        self.lock().by_name.contains_key(name)
    }

    /// The `(name, sources)` pairs for `GET /projections`
    /// (registry.ts `list().map(...)`), in registration order.
    #[must_use]
    pub fn descriptors(&self) -> Vec<ProjectionDescriptor> {
        let inner = self.lock();
        inner
            .order
            .iter()
            .filter_map(|name| inner.by_name.get(name))
            .map(|projection| ProjectionDescriptor {
                name: projection.name.clone(),
                sources: projection.sources.clone(),
                supports_rebuild: projection.handler.supports_rebuild(),
                supports_read: projection
                    .handler
                    .read(
                        &FrickProjectionContext::new("_", DEFAULT_APP_ID),
                        &BTreeMap::new(),
                    )
                    .is_some(),
            })
            .collect()
    }

    /// Dispatch a write event to every matching projection in registration
    /// order (`notify`, registry.ts:219-255):
    ///
    /// 1. `handler.apply(event, ctx)` (panics are caught + logged
    ///    `frick.projection.apply_failed`; a projection failure never fails the
    ///    originating write).
    /// 2. If it returned changes: materialize them into the tenant-scoped
    ///    snapshot **regardless of whether a delta listener is attached**.
    /// 3. If a delta listener is set: invoke it with the notice (listener
    ///    panics are caught + logged `frick.projection.delta_listener_failed`).
    pub fn notify(&self, event: &FrickProjectionWriteEvent, ctx: &FrickProjectionContext) {
        // Collect the matching projection names under the lock, then run each
        // handler with the lock released (a handler may call back into the
        // store, and apply may panic — neither should be holding the registry
        // mutex). The snapshot update + listener call re-acquire the lock.
        let matching: Vec<String> = {
            let inner = self.lock();
            inner
                .order
                .iter()
                .filter(|name| {
                    inner
                        .by_name
                        .get(*name)
                        .is_some_and(|p| p.sources.iter().any(|s| event.matches(s)))
                })
                .cloned()
                .collect()
        };

        for name in matching {
            // Run the handler (catch panics; never tear down the write).
            let applied = {
                let inner = self.lock();
                let Some(projection) = inner.by_name.get(&name) else {
                    continue;
                };
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    projection.handler.apply(event, ctx)
                }))
            };
            let Ok(result) = applied else {
                tracing::warn!(
                    target: "frick.projection.apply_failed",
                    projection = %name,
                    "projection apply panicked",
                );
                continue;
            };
            if result.changes.is_empty() {
                continue;
            }
            // Materialize into the snapshot regardless of listener presence,
            // then capture the listener call while holding the lock.
            let notice = {
                let mut inner = self.lock();
                apply_changes_to_snapshot(&mut inner.rows, &name, &ctx.tenant_id, &result.changes);
                ProjectionDeltaNotice {
                    projection: name.clone(),
                    tenant_id: ctx.tenant_id.clone(),
                    app_id: ctx.app_id.clone(),
                    changes: result.changes,
                }
            };
            self.invoke_delta_listener(&notice);
        }
    }

    /// Invoke the delta listener (if any), catching + logging panics
    /// (registry.ts:230-245).
    fn invoke_delta_listener(&self, notice: &ProjectionDeltaNotice) {
        // Take the listener out from under the lock isn't possible (it's a
        // boxed Fn we don't own), so call it while holding the lock. The
        // gateway listener only enqueues onto unbounded channels, so it never
        // blocks or re-enters the registry.
        let inner = self.lock();
        let Some(listener) = inner.delta_listener.as_ref() else {
            return;
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(notice)));
        if result.is_err() {
            tracing::warn!(
                target: "frick.projection.delta_listener_failed",
                projection = %notice.projection,
                "projection delta listener panicked",
            );
        }
    }

    /// Install (or clear, with `None`) the single delta listener
    /// (`setDeltaListener`, registry.ts:274-276). Replaces any existing one.
    pub fn set_delta_listener(&self, listener: Option<ProjectionDeltaListener>) {
        self.lock().delta_listener = listener;
    }

    /// The current materialized rows for `name` scoped to `tenant_id`, as the
    /// changes that reproduce them on a fresh client (`snapshot`,
    /// registry.ts:277-283). Insertion-ordered; empty for an unknown projection
    /// or a tenant with no rows. Every change is an upsert (`value: Some`).
    #[must_use]
    pub fn snapshot(&self, name: &str, tenant_id: &str) -> Vec<ProjectionChange> {
        let inner = self.lock();
        let Some(rows) = inner.rows.get(name).and_then(|byt| byt.get(tenant_id)) else {
            return Vec::new();
        };
        rows.iter()
            .map(|(key, value)| ProjectionChange {
                key: key.clone(),
                value: Some(value.clone()),
            })
            .collect()
    }

    /// Invoke `rebuild` on every projection that supports it, in registration
    /// order (`rebuildAll`, registry.ts:257-266). Returns the names actually
    /// rebuilt.
    pub fn rebuild_all(&self, ctx: &FrickProjectionContext) -> RebuildAllResult {
        let order = self.lock().order.clone();
        let mut rebuilt = Vec::new();
        for name in order {
            let inner = self.lock();
            let Some(projection) = inner.by_name.get(&name) else {
                continue;
            };
            if projection.handler.supports_rebuild() {
                projection.handler.rebuild(ctx);
                rebuilt.push(name.clone());
            }
        }
        RebuildAllResult { rebuilt }
    }

    /// Rebuild a single named projection (the admin
    /// `POST /_frick/admin/projections/:name/rebuild` route, §1.7).
    ///
    /// # Errors
    /// - [`ProjectionRebuildOutcome::NotFound`] when `name` is unregistered.
    /// - [`ProjectionRebuildOutcome::NotSupported`] when the handler has no
    ///   `rebuild`.
    #[must_use]
    pub fn rebuild_one(
        &self,
        name: &str,
        ctx: &FrickProjectionContext,
    ) -> ProjectionRebuildOutcome {
        let inner = self.lock();
        let Some(projection) = inner.by_name.get(name) else {
            return ProjectionRebuildOutcome::NotFound;
        };
        if !projection.handler.supports_rebuild() {
            return ProjectionRebuildOutcome::NotSupported;
        }
        projection.handler.rebuild(ctx);
        ProjectionRebuildOutcome::Rebuilt
    }

    /// Run a registered projection's `read` (the `/projections/:name` body
    /// builder, §1.5). Returns:
    /// - [`ProjectionReadOutcome::NotFound`] when `name` is unregistered.
    /// - [`ProjectionReadOutcome::MethodNotAllowed`] when the handler has no
    ///   `read`.
    /// - [`ProjectionReadOutcome::Ok`] with the read's data otherwise.
    #[must_use]
    pub fn read(
        &self,
        name: &str,
        ctx: &FrickProjectionContext,
        query: &BTreeMap<String, String>,
    ) -> ProjectionReadOutcome {
        let inner = self.lock();
        let Some(projection) = inner.by_name.get(name) else {
            return ProjectionReadOutcome::NotFound;
        };
        match projection.handler.read(ctx, query) {
            Some(data) => ProjectionReadOutcome::Ok(data),
            None => ProjectionReadOutcome::MethodNotAllowed,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, RegistryInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// `apply` of a change set onto a tenant's row map (registry.ts:176-200):
/// `null` deletes; non-null upserts; empty tenant/projection maps are pruned.
fn apply_changes_to_snapshot(
    rows: &mut IndexMap<String, TenantRows>,
    projection: &str,
    tenant_id: &str,
    changes: &[ProjectionChange],
) {
    let by_tenant = rows.entry(projection.to_string()).or_default();
    let tenant_rows = by_tenant.entry(tenant_id.to_string()).or_default();
    for change in changes {
        match &change.value {
            Some(value) => {
                tenant_rows.insert(change.key.clone(), value.clone());
            }
            None => {
                tenant_rows.shift_remove(&change.key);
            }
        }
    }
    if tenant_rows.is_empty() {
        by_tenant.shift_remove(tenant_id);
        if by_tenant.is_empty() {
            rows.shift_remove(projection);
        }
    }
}

/// A projection's `{name, sources}` (+ capability flags) for the HTTP read /
/// admin introspection surfaces.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectionDescriptor {
    /// The projection name.
    pub name: String,
    /// The declared sources.
    pub sources: Vec<FrickProjectionSource>,
    /// Whether the handler implements `rebuild` (admin introspection, §1.8).
    pub supports_rebuild: bool,
    /// Whether the handler implements `read` (admin introspection, §1.8).
    pub supports_read: bool,
}

/// Result of [`ProjectionRegistry::rebuild_all`] (`{ rebuilt }`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RebuildAllResult {
    /// Names of the projections actually rebuilt.
    pub rebuilt: Vec<String>,
}

/// Outcome of [`ProjectionRegistry::rebuild_one`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectionRebuildOutcome {
    /// Rebuilt.
    Rebuilt,
    /// Unknown projection (admin route → 404 `projectionNotFound`).
    NotFound,
    /// Registered, no `rebuild` (admin route → 405 `rebuildNotSupported`).
    NotSupported,
}

/// Outcome of [`ProjectionRegistry::read`].
#[derive(Debug, Clone, PartialEq)]
pub enum ProjectionReadOutcome {
    /// `read` produced a body.
    Ok(Value),
    /// Unknown projection (HTTP 404 `projectionNotFound`).
    NotFound,
    /// Registered, no `read` (HTTP 405 `method_not_allowed`).
    MethodNotAllowed,
}

// ---- the store-write driver (§1.4) -------------------------------------------

/// Convert a [`FrickStoreWriteEvent`] into a [`FrickProjectionWriteEvent`] and
/// notify the registry (the integrator's store-write seam, replacing the
/// no-op `notify_projection_*` hooks the facade documents).
///
/// Only `ObjectUpsert` and `StreamAppend` drive projections. `ObjectDelete` is
/// deliberately dropped — `deleteObject` never notifies projections in TS
/// (§1.4 load-bearing quirk).
pub fn drive_projection_write(registry: &ProjectionRegistry, event: &FrickStoreWriteEvent) {
    match event {
        FrickStoreWriteEvent::ObjectUpsert {
            tenant_id,
            app_id,
            object_type,
            object_id,
            object,
            ..
        } => {
            let projection_event = FrickProjectionWriteEvent::ObjectUpsert {
                tenant_id: tenant_id.clone(),
                app_id: app_id.clone(),
                object_type: object_type.clone(),
                object_id: object_id.clone(),
                object: object.clone(),
            };
            let ctx = FrickProjectionContext::new(tenant_id.clone(), app_id.clone());
            registry.notify(&projection_event, &ctx);
        }
        FrickStoreWriteEvent::StreamAppend { tenant_id, event } => {
            let projection_event = FrickProjectionWriteEvent::StreamEvent {
                tenant_id: tenant_id.clone(),
                app_id: event.app_id.clone(),
                stream_type: event.event.stream.clone(),
                stream_id: event.event.stream_id.clone(),
                stream_event: stored_event_to_value(event),
            };
            let ctx = FrickProjectionContext::new(tenant_id.clone(), event.app_id.clone());
            registry.notify(&projection_event, &ctx);
        }
        // SURPRISING / load-bearing: object deletes never reach projections.
        FrickStoreWriteEvent::ObjectDelete { .. } => {}
    }
}

/// Render a stored stream event as the msgpack map a handler's `apply` sees as
/// the `streamEvent` field (the TS `result.event` row shape).
fn stored_event_to_value(stored: &frick_store::stores::stream::StoredEvent) -> Value {
    let event = &stored.event;
    Value::Map(vec![
        (Value::from("stream"), Value::from(event.stream.as_str())),
        (
            Value::from("streamId"),
            Value::from(event.stream_id.as_str()),
        ),
        (Value::from("sequence"), Value::from(event.sequence)),
        (Value::from("eventId"), Value::from(event.event_id.as_str())),
        (Value::from("event"), Value::from(event.event.as_str())),
        (Value::from("payload"), event.payload.clone()),
        (
            Value::from("tenantId"),
            Value::from(stored.tenant_id.as_str()),
        ),
        (Value::from("appId"), Value::from(stored.app_id.as_str())),
    ])
}

// ---- gateway / HTTP frame helpers --------------------------------------------

/// Convert a [`ProjectionDeltaNotice`] into the [`ProjectionDeltaPayload`] frame
/// body the gateway sends. Maps `None` (delete) to [`Value::Nil`] under a
/// present `value` key, exactly like the TS `null` (frame.rs `is_delete`).
#[must_use]
pub fn notice_to_payload(notice: &ProjectionDeltaNotice) -> ProjectionDeltaPayload {
    ProjectionDeltaPayload {
        projection: notice.projection.clone(),
        changes: changes_to_frame(&notice.changes),
    }
}

/// Convert a snapshot/notice change list into wire [`ProjectionDeltaChange`]s.
/// Used both for the live delta fan-out and the subscribe-time initial frame
/// (whose changes are [`ProjectionRegistry::snapshot`]'s rows).
#[must_use]
pub fn changes_to_frame(changes: &[ProjectionChange]) -> Vec<ProjectionDeltaChange> {
    changes
        .iter()
        .map(|change| ProjectionDeltaChange {
            key: change.key.clone(),
            value: change.value.clone().unwrap_or(Value::Nil),
        })
        .collect()
}

/// Build the `GET /projections` response body (§1.5):
/// `{ schemaHash, projections: [{ name, sources: [{ kind, type }] }] }`.
#[must_use]
pub fn list_projections_body(
    registry: &ProjectionRegistry,
    schema_hash: &str,
) -> serde_json::Value {
    let projections: Vec<serde_json::Value> = registry
        .descriptors()
        .into_iter()
        .map(|descriptor| {
            serde_json::json!({
                "name": descriptor.name,
                "sources": descriptor
                    .sources
                    .iter()
                    .map(|source| serde_json::json!({
                        "kind": source.kind.as_str(),
                        "type": source.type_name,
                    }))
                    .collect::<Vec<_>>(),
            })
        })
        .collect();
    serde_json::json!({
        "schemaHash": schema_hash,
        "projections": projections,
    })
}

/// The decided response of `GET /projections/:name` (§1.5), for the route to
/// render. The route runs `assertCanSubscribe(projection, name, query.key)`
/// only on the [`Found`](ProjectionHttpRead::Found) arm (matching TS: authz
/// happens after the existence + read-impl checks).
#[derive(Debug, Clone, PartialEq)]
pub enum ProjectionHttpRead {
    /// 404 — unknown projection. The route renders the
    /// `sync.protocolError` envelope with `details.reason = "projectionNotFound"`
    /// and `details.projection = <name>` (see [`projection_not_found_body`]).
    NotFound,
    /// 405 — registered but no `read`. The route renders the raw JSON
    /// `{ error: "method_not_allowed", message: ... }` (see
    /// [`method_not_allowed_body`]) — NOT the standard envelope.
    MethodNotAllowed,
    /// 200 — `{ schemaHash, projection, data }` (the route still authorizes
    /// first via `assertCanSubscribe`).
    Found(Value),
}

/// Resolve `GET /projections/:name` without rendering — the route runs authz
/// on the [`Found`](ProjectionHttpRead::Found) arm then builds the body via
/// [`read_projection_body`]. `query` is every URL search param.
#[must_use]
pub fn read_projection(
    registry: &ProjectionRegistry,
    name: &str,
    ctx: &FrickProjectionContext,
    query: &BTreeMap<String, String>,
) -> ProjectionHttpRead {
    match registry.read(name, ctx, query) {
        ProjectionReadOutcome::NotFound => ProjectionHttpRead::NotFound,
        ProjectionReadOutcome::MethodNotAllowed => ProjectionHttpRead::MethodNotAllowed,
        ProjectionReadOutcome::Ok(data) => ProjectionHttpRead::Found(data),
    }
}

/// Build the 200 body for `GET /projections/:name`:
/// `{ schemaHash, projection, data }` (§1.5).
#[must_use]
pub fn read_projection_body(schema_hash: &str, name: &str, data: &Value) -> serde_json::Value {
    serde_json::json!({
        "schemaHash": schema_hash,
        "projection": name,
        "data": serde_json::to_value(data).unwrap_or(serde_json::Value::Null),
    })
}

/// The 405 raw JSON body (NOT an error envelope) for a projection without a
/// `read` impl: `{ error: "method_not_allowed", message: 'Projection "<name>"
/// does not implement read' }` (server.ts:2150-2154).
#[must_use]
pub fn method_not_allowed_body(name: &str) -> serde_json::Value {
    serde_json::json!({
        "error": "method_not_allowed",
        "message": format!("Projection \"{name}\" does not implement read"),
    })
}

/// The 404 body for an unknown projection: the `sync.protocolError` envelope
/// with `details.reason = "projectionNotFound"` + `details.projection`
/// (server.ts:3108-3116/3280-3281/3308-3311).
///
/// NOTE: [`ServerError::ProjectionNotFound`] currently maps to the
/// `storage.notFound` code; the TS wire code for this route is
/// `sync.protocolError` (the `ProjectionNotFoundError` falls through
/// `httpErrorCode`). This helper builds the TS-faithful body directly so the
/// route does not depend on `error.rs` changing. See openIssues.
#[must_use]
pub fn projection_not_found_body(name: &str, request_id: &str) -> serde_json::Value {
    serde_json::json!({
        "error": {
            "code": "sync.protocolError",
            "message": format!("Projection \"{name}\" not found"),
            "requestId": request_id,
            "retryable": false,
            "details": {
                "routeCode": request_id,
                "reason": "projectionNotFound",
                "projection": name,
            },
        },
        "code": "sync.protocolError",
        "message": format!("Projection \"{name}\" not found"),
        "requestId": request_id,
        "retryable": false,
    })
}

/// The 405 raw JSON body for the admin rebuild route when a projection has no
/// `rebuild` impl: `{ error: "method_not_allowed", message: 'Projection
/// "<name>" does not support rebuild' }` (server.ts §1.7).
#[must_use]
pub fn rebuild_not_supported_body(name: &str) -> serde_json::Value {
    serde_json::json!({
        "error": "method_not_allowed",
        "message": format!("Projection \"{name}\" does not support rebuild"),
    })
}

#[cfg(test)]
mod tests;
