//! Inspection routes — `GET /_frick/inspect/*` (map 02 §4.5;
//! `src/server.ts:1211-1385`).
//!
//! The whole surface is gated by `config.inspection_enabled`: when inspection
//! is disabled every sub-path is a 404 `{error:"not_found"}` (the TS guard is
//! the `if (config.inspectionEnabled && …)` wrapper — a disabled server never
//! enters the block, so the request falls through to the global 404).
//!
//! Auth is the TS `inspect` tier (`inspectionPrincipalFromRequest`,
//! `src/server.ts:3821-3839`): production demands the admin token; non-production
//! accepts the admin token OR any active session. The Rust port resolves the
//! configured admin bearer (`FRICK_ADMIN_TOKEN`) on this seam (FR-278), matching
//! how the admin router authenticates: in production the admin token is
//! **required**; in non-production the admin token OR any active session
//! principal is accepted. An unauthenticated request gets the same 401 the data
//! plane returns.
//!
//! Sub-paths implemented here return the documented shapes for `server`, `apps`,
//! `migrations`, `metrics`, `projections`, `search`, `db`, and `jobs`. The
//! DevTools / platform-events / analytics sub-paths are later stories: they
//! return an empty/"not available" stub with a TODO so the console degrades
//! gracefully instead of 404-ing.
//!
//! Determinism: `snapshotAt` and the request id enter from the system clock /
//! uuid at the route boundary (`now_ms` / `new_request_id`); the store methods
//! the handlers call take no clock.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::json;

use super::{new_request_id, now_ms};
use crate::error::ServerError;
use crate::extract::{require_principal, session_token_from_headers};
use crate::http::{AppState, respond_error};
use crate::principal::DEFAULT_APP_ID;

/// Build the inspection router (`inspect_router`). The integrator merges this
/// onto `boot::listen` (see the module-level integrator note in
/// `routes/admin.rs`). Every route is registered, but each handler first checks
/// `config.inspection_enabled` and 404s when disabled, so a server with
/// inspection off behaves exactly like the TS (no `/_frick/inspect/*` surface).
pub fn inspect_router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/_frick/inspect/server", get(server))
        .route("/_frick/inspect/apps", get(apps))
        .route("/_frick/inspect/migrations", get(migrations))
        .route("/_frick/inspect/metrics", get(metrics))
        .route("/_frick/inspect/projections", get(projections))
        .route("/_frick/inspect/search", get(search))
        .route("/_frick/inspect/db", get(db))
        .route("/_frick/inspect/jobs", get(jobs))
        .route("/_frick/inspect/diagnostics", get(diagnostics))
        // DevTools / platform-events / analytics stubs (later stories).
        .route("/_frick/inspect/platform-events", get(stub_not_available))
        .route("/_frick/inspect/analytics/summary", get(stub_not_available))
        .route("/_frick/inspect/devtools/events", get(stub_devtools_events))
        .route(
            "/_frick/inspect/devtools/summary",
            get(stub_devtools_summary),
        )
        // Any other `/_frick/inspect/...` path → 404 `{error:"not_found"}`. A
        // prefix-scoped wildcard (NOT a router-wide `.fallback`, which would
        // collide when merged with sibling routers that also set one). Static
        // routes above take precedence over this wildcard in axum 0.7.
        .route("/_frick/inspect/", get(not_found))
        .route("/_frick/inspect/*rest", get(inspect_fallback))
        .with_state(state)
}

/// The shared inspect preamble: gate on `inspection_enabled` (else 404), then
/// resolve the inspect-tier principal (401 on failure). On success the caller
/// has been authorized to read the inspection surface.
async fn guard(state: &AppState, headers: &HeaderMap, request_id: &str) -> Result<(), Response> {
    if !state.config.inspection_enabled {
        return Err(not_found_response());
    }
    let now = now_ms();
    if let Err(error) = authenticate_inspect(state, headers, now).await {
        return Err(respond_error(&error, request_id));
    }
    Ok(())
}

/// The inspect-tier auth seam (`inspectionPrincipalFromRequest`,
/// `src/server.ts:3821-3839`). Parity with the TS rule (FR-278):
///   - **production**: the configured admin token is REQUIRED — a bearer equal
///     to `config.admin_token` authorizes; anything else (including a valid
///     session token) → 401 `auth.unauthenticated` "Missing or invalid admin
///     token";
///   - **non-production**: the admin token authorizes if it matches; otherwise
///     fall back to any active session principal (the data-plane 401s for a
///     missing/invalid token).
///
/// The admin-token match mirrors [`crate::routes::admin`]: a plain `==` against
/// `config.admin_token` (only when admin is enabled, i.e. a token is
/// configured), deliberately not constant-time.
async fn authenticate_inspect(
    state: &AppState,
    headers: &HeaderMap,
    now_ms: i64,
) -> Result<(), ServerError> {
    if admin_token_matches(state, headers) {
        return Ok(());
    }
    if state.config.env.is_production() {
        // Production demands the admin token; a session token is not enough.
        return Err(ServerError::Authentication {
            message: "Missing or invalid admin token".into(),
        });
    }
    // Non-production: fall back to any active session principal.
    require_principal(state, headers, now_ms).await.map(|_| ())
}

/// Whether the request carries a bearer equal to the configured admin token
/// (`adminPrincipalFromRequest`). `false` when admin is disabled (no token
/// configured) or the bearer is absent / mismatched.
fn admin_token_matches(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(admin_token) = state.config.admin_token.as_deref() else {
        return false;
    };
    session_token_from_headers(headers).as_deref() == Some(admin_token)
}

/// 404 `{error:"not_found"}` — the inspect "anything else" + disabled-surface
/// body (`src/server.ts` `sendJson(response, 404, { error: "not_found" })`).
fn not_found_response() -> Response {
    (
        StatusCode::NOT_FOUND,
        axum::Json(json!({ "error": "not_found" })),
    )
        .into_response()
}

/// `GET /_frick/inspect/server` (`src/server.ts:1218-1230`): schema identity +
/// the runtime feature flags + `startedAt`. This is the deployment-level view —
/// it reports the default app schema (`state.schema`) and `_default`; per-app
/// schemas on a multi-app server (FR-277) are listed by `/_frick/inspect/apps`.
async fn server(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let request_id = new_request_id();
    if let Err(response) = guard(&state, &headers, &request_id).await {
        return response;
    }
    axum::Json(json!({
        "schemaId": state.schema.schema_id,
        "schemaVersion": state.schema.schema_version,
        "schemaRevision": state.schema.schema_revision,
        "schemaHash": state.schema.hash,
        "appId": DEFAULT_APP_ID,
        "env": state.config.env.as_str(),
        "demoAuthEnabled": state.config.demo_auth_enabled,
        "inspectionEnabled": state.config.inspection_enabled,
        "startedAt": state.started_at,
    }))
    .into_response()
}

/// `GET /_frick/inspect/apps` (`src/server.ts:1231-1241`): the registered apps
/// from the app registry (FR-277) — `{id, basePath, schemaId, schemaRevision}`
/// per app. A single-app deployment reports the one `_default` app at the root
/// base path.
async fn apps(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let request_id = new_request_id();
    if let Err(response) = guard(&state, &headers, &request_id).await {
        return response;
    }
    let apps: Vec<serde_json::Value> = state
        .apps
        .descriptors()
        .into_iter()
        .map(|descriptor| {
            json!({
                "id": descriptor.id,
                "basePath": descriptor.base_path,
                "schemaId": descriptor.schema_id,
                "schemaRevision": descriptor.schema_revision,
            })
        })
        .collect();
    axum::Json(json!({ "apps": apps })).into_response()
}

/// `GET /_frick/inspect/migrations` (`src/server.ts:1242-1255`): the applied
/// framework migrations from the ledger (via the facade
/// `list_applied_migrations`). A read failure degrades to an empty list, matching
/// TS `safeListAppliedMigrations(...) ?? []`.
async fn migrations(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let request_id = new_request_id();
    if let Err(response) = guard(&state, &headers, &request_id).await {
        return response;
    }
    let applied = state
        .store
        .list_applied_migrations()
        .await
        .unwrap_or_default();
    let rows: Vec<serde_json::Value> = applied
        .iter()
        .map(|row| {
            json!({
                "id": row.id,
                "schemaRevision": row.schema_revision,
                "appliedAt": row.applied_at,
                "checksum": row.checksum,
                "durationMs": row.duration_ms,
            })
        })
        .collect();
    axum::Json(json!({ "applied": rows })).into_response()
}

/// `GET /_frick/inspect/metrics` (`src/server.ts:1256-1265`): the metrics
/// snapshot. The in-process metrics registry is a later story (TODO metrics), so
/// `counters`/`gauges` are empty maps for now; `snapshotAt` is the current ISO
/// time and `uptimeSeconds` is derived from the boot-stamped start. The empty
/// maps keep the dashboard's metrics view working (it renders zero series).
async fn metrics(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let request_id = new_request_id();
    if let Err(response) = guard(&state, &headers, &request_id).await {
        return response;
    }
    let now = now_ms();
    let uptime_seconds = uptime_seconds(&state.started_at, now);
    axum::Json(json!({
        "snapshotAt": crate::boot::iso_from_epoch_ms(now),
        "uptimeSeconds": uptime_seconds,
        // TODO(metrics): wire the in-process counter/gauge registry
        // (`src/metrics.ts`) once it lands; empty maps until then.
        "counters": json!({}),
        "gauges": json!({}),
    }))
    .into_response()
}

/// `GET /_frick/inspect/projections` (`src/server.ts:1281-1290`): the registered
/// projections with their sources + capability flags, from the shared projection
/// registry on [`AppState`].
async fn projections(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let request_id = new_request_id();
    if let Err(response) = guard(&state, &headers, &request_id).await {
        return response;
    }
    let descriptors = state.projections.descriptors();
    let rows: Vec<serde_json::Value> = descriptors
        .iter()
        .map(|descriptor| {
            json!({
                "name": descriptor.name,
                "sources": descriptor
                    .sources
                    .iter()
                    .map(|source| json!({
                        "kind": source.kind.as_str(),
                        "type": source.type_name,
                    }))
                    .collect::<Vec<_>>(),
                "supportsRebuild": descriptor.supports_rebuild,
                "supportsRead": descriptor.supports_read,
            })
        })
        .collect();
    axum::Json(json!({ "projections": rows })).into_response()
}

/// `GET /_frick/inspect/search` (`src/server.ts:1291-1300`): the search adapter
/// id + the registered indexes (`{name, source:{kind, type|name}}`) from the
/// shared search registry on [`AppState`] (FR-245, map 03 §13).
async fn search(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let request_id = new_request_id();
    if let Err(response) = guard(&state, &headers, &request_id).await {
        return response;
    }
    let indexes: Vec<serde_json::Value> = state
        .search
        .descriptors()
        .iter()
        .map(|descriptor| {
            json!({
                "name": descriptor.name,
                "source": {
                    "kind": descriptor.source.kind_str(),
                    "type": descriptor.source.type_or_name(),
                },
            })
        })
        .collect();
    axum::Json(json!({
        "adapter": state.store.search_adapter_id(),
        "indexes": indexes,
    }))
    .into_response()
}

/// `GET /_frick/inspect/db` (`src/server.ts:1301-1322`): readiness, applied
/// count, the last applied migration, and the idempotency-cache stats. The
/// in-process cache stats are not exposed by the facade yet (TODO), so they are
/// reported as zeros with the configured/default capacity; `ready` + the applied
/// counts are real.
async fn db(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let request_id = new_request_id();
    if let Err(response) = guard(&state, &headers, &request_id).await {
        return response;
    }
    let ready = state.store.ping_database().await;
    let applied = state
        .store
        .list_applied_migrations()
        .await
        .unwrap_or_default();
    let mut body = json!({
        "ready": ready,
        "applied": applied.len(),
        // TODO(idempotency-stats): the facade does not yet expose the bounded
        // cache's size/capacity/evictions; report zeros until a getter lands.
        "idempotencyCache": {
            "size": 0,
            "capacity": 0,
            "evictions": 0,
        },
    });
    if let Some(last) = applied.last()
        && let Some(map) = body.as_object_mut()
    {
        map.insert(
            "lastApplied".to_string(),
            json!({
                "id": last.id,
                "schemaRevision": last.schema_revision,
                "appliedAt": last.applied_at,
            }),
        );
    }
    axum::Json(body).into_response()
}

/// `GET /_frick/inspect/jobs` (`src/server.ts:1323-1330`): registered job
/// handlers, per-status counts, and whether the worker is enabled. The job
/// registry + worker are later stories, so `registeredHandlers` is empty and
/// `workerEnabled` is `false`; `counts` is the real per-status snapshot from the
/// job store. The `counts` keys mirror the TS `JobCounts` object literal exactly
/// (`ready`/`running`/`completed`/`dead_lettered`/`failed`).
async fn jobs(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let request_id = new_request_id();
    if let Err(response) = guard(&state, &headers, &request_id).await {
        return response;
    }
    let counts = state
        .store
        .jobs()
        .counts_by_status()
        .await
        .unwrap_or_default();
    axum::Json(json!({
        // TODO(jobs): list the registered handler names once the job registry
        // is wired into AppState.
        "registeredHandlers": json!([]),
        "counts": {
            "ready": counts.ready,
            "running": counts.running,
            "completed": counts.completed,
            "dead_lettered": counts.dead_lettered,
            "failed": counts.failed,
        },
        // TODO(jobs): reflect the real worker-enabled flag once the worker lands.
        "workerEnabled": false,
    }))
    .into_response()
}

/// `GET /_frick/inspect/diagnostics` (FR-76, FR-262): the full structured
/// diagnostics snapshot (`assembleDiagnosticsSnapshot`). Gated/authorized like
/// every sibling inspect route, then assembled from the store + active schema.
///
/// This handler is the determinism boundary: it stamps `snapshotAt` (ISO from
/// the system clock), `startedAt` (the boot-stamped ISO), and `uptimeSeconds`,
/// then hands them to the clock-free [`assemble_diagnostics_snapshot`]. Because
/// it runs on a live server it reports `source: "server"` and includes the
/// negotiated capabilities block.
///
/// Optional cursor probes ride the query string as repeated
/// `?cursor=<stream>:<streamId>` params (the CLI passes them as positionals);
/// `?tenantId=<id>` applies to every probe. A malformed `cursor` (no `:`) is
/// skipped rather than erroring, so a bad probe degrades gracefully.
async fn diagnostics(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::RawQuery(raw_query): axum::extract::RawQuery,
) -> Response {
    let request_id = new_request_id();
    if let Err(response) = guard(&state, &headers, &request_id).await {
        return response;
    }

    let now = now_ms();
    let probes = parse_cursor_probes(raw_query.as_deref());
    let opts = crate::diagnostics::AssembleDiagnosticsOptions {
        source: Some("server".to_string()),
        env: Some(state.config.env.as_str().to_string()),
        recent_error_limit: None,
        cursors: probes,
        snapshot_at: crate::boot::iso_from_epoch_ms(now),
        last_successful_sync_at: None,
        started_at: Some(state.started_at.clone()),
        uptime_seconds: Some(uptime_seconds(&state.started_at, now)),
        include_capabilities: true,
    };
    let snapshot =
        crate::diagnostics::assemble_diagnostics_snapshot(&state.store, &state.schema, &opts).await;
    axum::Json(snapshot).into_response()
}

/// Parse repeated `cursor=<stream>:<streamId>` query params into probes, applying
/// a single shared `tenantId=<id>` to all of them (mirrors the CLI's
/// `--tenant-id` applying to every positional probe). Malformed `cursor` values
/// (missing the `:` separator, empty stream/id) are dropped.
fn parse_cursor_probes(raw_query: Option<&str>) -> Vec<crate::diagnostics::DiagnosticsCursorProbe> {
    let Some(query) = raw_query else {
        return Vec::new();
    };
    let mut tenant_id: Option<String> = None;
    let mut raw_probes: Vec<(String, String)> = Vec::new();
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let value = decode_query_component(value);
        match key {
            "tenantId" if !value.is_empty() => tenant_id = Some(value),
            "cursor" => {
                if let Some((stream, stream_id)) = value.split_once(':')
                    && !stream.is_empty()
                    && !stream_id.is_empty()
                {
                    raw_probes.push((stream.to_string(), stream_id.to_string()));
                }
            }
            _ => {}
        }
    }
    raw_probes
        .into_iter()
        .map(
            |(stream, stream_id)| crate::diagnostics::DiagnosticsCursorProbe {
                tenant_id: tenant_id.clone(),
                stream,
                stream_id,
            },
        )
        .collect()
}

/// Minimal `application/x-www-form-urlencoded` component decode: `+` → space and
/// `%XX` → byte. Good enough for the stream/tenant ids these probes carry (which
/// are `[A-Za-z0-9_.:-]`-shaped); unparseable escapes are left literal.
fn decode_query_component(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(hi), Some(lo)) = (hi, lo) {
                    #[allow(clippy::cast_possible_truncation)]
                    out.push((hi * 16 + lo) as u8);
                    i += 3;
                } else {
                    out.push(b'%');
                    i += 1;
                }
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Stub for `platform-events` / `analytics/summary` (later stories): authorize
/// like every inspect route, then return an empty object so the console renders
/// "no data" rather than failing.
async fn stub_not_available(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let request_id = new_request_id();
    if let Err(response) = guard(&state, &headers, &request_id).await {
        return response;
    }
    // TODO(platform-events / analytics): port the pipeline health + analytics
    // summary builders; empty body until then.
    axum::Json(json!({})).into_response()
}

/// Stub for `devtools/events` (later story): empty newest-first feed.
async fn stub_devtools_events(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let request_id = new_request_id();
    if let Err(response) = guard(&state, &headers, &request_id).await {
        return response;
    }
    // TODO(devtools): durable DevTools event feed is FR-249.
    axum::Json(json!({ "events": json!([]) })).into_response()
}

/// Stub for `devtools/summary` (later story): empty per-kind aggregate.
async fn stub_devtools_summary(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let request_id = new_request_id();
    if let Err(response) = guard(&state, &headers, &request_id).await {
        return response;
    }
    // TODO(devtools): per-kind rolling-window summary is FR-249.
    axum::Json(json!({})).into_response()
}

/// `GET /_frick/inspect/` (trailing slash, no sub-path) → 404 `not_found`,
/// matching the TS "anything else" arm. Still gated/authorized so a disabled or
/// unauthenticated request gets the right status before the 404.
async fn not_found(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let request_id = new_request_id();
    if let Err(response) = guard(&state, &headers, &request_id).await {
        return response;
    }
    not_found_response()
}

/// Fallback for unknown `/_frick/inspect/...` sub-paths. Unlike the named
/// routes this cannot inspect state for the guard (axum fallbacks take no state
/// param), but the TS surface returns 404 `{error:"not_found"}` for any unknown
/// sub-path regardless of auth, so a bare 404 is faithful here.
async fn inspect_fallback() -> Response {
    not_found_response()
}

/// `uptimeSeconds` = (now - startedAt) / 1000, floored at 0. The TS uses
/// `performance.now()` deltas; we derive from the boot-stamped ISO `startedAt`,
/// which is within clock resolution of the same value.
fn uptime_seconds(started_at_iso: &str, now_ms: i64) -> f64 {
    let Some(started_ms) = parse_iso_to_epoch_ms(started_at_iso) else {
        return 0.0;
    };
    let delta = (now_ms - started_ms).max(0);
    #[allow(clippy::cast_precision_loss)]
    {
        delta as f64 / 1000.0
    }
}

/// Parse a `Date.toISOString()`-shaped UTC timestamp (`YYYY-MM-DDTHH:MM:SS.mmmZ`)
/// to epoch milliseconds. Returns `None` on any shape mismatch (the caller then
/// reports `uptimeSeconds: 0`). Mirrors the store's own ISO parser closely
/// enough for the uptime delta.
fn parse_iso_to_epoch_ms(iso: &str) -> Option<i64> {
    // Expected: 1970-01-01T00:00:00.000Z (24 chars). Be lenient on the fraction.
    let bytes = iso.as_bytes();
    if bytes.len() < 20 || !iso.ends_with('Z') {
        return None;
    }
    let year: i64 = iso.get(0..4)?.parse().ok()?;
    let month: i64 = iso.get(5..7)?.parse().ok()?;
    let day: i64 = iso.get(8..10)?.parse().ok()?;
    let hour: i64 = iso.get(11..13)?.parse().ok()?;
    let minute: i64 = iso.get(14..16)?.parse().ok()?;
    let second: i64 = iso.get(17..19)?.parse().ok()?;
    let milli: i64 = if iso.len() >= 24 {
        iso.get(20..23)?.parse().ok()?
    } else {
        0
    };
    let days = days_from_civil(year, month, day);
    Some(((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000) + milli)
}

/// Days since 1970-01-01 for a civil (year, month, day). Howard Hinnant's
/// algorithm — the inverse of `boot::civil_from_days`.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_round_trips_through_epoch_ms() {
        // boot::iso_from_epoch_ms(now) parsed back must equal now.
        for now in [0_i64, 1_700_000_000_123, 1_000] {
            let iso = crate::boot::iso_from_epoch_ms(now);
            assert_eq!(parse_iso_to_epoch_ms(&iso), Some(now), "{iso}");
        }
    }

    #[test]
    fn uptime_is_non_negative_and_scaled() {
        let started = crate::boot::iso_from_epoch_ms(1_000_000);
        // 2.5 s later.
        assert!((uptime_seconds(&started, 1_002_500) - 2.5).abs() < 1e-9);
        // A clock that went backwards floors at 0.
        assert!(uptime_seconds(&started, 500_000).abs() < f64::EPSILON);
    }

    #[test]
    fn malformed_iso_yields_zero_uptime() {
        assert!(uptime_seconds("not-a-date", 5_000).abs() < f64::EPSILON);
    }
}
