//! Integration tests for the admin + inspection HTTP routers (map 02 §4.5/§4.6).
//!
//! These boot a real server over a loopback socket and merge the admin +
//! inspect routers onto the public/auth/dataplane routers — the same wiring the
//! integrator lands in `boot::listen`, exercised here directly so the routes
//! work end-to-end before that merge ships.
//!
//! Coverage: admin disabled → 404; with a 32+char admin token the audit-log,
//! tenants create/get/archive, and a settings PUT round-trip; the inspect
//! `server` + `migrations` shapes.

use std::sync::Arc;

use frick_protocol::FrickSchema;
use frick_server::config::load_frick_config;
use frick_server::http::{AppState, public_router};
use frick_server::routes::{admin::admin_router, inspect::inspect_router};
use frick_server::{FrickConfig, create_frick_server, routes};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const ADMIN_TOKEN: &str = "0123456789012345678901234567890123"; // 34 chars (>=32)

/// Test config. `admin_token` controls whether the admin surface is enabled.
fn test_config(admin_token: Option<&str>) -> FrickConfig {
    let mut env = std::collections::BTreeMap::new();
    env.insert("FRICK_ENV".to_string(), "test".to_string());
    env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
    env.insert("FRICK_PORT".to_string(), "0".to_string());
    if let Some(token) = admin_token {
        env.insert("FRICK_ADMIN_TOKEN".to_string(), token.to_string());
    }
    load_frick_config(&env).unwrap()
}

fn test_schema() -> FrickSchema {
    frick_protocol::foundation_schema()
}

struct TestServer {
    port: u16,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    join: Option<tokio::task::JoinHandle<()>>,
}

impl TestServer {
    async fn boot(admin_token: Option<&str>) -> Self {
        let server = create_frick_server(test_config(admin_token), test_schema())
            .await
            .unwrap();
        let state: AppState = Arc::clone(&server.state);
        // Keep the store alive for the process lifetime; the router holds its
        // own Arc to the state.
        std::mem::forget(server);

        let router = public_router(Arc::clone(&state))
            .merge(frick_server::auth_routes::auth_router(Arc::clone(&state)))
            .merge(routes::dataplane_router(Arc::clone(&state)))
            .merge(admin_router(Arc::clone(&state)))
            .merge(inspect_router(state));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let join = tokio::spawn(async move {
            let serve = axum::serve(listener, router);
            let _ = serve
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
        });
        Self {
            port,
            shutdown: Some(shutdown_tx),
            join: Some(join),
        }
    }

    async fn close(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(join) = self.join.take() {
            let _ = join.await;
        }
    }

    /// Dev-login as `user_id` and return its session token.
    async fn login(&self, user_id: &str) -> String {
        let body = format!(r#"{{"userId":"{user_id}"}}"#);
        let response = self.request("POST", "/auth/dev-login", &[], &body).await;
        extract_json_string(&response.body, "sessionToken")
    }

    async fn request(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: &str,
    ) -> HttpResponse {
        let mut stream = tokio::net::TcpStream::connect(format!("127.0.0.1:{}", self.port))
            .await
            .unwrap();
        let mut header_block = String::new();
        for (name, value) in headers {
            header_block.push_str(name);
            header_block.push_str(": ");
            header_block.push_str(value);
            header_block.push_str("\r\n");
        }
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n{header_block}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut raw = String::new();
        stream.read_to_string(&mut raw).await.unwrap();
        HttpResponse::parse(&raw)
    }

    /// Admin GET with the configured admin bearer.
    async fn admin_get(&self, path: &str, token: &str) -> HttpResponse {
        self.request("GET", path, &[("Authorization", &bearer(token))], "")
            .await
    }

    /// Admin POST with the configured admin bearer.
    async fn admin_post(&self, path: &str, token: &str, body: &str) -> HttpResponse {
        self.request("POST", path, &[("Authorization", &bearer(token))], body)
            .await
    }

    /// Admin PUT with the configured admin bearer.
    async fn admin_put(&self, path: &str, token: &str, body: &str) -> HttpResponse {
        self.request("PUT", path, &[("Authorization", &bearer(token))], body)
            .await
    }
}

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

struct HttpResponse {
    status: u16,
    body: String,
}

impl HttpResponse {
    fn parse(raw: &str) -> Self {
        let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((raw, ""));
        let status_line = head.split("\r\n").next().unwrap_or("");
        let status = status_line
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse::<u16>().ok())
            .unwrap_or(0);
        Self {
            status,
            body: body.to_string(),
        }
    }
}

fn extract_json_string(body: &str, key: &str) -> String {
    let needle = format!("\"{key}\":\"");
    let start = body.find(&needle).expect("key present") + needle.len();
    let rest = &body[start..];
    let end = rest.find('"').expect("closing quote");
    rest[..end].to_string()
}

// ── admin disabled ────────────────────────────────────────────────────────────

/// With no admin token configured every admin path 404s (the whole surface is
/// disabled), even with a would-be admin bearer.
#[tokio::test]
async fn admin_disabled_returns_404() {
    let mut server = TestServer::boot(None).await;

    let audit = server
        .admin_get("/_frick/admin/audit-log", ADMIN_TOKEN)
        .await;
    assert_eq!(audit.status, 404, "body: {}", audit.body);
    assert!(audit.body.contains("not_found"), "body: {}", audit.body);

    let tenants = server.admin_get("/_frick/admin/tenants", ADMIN_TOKEN).await;
    assert_eq!(tenants.status, 404, "body: {}", tenants.body);

    server.close().await;
}

/// Admin enabled but no bearer → 401; a non-admin session bearer → 403.
#[tokio::test]
async fn admin_enabled_rejects_bad_auth() {
    let mut server = TestServer::boot(Some(ADMIN_TOKEN)).await;

    // No bearer at all → 401 auth.unauthenticated.
    let no_auth = server
        .request("GET", "/_frick/admin/tenants", &[], "")
        .await;
    assert_eq!(no_auth.status, 401, "body: {}", no_auth.body);
    assert!(
        no_auth.body.contains("auth.unauthenticated"),
        "body: {}",
        no_auth.body
    );

    // A valid session token (not the admin token) → 403 auth.forbidden.
    let session = server.login("user-mallory").await;
    let forbidden = server.admin_get("/_frick/admin/tenants", &session).await;
    assert_eq!(forbidden.status, 403, "body: {}", forbidden.body);
    assert!(
        forbidden.body.contains("auth.forbidden"),
        "body: {}",
        forbidden.body
    );

    server.close().await;
}

// ── tenants create/get/archive + settings round-trip ──────────────────────────

/// The full admin tenant lifecycle: create → get → settings PUT round-trip →
/// archive, with the audit-log reflecting the mutations.
#[tokio::test]
async fn admin_tenant_lifecycle_and_audit() {
    let mut server = TestServer::boot(Some(ADMIN_TOKEN)).await;

    // Create.
    let create = server
        .admin_post(
            "/_frick/admin/tenants",
            ADMIN_TOKEN,
            r#"{"tenantId":"acme","displayName":"Acme Inc"}"#,
        )
        .await;
    assert_eq!(create.status, 201, "body: {}", create.body);
    assert!(create.body.contains("\"tenantId\":\"acme\""));
    assert!(create.body.contains("\"displayName\":\"Acme Inc\""));

    // Duplicate create → 409 tenantExists.
    let dup = server
        .admin_post(
            "/_frick/admin/tenants",
            ADMIN_TOKEN,
            r#"{"tenantId":"acme"}"#,
        )
        .await;
    assert_eq!(dup.status, 409, "body: {}", dup.body);
    assert!(dup.body.contains("tenantExists"), "body: {}", dup.body);

    // Get.
    let show = server
        .admin_get("/_frick/admin/tenants/acme", ADMIN_TOKEN)
        .await;
    assert_eq!(show.status, 200, "body: {}", show.body);
    assert!(show.body.contains("\"tenantId\":\"acme\""));

    // Get missing → 404 tenant_not_found.
    let missing = server
        .admin_get("/_frick/admin/tenants/ghost", ADMIN_TOKEN)
        .await;
    assert_eq!(missing.status, 404, "body: {}", missing.body);
    assert!(missing.body.contains("tenant_not_found"));

    // Settings PUT (an arbitrary JSON value — a number).
    let put = server
        .admin_put(
            "/_frick/admin/tenants/acme/settings/retentionMs",
            ADMIN_TOKEN,
            "60000",
        )
        .await;
    assert_eq!(put.status, 200, "body: {}", put.body);
    assert!(
        put.body.contains("\"key\":\"retentionMs\""),
        "body: {}",
        put.body
    );
    assert!(put.body.contains("\"value\":60000"), "body: {}", put.body);

    // Settings list reflects the PUT.
    let settings = server
        .admin_get("/_frick/admin/tenants/acme/settings", ADMIN_TOKEN)
        .await;
    assert_eq!(settings.status, 200, "body: {}", settings.body);
    assert!(
        settings.body.contains("retentionMs"),
        "body: {}",
        settings.body
    );

    // Archive.
    let archive = server
        .admin_post("/_frick/admin/tenants/acme/archive", ADMIN_TOKEN, "")
        .await;
    assert_eq!(archive.status, 200, "body: {}", archive.body);
    assert!(
        archive.body.contains("archivedAt"),
        "body: {}",
        archive.body
    );

    // Archive a missing tenant → 404 tenant_not_found.
    let archive_missing = server
        .admin_post("/_frick/admin/tenants/ghost/archive", ADMIN_TOKEN, "")
        .await;
    assert_eq!(
        archive_missing.status, 404,
        "body: {}",
        archive_missing.body
    );

    // Audit log: the mutations are recorded (create + settings.put + archive).
    let audit = server
        .admin_get("/_frick/admin/audit-log?limit=100", ADMIN_TOKEN)
        .await;
    assert_eq!(audit.status, 200, "body: {}", audit.body);
    assert!(
        audit.body.contains("tenants.create"),
        "body: {}",
        audit.body
    );
    assert!(
        audit.body.contains("tenants.settings.put"),
        "body: {}",
        audit.body
    );
    assert!(
        audit.body.contains("tenants.archive"),
        "body: {}",
        audit.body
    );

    // Action filter narrows the result set.
    let only_create = server
        .admin_get("/_frick/admin/audit-log?action=tenants.create", ADMIN_TOKEN)
        .await;
    assert_eq!(only_create.status, 200, "body: {}", only_create.body);
    assert!(only_create.body.contains("tenants.create"));
    assert!(
        !only_create.body.contains("tenants.archive"),
        "action filter should exclude archive rows: {}",
        only_create.body
    );

    server.close().await;
}

/// `POST sessions/revoke` with neither target → 400 missingTarget; with a
/// userId → 200 `{revoked, disconnected}`.
#[tokio::test]
async fn admin_sessions_revoke() {
    let mut server = TestServer::boot(Some(ADMIN_TOKEN)).await;

    // Neither userId nor sessionToken → 400 missingTarget.
    let missing = server
        .admin_post("/_frick/admin/sessions/revoke", ADMIN_TOKEN, "{}")
        .await;
    assert_eq!(missing.status, 400, "body: {}", missing.body);
    assert!(
        missing.body.contains("missingTarget"),
        "body: {}",
        missing.body
    );

    // Mint a session, then revoke it by userId.
    let _token = server.login("user-revokable").await;
    let revoke = server
        .admin_post(
            "/_frick/admin/sessions/revoke",
            ADMIN_TOKEN,
            r#"{"userId":"user-revokable"}"#,
        )
        .await;
    assert_eq!(revoke.status, 200, "body: {}", revoke.body);
    assert!(
        revoke.body.contains("\"revoked\":1"),
        "body: {}",
        revoke.body
    );
    assert!(
        revoke.body.contains("\"disconnected\":0"),
        "body: {}",
        revoke.body
    );

    server.close().await;
}

// ── inspection shapes ─────────────────────────────────────────────────────────

/// `GET /_frick/inspect/server` returns the schema-identity + flags shape, and
/// `migrations` returns the applied-migration list. In `test` env inspection is
/// enabled and any active session authorizes the inspect tier.
#[tokio::test]
async fn inspect_server_and_migrations_shapes() {
    let mut server = TestServer::boot(Some(ADMIN_TOKEN)).await;
    let token = server.login("user-inspector").await;

    let info = server
        .request(
            "GET",
            "/_frick/inspect/server",
            &[("Authorization", &bearer(&token))],
            "",
        )
        .await;
    assert_eq!(info.status, 200, "body: {}", info.body);
    for key in [
        "schemaId",
        "schemaVersion",
        "schemaRevision",
        "schemaHash",
        "appId",
        "env",
        "demoAuthEnabled",
        "inspectionEnabled",
        "startedAt",
    ] {
        assert!(
            info.body.contains(&format!("\"{key}\"")),
            "missing {key} in {}",
            info.body
        );
    }
    assert!(info.body.contains("\"appId\":\"_default\""));
    assert!(info.body.contains("\"env\":\"test\""));

    let migrations = server
        .request(
            "GET",
            "/_frick/inspect/migrations",
            &[("Authorization", &bearer(&token))],
            "",
        )
        .await;
    assert_eq!(migrations.status, 200, "body: {}", migrations.body);
    assert!(
        migrations.body.contains("\"applied\""),
        "body: {}",
        migrations.body
    );
    // The framework migrations ran at boot, so the list is non-empty and the
    // rows carry the documented fields.
    assert!(
        migrations.body.contains("schemaRevision"),
        "body: {}",
        migrations.body
    );
    assert!(
        migrations.body.contains("checksum"),
        "body: {}",
        migrations.body
    );

    server.close().await;
}

/// Inspection requires an authenticated principal: no bearer → 401.
#[tokio::test]
async fn inspect_requires_auth() {
    let mut server = TestServer::boot(Some(ADMIN_TOKEN)).await;
    let unauth = server
        .request("GET", "/_frick/inspect/server", &[], "")
        .await;
    assert_eq!(unauth.status, 401, "body: {}", unauth.body);
    assert!(unauth.body.contains("auth.unauthenticated"));
    server.close().await;
}

/// An unknown inspect sub-path → 404 not_found.
#[tokio::test]
async fn inspect_unknown_subpath_is_404() {
    let mut server = TestServer::boot(Some(ADMIN_TOKEN)).await;
    let token = server.login("user-inspector").await;
    let unknown = server
        .request(
            "GET",
            "/_frick/inspect/nope",
            &[("Authorization", &bearer(&token))],
            "",
        )
        .await;
    assert_eq!(unknown.status, 404, "body: {}", unknown.body);
    assert!(unknown.body.contains("not_found"), "body: {}", unknown.body);
    server.close().await;
}
