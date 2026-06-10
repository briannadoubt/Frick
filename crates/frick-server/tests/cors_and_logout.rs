//! Regression tests for two cross-origin / session parity fixes raised in the
//! FR-255 PR review:
//!
//! 1. CORS — the composed router applies the `FRICK_ALLOWED_ORIGINS`-driven
//!    `Access-Control-*` headers (the TS `setCors`/preflight contract), so a
//!    browser client on a separate origin can make cross-origin HTTP calls.
//! 2. Logout — `/auth/logout` accepts the session token from the standard auth
//!    headers (`Authorization: Bearer` / `x-frick-session-token`), not only
//!    from a JSON body, so a header-only logout revokes the session.

use std::sync::Arc;

use frick_protocol::FrickSchema;
use frick_schema::SchemaBuilder;
use frick_schema::builder::field;
use frick_server::config::load_frick_config;
use frick_server::http::{AppState, public_router};
use frick_server::{FrickConfig, create_frick_server, routes};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const ALLOWED_ORIGIN: &str = "http://localhost:5173";

/// A minimal schema with a `User` object so the protected `/objects` route is
/// exercisable (the logout test reads it before/after revocation).
fn test_schema() -> FrickSchema {
    SchemaBuilder::new("cors-logout-test", "cors-logout-test")
        .hash("cors-logout-test-hash")
        .object("User", 1, |o| {
            o.field(field::string("displayName", 1).required())
        })
        .build()
        .expect("test schema validates")
}

/// A config with an explicit single-origin allowlist (not the dev `*`), so the
/// allow/deny distinction is observable.
fn test_config() -> FrickConfig {
    let mut env = std::collections::BTreeMap::new();
    env.insert("FRICK_ENV".to_string(), "test".to_string());
    env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
    env.insert("FRICK_PORT".to_string(), "0".to_string());
    env.insert(
        "FRICK_ALLOWED_ORIGINS".to_string(),
        ALLOWED_ORIGIN.to_string(),
    );
    load_frick_config(&env).unwrap()
}

struct TestServer {
    port: u16,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    join: Option<tokio::task::JoinHandle<()>>,
}

impl TestServer {
    async fn boot() -> Self {
        let server = create_frick_server(test_config(), test_schema())
            .await
            .unwrap();
        let state: AppState = Arc::clone(&server.state);
        let allowed_origins = server.config.allowed_origins.clone();
        // The router holds its own Arc to the state/store; keep the handle's
        // store alive for the test's lifetime.
        std::mem::forget(server);

        let router = public_router(Arc::clone(&state))
            .merge(frick_server::auth_routes::auth_router(Arc::clone(&state)))
            .merge(routes::dataplane_router(state))
            // The same layer boot::listen applies.
            .layer(frick_server::cors::cors_layer(&allowed_origins));

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

    async fn login(&self, user_id: &str) -> String {
        let body = format!(r#"{{"userId":"{user_id}"}}"#);
        let response = self
            .request("POST", "/auth/dev-login", &[], Some(&body))
            .await;
        extract_json_string(&response.body, "sessionToken")
    }

    async fn request(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<&str>,
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
        // A body is optional — a header-only logout sends none.
        let request = match body {
            Some(body) => format!(
                "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n{header_block}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ),
            None => format!(
                "{method} {path} HTTP/1.1\r\nHost: localhost\r\n{header_block}Connection: close\r\n\r\n"
            ),
        };
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut raw = String::new();
        stream.read_to_string(&mut raw).await.unwrap();
        HttpResponse::parse(&raw)
    }
}

struct HttpResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl HttpResponse {
    fn parse(raw: &str) -> Self {
        let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((raw, ""));
        let mut lines = head.split("\r\n");
        let status_line = lines.next().unwrap_or("");
        let status = status_line
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse::<u16>().ok())
            .unwrap_or(0);
        let headers = lines
            .filter_map(|line| {
                line.split_once(": ")
                    .map(|(k, v)| (k.to_ascii_lowercase(), v.to_string()))
            })
            .collect();
        Self {
            status,
            headers,
            body: body.to_string(),
        }
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

fn extract_json_string(body: &str, key: &str) -> String {
    let needle = format!("\"{key}\":\"");
    let start = body.find(&needle).expect("key present") + needle.len();
    let rest = &body[start..];
    let end = rest.find('"').expect("closing quote");
    rest[..end].to_string()
}

/// A preflight from an allowed origin echoes it back with the allowed methods.
#[tokio::test]
async fn cors_preflight_from_allowed_origin_is_permitted() {
    let mut server = TestServer::boot().await;

    let response = server
        .request(
            "OPTIONS",
            "/objects?type=User",
            &[
                ("Origin", ALLOWED_ORIGIN),
                ("Access-Control-Request-Method", "GET"),
            ],
            None,
        )
        .await;

    assert_eq!(
        response.header("access-control-allow-origin"),
        Some(ALLOWED_ORIGIN),
        "preflight should echo the allowed origin"
    );
    let methods = response
        .header("access-control-allow-methods")
        .unwrap_or_default()
        .to_ascii_uppercase();
    assert!(methods.contains("GET"), "allow-methods was {methods:?}");
    assert!(methods.contains("POST"), "allow-methods was {methods:?}");

    server.close().await;
}

/// A request from a disallowed origin receives no `Access-Control-Allow-Origin`,
/// so the browser blocks it.
#[tokio::test]
async fn cors_request_from_disallowed_origin_has_no_acao() {
    let mut server = TestServer::boot().await;

    let response = server
        .request(
            "GET",
            "/health",
            &[("Origin", "https://evil.example.com")],
            None,
        )
        .await;

    assert_eq!(response.status, 200, "health is public");
    assert_eq!(
        response.header("access-control-allow-origin"),
        None,
        "a disallowed origin must not get an ACAO header"
    );

    server.close().await;
}

/// Logout via the `Authorization` bearer header (no JSON body) revokes the
/// session — afterwards the token no longer authorizes a protected request.
#[tokio::test]
async fn logout_accepts_the_bearer_header_and_revokes() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-logout-header").await;
    let bearer = format!("Bearer {token}");

    // The token works before logout.
    let before = server
        .request(
            "GET",
            "/objects?type=User",
            &[("Authorization", &bearer)],
            None,
        )
        .await;
    assert_eq!(before.status, 200, "token should authorize before logout");

    // Logout with ONLY the bearer header — no body.
    let logout = server
        .request("POST", "/auth/logout", &[("Authorization", &bearer)], None)
        .await;
    assert_eq!(
        logout.status, 200,
        "header-only logout body: {}",
        logout.body
    );
    assert!(logout.body.contains("\"ok\":true"));

    // The session is now revoked.
    let after = server
        .request(
            "GET",
            "/objects?type=User",
            &[("Authorization", &bearer)],
            None,
        )
        .await;
    assert_eq!(after.status, 401, "token should be revoked after logout");

    server.close().await;
}
