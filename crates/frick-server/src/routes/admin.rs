//! Admin routes — `/_frick/admin/*` (map 02 §4.6;
//! `handleAdminRoute`, `src/server.ts:3913-5065`).
//!
//! # Auth (admin tier)
//!
//! Every admin route authenticates the **admin bearer token**: the request's
//! `Authorization: Bearer <t>` (or `x-frick-session-token`) must equal
//! `config.admin_token` exactly (`adminPrincipalFromRequest`,
//! `src/server.ts:3848-3867`). The comparison is a plain `==`, deliberately not
//! constant-time, matching the TS. `admin_enabled` is "a token is configured"
//! (`config.admin_enabled()`).
//!
//! When admin is disabled (no token) **the whole `/_frick/admin/` surface
//! 404s** before any auth check (`src/server.ts:1383-1386`). A wrong/missing
//! bearer when admin IS enabled distinguishes (`src/server.ts:1392-1417`):
//!   - no bearer at all → 401 `auth.unauthenticated` "Missing admin token";
//!   - a bearer that is a valid *session* token (but not admin) → 403
//!     `auth.forbidden` "Admin scope required";
//!   - any other bearer → 401 `auth.unauthenticated` "Invalid admin token".
//!
//! The authenticated principal is the fixed [`Principal::admin`].
//!
//! # Audit
//!
//! Every MUTATION writes a hash-chained `admin_audit_log` row via
//! `store.admin_audit().record(...)` (map 03 §9.8). The TS has two flavours:
//!   - `strictAudit`: a write failure aborts the request as
//!     `AdminAuditWriteError` → 500 `sync.protocolError` with
//!     `details.reason = "adminAuditWriteFailed"` ([`ServerError::AdminAuditWrite`]);
//!   - `audit`: a write failure is swallowed (losing one row beats failing a
//!     legitimate admin call).
//!
//! The actor is the admin-token fingerprint: `sha256(admin_token)` hex truncated
//! to 12 chars (`src/server.ts:647-649`).
//!
//! # Routes implemented here
//!
//! `GET audit-log`, `POST sessions/revoke`, `GET tenants`, `POST tenants`,
//! `POST tenants/:id/archive`, `GET tenants/:id`, `GET tenants/:id/settings`,
//! `PUT tenants/:id/settings/:key`. The remaining admin routes (accounts, jobs,
//! push creds, backup/restore, compliance, schema lint, rebuilds) are later
//! stories; an unmatched admin path returns 404 `{error:"not_found"}` as the TS
//! "anything else" arm does.
//!
//! # Integrator wiring
//!
//! Expose [`admin_router`]; the integrator merges it onto the boot router
//! alongside [`super::inspect::inspect_router`]:
//!
//! ```ignore
//! let router = public_router(state.clone())
//!     .merge(auth_router(state.clone()))
//!     .merge(dataplane_router(state.clone()))
//!     .merge(crate::routes::admin::admin_router(state.clone()))
//!     .merge(crate::routes::inspect::inspect_router(state.clone()))
//!     .merge(gateway.router());
//! ```
//!
//! and `routes/mod.rs` gains `pub mod admin;` + `pub mod inspect;`. No
//! `AppState` or facade additions are required — every dependency
//! (`config.admin_token`, `store.sessions()`, `store.tenants()`,
//! `store.tenant_settings()`, `store.admin_audit()`) already exists.
//!
//! # Determinism
//!
//! `now_ms` for `tenants.create`/`archive`, the tenant-settings `updated_at`,
//! and the audit `occurred_at` enters once per request from the system clock at
//! the route boundary and threads into the store methods.

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use frick_protocol::{FrickErrorCode, FrickErrorEnvelope, Value, foundation_schema};
use frick_store::stores::admin_audit::{AdminAuditInput, AdminAuditListOptions, AdminAuditOutcome};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use super::{map_get, new_request_id, now_ms, parse_body_value};
use crate::error::ServerError;
use crate::extract::session_token_from_headers;
use crate::http::{AppState, respond_error};
use crate::principal::Principal;

/// Build the admin router (`admin_router`). See the module docs for the
/// integrator wiring. Each handler runs the admin-token auth preamble first; a
/// server with admin disabled 404s every admin path.
pub fn admin_router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/_frick/admin/audit-log", get(audit_log))
        .route("/_frick/admin/sessions/revoke", post(sessions_revoke))
        .route(
            "/_frick/admin/tenants",
            get(list_tenants).post(create_tenant),
        )
        .route("/_frick/admin/tenants/:id", get(show_tenant))
        .route("/_frick/admin/tenants/:id/archive", post(archive_tenant))
        .route("/_frick/admin/tenants/:id/settings", get(list_settings))
        .route("/_frick/admin/tenants/:id/settings/:key", put(put_setting))
        // Any other `/_frick/admin/...` path → 404 `{error:"not_found"}`
        // (later stories + the TS "anything else" arm). A prefix-scoped
        // wildcard (NOT a router-wide `.fallback`, which would collide when
        // merged with sibling routers that also set one). Static routes above
        // take precedence over this wildcard in axum 0.7.
        .route(
            "/_frick/admin/*rest",
            get(admin_fallback)
                .post(admin_fallback)
                .put(admin_fallback)
                .delete(admin_fallback),
        )
        .with_state(state)
}

// ---- auth preamble -----------------------------------------------------------

/// The admin-token fingerprint carried into every audit row this request writes
/// (the `record` actor). Produced once after a successful auth.
struct AdminAuth {
    fingerprint: String,
}

/// Authenticate the admin bearer (`adminPrincipalFromRequest` +
/// `src/server.ts:1383-1417`). Returns `Ok(AdminAuth)` on a matching token, or
/// an [`Response`] carrying the right status:
///   - admin disabled → 404 `{error:"not_found"}`;
///   - no bearer → 401 `auth.unauthenticated`;
///   - bearer is an active session (not admin) → 403 `auth.forbidden`;
///   - any other bearer → 401 `auth.unauthenticated`.
async fn authenticate_admin(
    state: &AppState,
    headers: &HeaderMap,
    request_id: &str,
) -> Result<(AdminAuth, Principal), Response> {
    let Some(admin_token) = state.config.admin_token.as_deref() else {
        // Admin disabled: the whole surface 404s.
        return Err(not_found_response());
    };

    let bearer = session_token_from_headers(headers);
    if bearer.as_deref() == Some(admin_token) {
        return Ok((
            AdminAuth {
                fingerprint: admin_token_fingerprint(admin_token),
            },
            Principal::admin(),
        ));
    }

    // Wrong or missing token: distinguish "no auth" / "valid session but not
    // admin" / "bad token" exactly like the TS.
    let Some(token) = bearer else {
        return Err(respond_error(
            &ServerError::Authentication {
                message: "Missing admin token".into(),
            },
            request_id,
        ));
    };
    // A valid session token (for a tenant-scoped principal) → 403, else 401.
    let now = now_ms();
    let is_active_session = state
        .store
        .sessions()
        .read_active(&token, now)
        .await
        .is_ok_and(|session| session.is_some());
    if is_active_session {
        return Err(respond_error(
            &ServerError::Authorization {
                message: "Admin scope required".into(),
                reason: Some("notAuthorizedForResource".into()),
            },
            request_id,
        ));
    }
    Err(respond_error(
        &ServerError::Authentication {
            message: "Invalid admin token".into(),
        },
        request_id,
    ))
}

/// `sha256(admin_token)` hex truncated to 12 chars (`src/server.ts:647-649`).
fn admin_token_fingerprint(admin_token: &str) -> String {
    let digest = Sha256::digest(admin_token.as_bytes());
    // 12 hex chars == the first 6 bytes; encode them by hand (no `hex` dep).
    let mut out = String::with_capacity(12);
    for byte in &digest[..6] {
        out.push(nibble(byte >> 4));
        out.push(nibble(byte & 0x0f));
    }
    out
}

fn nibble(value: u8) -> char {
    char::from_digit(u32::from(value), 16).unwrap_or('0')
}

// ---- audit helpers -----------------------------------------------------------

/// Best-effort audit (`audit`, `src/server.ts:3930-3947`): record a row,
/// swallowing any failure. Used for read-side audits (settings list).
async fn audit(
    state: &AppState,
    auth: &AdminAuth,
    action: &str,
    target: Option<&str>,
    outcome: AdminAuditOutcome,
    detail: Option<serde_json::Value>,
    now_ms: i64,
) {
    let input = AdminAuditInput {
        admin_token_fingerprint: auth.fingerprint.clone(),
        action: action.to_string(),
        target: target.map(str::to_string),
        outcome,
        detail: detail.map(|value| value.to_string()),
    };
    // Failure is swallowed — losing one row beats failing a legitimate call.
    let _ = state.store.admin_audit().record(&input, now_ms).await;
}

/// Strict audit (`strictAudit`, `src/server.ts:3948-3965`): record a row; a
/// failure becomes [`ServerError::AdminAuditWrite`] (→ 500 `sync.protocolError`,
/// `details.reason = "adminAuditWriteFailed"`).
async fn strict_audit(
    state: &AppState,
    auth: &AdminAuth,
    action: &str,
    target: Option<&str>,
    outcome: AdminAuditOutcome,
    detail: Option<serde_json::Value>,
    now_ms: i64,
) -> Result<(), ServerError> {
    let input = AdminAuditInput {
        admin_token_fingerprint: auth.fingerprint.clone(),
        action: action.to_string(),
        target: target.map(str::to_string),
        outcome,
        detail: detail.map(|value| value.to_string()),
    };
    state
        .store
        .admin_audit()
        .record(&input, now_ms)
        .await
        .map(|_| ())
        .map_err(|_| ServerError::AdminAuditWrite)
}

// ---- routes ------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct AuditLogQuery {
    since: Option<String>,
    action: Option<String>,
    limit: Option<String>,
}

/// `GET /_frick/admin/audit-log` (`src/server.ts:3968-3982`): the hash-chained
/// audit rows filtered by `?since=&action=&limit=` → `{entries}`. A non-numeric
/// `limit` is ignored (the store applies its default + clamp), mirroring TS
/// `Number.parseInt` + `Number.isFinite`.
async fn audit_log(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AuditLogQuery>,
) -> Response {
    let request_id = new_request_id();
    let (_auth, _admin) = match authenticate_admin(&state, &headers, &request_id).await {
        Ok(result) => result,
        Err(response) => return response,
    };

    let options = AdminAuditListOptions {
        since: query.since,
        action: query.action,
        limit: query
            .limit
            .as_deref()
            .and_then(|raw| raw.trim().parse::<i64>().ok()),
    };
    match state.store.admin_audit().list(&options).await {
        Ok(rows) => {
            let entries: Vec<serde_json::Value> = rows.iter().map(audit_row_to_json).collect();
            axum::Json(json!({ "entries": entries })).into_response()
        }
        Err(error) => respond_error(
            &ServerError::BadRequest {
                message: error.to_string(),
            },
            &request_id,
        ),
    }
}

/// `POST /_frick/admin/sessions/revoke` (`src/server.ts:3984-4044`). Revoke by
/// `userId` (every session, optionally scoped to one `tenantId`) and/or by a
/// single `sessionToken`; 400 `missingTarget` when neither is supplied.
///
/// The Rust port deletes the session rows (`store.sessions().delete_for_user` /
/// `delete`); the WS live-disconnect is a TODO (the gateway has no
/// `closeSession`/`closeSessionsForUser` seam yet), so `disconnected` is `0` for
/// now. Future wiring: thread the gateway into AppState and call its close
/// methods here.
async fn sessions_revoke(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let request_id = new_request_id();
    let (auth, _admin) = match authenticate_admin(&state, &headers, &request_id).await {
        Ok(result) => result,
        Err(response) => return response,
    };
    let now = now_ms();

    let value = match parse_body_value(&body) {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    let user_id = non_empty_str(&value, "userId");
    let session_token = non_empty_str(&value, "sessionToken");
    let tenant_id = non_empty_str(&value, "tenantId");

    if user_id.is_none() && session_token.is_none() {
        if let Err(error) = strict_audit(
            &state,
            &auth,
            "sessions.revoke",
            None,
            AdminAuditOutcome::Deny,
            Some(json!({ "reason": "missingTarget" })),
            now,
        )
        .await
        {
            return respond_error(&error, &request_id);
        }
        return inline_envelope(
            StatusCode::BAD_REQUEST,
            FrickErrorCode::SyncProtocolError,
            "Provide a userId or a sessionToken to revoke",
            "admin_session_revoke_invalid",
            vec![(Value::from("reason"), Value::from("missingTarget"))],
        );
    }

    let mut revoked: u64 = 0;
    let disconnected: u64 = 0; // TODO(gateway): live WS disconnect.

    if let Some(user_id) = &user_id {
        match state
            .store
            .sessions()
            .delete_for_user(user_id, tenant_id.as_deref())
            .await
        {
            Ok(count) => revoked += count,
            Err(error) => return respond_error(&store_error(&error), &request_id),
        }
    }
    if let Some(token) = &session_token {
        match state.store.sessions().delete(token).await {
            Ok(true) => revoked += 1,
            Ok(false) => {}
            Err(error) => return respond_error(&store_error(&error), &request_id),
        }
    }

    let mut detail = serde_json::Map::new();
    if let Some(user_id) = &user_id {
        detail.insert("userId".into(), json!(user_id));
    }
    if let Some(tenant_id) = &tenant_id {
        detail.insert("tenantId".into(), json!(tenant_id));
    }
    if session_token.is_some() {
        detail.insert("byToken".into(), json!(true));
    }
    detail.insert("revoked".into(), json!(revoked));
    detail.insert("disconnected".into(), json!(disconnected));

    if let Err(error) = strict_audit(
        &state,
        &auth,
        "sessions.revoke",
        user_id.as_deref(),
        AdminAuditOutcome::Allow,
        Some(serde_json::Value::Object(detail)),
        now,
    )
    .await
    {
        return respond_error(&error, &request_id);
    }

    axum::Json(json!({ "revoked": revoked, "disconnected": disconnected })).into_response()
}

#[derive(Debug, Default, Deserialize)]
struct TenantsQuery {
    #[serde(rename = "includeArchived")]
    include_archived: Option<String>,
}

/// `GET /_frick/admin/tenants` (`src/server.ts:4046-4053`): `?includeArchived` →
/// `{tenants}`. Reads are deliberately NOT audited (the admin UI polls this).
async fn list_tenants(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TenantsQuery>,
) -> Response {
    let request_id = new_request_id();
    if let Err(response) = authenticate_admin(&state, &headers, &request_id).await {
        return response;
    }
    let include_archived = query.include_archived.as_deref() == Some("true");
    match state.store.tenants().list(include_archived).await {
        Ok(rows) => {
            let tenants: Vec<serde_json::Value> = rows.iter().map(tenant_row_to_json).collect();
            axum::Json(json!({ "tenants": tenants })).into_response()
        }
        Err(error) => respond_error(&store_error(&error), &request_id),
    }
}

/// `POST /_frick/admin/tenants` (`src/server.ts:4055-4138`). `{tenantId,
/// displayName?}` → 201 row. A non-archived tenant already present → 409 with
/// the inline `sync.protocolError` envelope carrying
/// `details.reason = "tenantExists"`. The create itself revives an archived
/// tenant (the store's `create` semantics).
async fn create_tenant(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let request_id = new_request_id();
    let (auth, _admin) = match authenticate_admin(&state, &headers, &request_id).await {
        Ok(result) => result,
        Err(response) => return response,
    };
    let now = now_ms();

    let value = match parse_body_value(&body) {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    let Some(tenant_id) = non_empty_str(&value, "tenantId") else {
        return respond_error(
            &ServerError::BadRequest {
                message: "tenantId is required".into(),
            },
            &request_id,
        );
    };
    let display_name = non_empty_str(&value, "displayName");

    // Existence pre-check (a non-archived row → 409 `tenantExists`).
    match state.store.tenants().get(&tenant_id).await {
        Ok(Some(existing)) if existing.archived_at.is_none() => {
            if let Err(error) = strict_audit(
                &state,
                &auth,
                "tenants.create",
                Some(&tenant_id),
                AdminAuditOutcome::Deny,
                Some(json!({ "reason": "tenantExists" })),
                now,
            )
            .await
            {
                return respond_error(&error, &request_id);
            }
            return tenant_exists_conflict(&tenant_id);
        }
        Ok(_) => {}
        Err(error) => return respond_error(&store_error(&error), &request_id),
    }

    if let Err(error) = strict_audit(
        &state,
        &auth,
        "tenants.create",
        Some(&tenant_id),
        AdminAuditOutcome::Allow,
        display_name
            .as_deref()
            .map(|name| json!({ "displayName": name })),
        now,
    )
    .await
    {
        return respond_error(&error, &request_id);
    }

    match state
        .store
        .tenants()
        .create(&tenant_id, display_name.as_deref(), now)
        .await
    {
        Ok(row) => (StatusCode::CREATED, axum::Json(tenant_row_to_json(&row))).into_response(),
        // `TenantAlreadyExistsError` (raced past the pre-check) → 409.
        Err(error) if is_already_exists(&error) => tenant_exists_conflict(&tenant_id),
        Err(error) => respond_error(&store_error(&error), &request_id),
    }
}

/// `POST /_frick/admin/tenants/:id/archive` (`src/server.ts:4140-4170`): 404
/// `tenant_not_found` for an absent tenant, else archive + 200 with the archived
/// row.
async fn archive_tenant(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(tenant_id): Path<String>,
) -> Response {
    let request_id = new_request_id();
    let (auth, _admin) = match authenticate_admin(&state, &headers, &request_id).await {
        Ok(result) => result,
        Err(response) => return response,
    };
    let now = now_ms();

    match state.store.tenants().get(&tenant_id).await {
        Ok(None) => {
            if let Err(error) = strict_audit(
                &state,
                &auth,
                "tenants.archive",
                Some(&tenant_id),
                AdminAuditOutcome::Deny,
                Some(json!({ "reason": "tenantNotFound" })),
                now,
            )
            .await
            {
                return respond_error(&error, &request_id);
            }
            return tenant_not_found_response();
        }
        Ok(Some(_)) => {}
        Err(error) => return respond_error(&store_error(&error), &request_id),
    }

    if let Err(error) = strict_audit(
        &state,
        &auth,
        "tenants.archive",
        Some(&tenant_id),
        AdminAuditOutcome::Allow,
        None,
        now,
    )
    .await
    {
        return respond_error(&error, &request_id);
    }

    if let Err(error) = state.store.tenants().archive(&tenant_id, now).await {
        return respond_error(&store_error(&error), &request_id);
    }
    match state.store.tenants().get(&tenant_id).await {
        Ok(Some(row)) => axum::Json(tenant_row_to_json(&row)).into_response(),
        // Should not happen (we just archived it), but mirror the TS which
        // sends whatever `get` returns.
        Ok(None) => tenant_not_found_response(),
        Err(error) => respond_error(&store_error(&error), &request_id),
    }
}

/// `GET /_frick/admin/tenants/:id` (`src/server.ts:4226-4244`): the row, or 404
/// `tenant_not_found`. Reads are not audited.
async fn show_tenant(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(tenant_id): Path<String>,
) -> Response {
    let request_id = new_request_id();
    if let Err(response) = authenticate_admin(&state, &headers, &request_id).await {
        return response;
    }
    match state.store.tenants().get(&tenant_id).await {
        Ok(Some(row)) => axum::Json(tenant_row_to_json(&row)).into_response(),
        Ok(None) => tenant_not_found_response(),
        Err(error) => respond_error(&store_error(&error), &request_id),
    }
}

/// `GET /_frick/admin/tenants/:id/settings` (`src/server.ts:4174-4193`):
/// `{tenantId, settings}`. Audited best-effort (`audit`, not strict).
async fn list_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(tenant_id): Path<String>,
) -> Response {
    let request_id = new_request_id();
    let (auth, _admin) = match authenticate_admin(&state, &headers, &request_id).await {
        Ok(result) => result,
        Err(response) => return response,
    };
    let now = now_ms();

    match state.store.tenant_settings().list(&tenant_id).await {
        Ok(settings) => {
            audit(
                &state,
                &auth,
                "tenants.settings.list",
                Some(&tenant_id),
                AdminAuditOutcome::Allow,
                None,
                now,
            )
            .await;
            // BTreeMap → a JSON object (ascending key order).
            let settings_obj: serde_json::Map<String, serde_json::Value> =
                settings.into_iter().collect();
            axum::Json(json!({
                "tenantId": tenant_id,
                "settings": serde_json::Value::Object(settings_obj),
            }))
            .into_response()
        }
        Err(error) => {
            audit(
                &state,
                &auth,
                "tenants.settings.list",
                Some(&tenant_id),
                AdminAuditOutcome::Error,
                Some(json!({ "error": error.to_string() })),
                now,
            )
            .await;
            respond_error(&store_error(&error), &request_id)
        }
    }
}

/// `PUT /_frick/admin/tenants/:id/settings/:key` (`src/server.ts:4195-4224`).
/// The body is ANY JSON value (number/string/object — NOT required to be an
/// object), so an empty body stores `null`. → `{tenantId, key, value}`.
async fn put_setting(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((tenant_id, key)): Path<(String, String)>,
    body: axum::body::Bytes,
) -> Response {
    let request_id = new_request_id();
    let (auth, _admin) = match authenticate_admin(&state, &headers, &request_id).await {
        Ok(result) => result,
        Err(response) => return response,
    };
    let now = now_ms();

    // The body can be any JSON value. An empty body is `null` (TS: `value =
    // null` when `raw.byteLength === 0`); a non-empty body must parse as JSON.
    let value: serde_json::Value = if body.iter().all(u8::is_ascii_whitespace) {
        serde_json::Value::Null
    } else {
        match serde_json::from_slice(&body) {
            Ok(value) => value,
            Err(parse_error) => {
                if let Err(error) = strict_audit(
                    &state,
                    &auth,
                    "tenants.settings.put",
                    Some(&format!("{tenant_id}/{key}")),
                    AdminAuditOutcome::Error,
                    Some(json!({ "error": format!("body must be a valid JSON value ({parse_error})") })),
                    now,
                )
                .await
                {
                    return respond_error(&error, &request_id);
                }
                return respond_error(
                    &ServerError::BadRequest {
                        message: format!("body must be a valid JSON value ({parse_error})"),
                    },
                    &request_id,
                );
            }
        }
    };

    if let Err(error) = strict_audit(
        &state,
        &auth,
        "tenants.settings.put",
        Some(&format!("{tenant_id}/{key}")),
        AdminAuditOutcome::Allow,
        None,
        now,
    )
    .await
    {
        return respond_error(&error, &request_id);
    }

    if let Err(error) = state
        .store
        .tenant_settings()
        .set(&tenant_id, &key, &value, now)
        .await
    {
        return respond_error(&store_error(&error), &request_id);
    }

    axum::Json(json!({ "tenantId": tenant_id, "key": key, "value": value })).into_response()
}

/// Admin catch-all (`src/server.ts` "anything else" arm): admin-gate the
/// request first (so a disabled server 404s and a bad token 401/403s, matching
/// the TS ordering where auth runs before sub-path dispatch), then 404
/// `{error:"not_found"}` for the unhandled admin sub-path.
async fn admin_fallback(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let request_id = new_request_id();
    if let Err(response) = authenticate_admin(&state, &headers, &request_id).await {
        return response;
    }
    not_found_response()
}

// ---- response builders -------------------------------------------------------

/// 404 `{error:"not_found"}` — admin-disabled + unknown-route body.
fn not_found_response() -> Response {
    (
        StatusCode::NOT_FOUND,
        axum::Json(json!({ "error": "not_found" })),
    )
        .into_response()
}

/// 404 `{error:"tenant_not_found"}`.
fn tenant_not_found_response() -> Response {
    (
        StatusCode::NOT_FOUND,
        axum::Json(json!({ "error": "tenant_not_found" })),
    )
        .into_response()
}

/// The inline 409 conflict for an existing tenant (`src/server.ts:4073-4089`):
/// `sync.protocolError` envelope with `details {reason:"tenantExists", tenantId}`
/// and the request id `admin_tenant_conflict`.
fn tenant_exists_conflict(tenant_id: &str) -> Response {
    inline_envelope(
        StatusCode::CONFLICT,
        FrickErrorCode::SyncProtocolError,
        &format!("Tenant {tenant_id} already exists"),
        "admin_tenant_conflict",
        vec![
            (Value::from("reason"), Value::from("tenantExists")),
            (Value::from("tenantId"), Value::from(tenant_id)),
        ],
    )
}

/// Build an inline error-envelope response with explicit code/message/requestId
/// and `details` entries, stamping the foundation schema hash/revision (the TS
/// per-route envelopes use `foundationSchema`). The `routeCode` detail mirrors
/// `respond_error`'s envelope (`details.routeCode = requestId`).
fn inline_envelope(
    status: StatusCode,
    code: FrickErrorCode,
    message: &str,
    request_id: &str,
    extra_details: Vec<(Value, Value)>,
) -> Response {
    let foundation = foundation_schema();
    let mut details = vec![(Value::from("routeCode"), Value::from(request_id))];
    details.extend(extra_details);
    let envelope = FrickErrorEnvelope {
        code,
        message: message.to_string(),
        request_id: request_id.to_string(),
        retryable: false,
        details: Some(Value::Map(details)),
        schema_hash: Some(foundation.hash.clone()),
        schema_revision: Some(foundation.schema_revision),
    };
    let body = json!({
        "error": envelope,
        "code": envelope.code.as_str(),
        "message": envelope.message,
        "requestId": envelope.request_id,
        "retryable": envelope.retryable,
    });
    (status, axum::Json(body)).into_response()
}

// ---- mappers / helpers -------------------------------------------------------

/// Pull a non-empty string field off a msgpack-map body, else `None` (matching
/// the TS `typeof x === "string" && x.length > 0 ? x : undefined`).
fn non_empty_str(body: &Value, key: &str) -> Option<String> {
    map_get(body, key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// `TenantRow` → JSON, omitting NULL `displayName`/`archivedAt` (the TS row
/// mapper omits absent keys, so a tenant with no display name serializes
/// `{tenantId, createdAt}`).
fn tenant_row_to_json(row: &frick_store::stores::tenant::TenantRow) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    map.insert("tenantId".into(), json!(row.tenant_id));
    if let Some(display_name) = &row.display_name {
        map.insert("displayName".into(), json!(display_name));
    }
    map.insert("createdAt".into(), json!(row.created_at));
    if let Some(archived_at) = &row.archived_at {
        map.insert("archivedAt".into(), json!(archived_at));
    }
    serde_json::Value::Object(map)
}

/// `AdminAuditRow` → JSON, omitting NULL `target`/`detail`/`previousHash`/
/// `entryHash` (the TS audit row mapper omits absent keys).
fn audit_row_to_json(row: &frick_store::stores::admin_audit::AdminAuditRow) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    map.insert("id".into(), json!(row.id));
    map.insert("occurredAt".into(), json!(row.occurred_at));
    map.insert(
        "adminTokenFingerprint".into(),
        json!(row.admin_token_fingerprint),
    );
    map.insert("action".into(), json!(row.action));
    if let Some(target) = &row.target {
        map.insert("target".into(), json!(target));
    }
    map.insert("outcome".into(), json!(row.outcome.as_str()));
    if let Some(detail) = &row.detail {
        map.insert("detail".into(), json!(detail));
    }
    if let Some(previous_hash) = &row.previous_hash {
        map.insert("previousHash".into(), json!(previous_hash));
    }
    if let Some(entry_hash) = &row.entry_hash {
        map.insert("entryHash".into(), json!(entry_hash));
    }
    serde_json::Value::Object(map)
}

/// Whether a store error is the tenant-already-exists conflict (the store
/// surfaces it as `StoreError::Store` carrying the TS message).
fn is_already_exists(error: &frick_store::StoreError) -> bool {
    error.to_string().ends_with("already exists")
}

/// Map a non-conflict store error onto the generic protocol-error envelope
/// (the TS default `sendError`). Store errors here are server faults or caller
/// faults the store rejected; a generic 400 matches the TS `sendError` default
/// status for non-typed errors.
fn store_error(error: &frick_store::StoreError) -> ServerError {
    ServerError::BadRequest {
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_twelve_hex_chars_of_sha256() {
        // sha256("token") = 3c469e9d6c5875d37a43f353d4f88e61fcf812c66eee3457465a40b0da4153e0
        let fp = admin_token_fingerprint("token");
        assert_eq!(fp.len(), 12);
        assert_eq!(fp, "3c469e9d6c58");
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn non_empty_str_filters_blank_and_missing() {
        let body = Value::Map(vec![
            (Value::from("userId"), Value::from("u-1")),
            (Value::from("blank"), Value::from("")),
            (Value::from("number"), Value::from(7)),
        ]);
        assert_eq!(non_empty_str(&body, "userId"), Some("u-1".to_string()));
        assert_eq!(non_empty_str(&body, "blank"), None);
        assert_eq!(non_empty_str(&body, "number"), None);
        assert_eq!(non_empty_str(&body, "missing"), None);
    }

    #[test]
    fn tenant_row_omits_null_optionals() {
        let row = frick_store::stores::tenant::TenantRow {
            tenant_id: "acme".into(),
            display_name: None,
            created_at: "2023-11-14T22:13:20.123Z".into(),
            archived_at: None,
        };
        let json = tenant_row_to_json(&row);
        let obj = json.as_object().unwrap();
        assert_eq!(obj.get("tenantId").unwrap(), "acme");
        assert!(!obj.contains_key("displayName"));
        assert!(!obj.contains_key("archivedAt"));
        assert!(obj.contains_key("createdAt"));
    }
}
