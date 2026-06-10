//! Integration tests for the protected data-plane routes (FR-244).
//!
//! These boot a real server over a loopback socket, dev-login to mint a session
//! token, then exercise each route — mirroring the `auth_routes.rs` harness but
//! serving a router that also merges [`routes::dataplane_router`] (the
//! integrator wires that merge into `boot::listen`; here the test wires it
//! directly so the routes can be exercised end-to-end before that lands).

use std::sync::Arc;

use frick_protocol::FrickSchema;
use frick_schema::SchemaBuilder;
use frick_schema::builder::field;
use frick_server::config::load_frick_config;
use frick_server::http::{AppState, public_router};
use frick_server::{FrickConfig, create_frick_server, routes};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn test_config() -> FrickConfig {
    let mut env = std::collections::BTreeMap::new();
    env.insert("FRICK_ENV".to_string(), "test".to_string());
    env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
    env.insert("FRICK_PORT".to_string(), "0".to_string());
    load_frick_config(&env).unwrap()
}

/// A small schema exercising the data-plane shapes: a `Note` object, a `Chat`
/// stream carrying a `message` event, and a `WebRTCSignal` signal.
fn test_schema() -> FrickSchema {
    SchemaBuilder::new("dataplane-test", "dataplane-test")
        .hash("dataplane-test-hash")
        .object("Note", 1, |o| o.field(field::string("body", 1).required()))
        .event("message", 1, |e| e.field(field::string("text", 1)))
        .stream("Chat", 1, |s| {
            s.key_field(field::string("room", 1)).event("message")
        })
        .signal("WebRTCSignal", 1, 30_000, |s| {
            s.key_field(field::string("call", 1))
                .field(field::string("sdp", 1))
        })
        .build()
        .expect("test schema validates")
}

/// A booted test server: a loopback port plus the shutdown plumbing.
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
        // Keep the constructed server's store alive for the process lifetime by
        // leaking the handle — the router holds its own Arc to the state/store.
        std::mem::forget(server);

        let router = public_router(Arc::clone(&state))
            .merge(frick_server::auth_routes::auth_router(Arc::clone(&state)))
            .merge(routes::dataplane_router(state));

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

    /// Issue an HTTP/1.1 request over a fresh connection and parse the response.
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

    async fn get(&self, path: &str, token: &str) -> HttpResponse {
        self.request("GET", path, &[("Authorization", &bearer(token))], "")
            .await
    }
}

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

/// A minimally-parsed HTTP response: status line, headers, body.
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

// ── tests ───────────────────────────────────────────────────────────────────

/// A request with no bearer token is a 401.
#[tokio::test]
async fn objects_require_authentication() {
    let mut server = TestServer::boot().await;
    let response = server.request("GET", "/objects?type=Note", &[], "").await;
    assert_eq!(response.status, 401, "body: {}", response.body);
    assert!(response.body.contains("auth.unauthenticated"));
    server.close().await;
}

/// `GET /objects` without `?type=` is a bespoke 400 `type_required`.
#[tokio::test]
async fn objects_list_requires_type() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;
    let response = server.get("/objects", &token).await;
    assert_eq!(response.status, 400, "body: {}", response.body);
    assert!(
        response.body.contains("type_required"),
        "body: {}",
        response.body
    );
    server.close().await;
}

/// Object create → list round-trip: a `Note` upsert returns 201 with an `ETag`
/// of the new version, and the row is then visible in the owner's list.
#[tokio::test]
async fn object_create_then_list() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;

    let create = server
        .request(
            "PUT",
            "/objects/Note/note-1",
            &[("Authorization", &bearer(&token))],
            r#"{"body":"hello"}"#,
        )
        .await;
    assert_eq!(create.status, 201, "body: {}", create.body);
    assert_eq!(create.header("etag"), Some("1"));
    assert!(
        create.body.contains("\"version\":1"),
        "body: {}",
        create.body
    );
    assert!(
        create.body.contains("\"previousVersion\":0"),
        "body: {}",
        create.body
    );

    let list = server.get("/objects?type=Note", &token).await;
    assert_eq!(list.status, 200, "body: {}", list.body);
    assert!(list.body.contains("note-1"), "body: {}", list.body);
    assert!(list.body.contains("hello"), "body: {}", list.body);
    server.close().await;
}

/// A second create at the same id under `versionPrecondition` (the foundation
/// `Note` default is last-write-wins, so a plain re-PUT just increments — assert
/// the version climbs).
#[tokio::test]
async fn object_reupsert_increments_version() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;

    let first = server
        .request(
            "POST",
            "/objects/Note/note-2",
            &[("Authorization", &bearer(&token))],
            r#"{"body":"v1"}"#,
        )
        .await;
    assert_eq!(first.status, 201);
    assert_eq!(first.header("etag"), Some("1"));

    let second = server
        .request(
            "POST",
            "/objects/Note/note-2",
            &[("Authorization", &bearer(&token))],
            r#"{"body":"v2"}"#,
        )
        .await;
    assert_eq!(second.status, 200, "body: {}", second.body);
    assert_eq!(second.header("etag"), Some("2"));
    server.close().await;
}

/// `DELETE /objects/:type/:id` is idempotent: 200 with `existed:true` then
/// `existed:false`.
#[tokio::test]
async fn object_delete_is_idempotent() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;
    server
        .request(
            "PUT",
            "/objects/Note/note-3",
            &[("Authorization", &bearer(&token))],
            r#"{"body":"x"}"#,
        )
        .await;

    let first = server
        .request(
            "DELETE",
            "/objects/Note/note-3",
            &[("Authorization", &bearer(&token))],
            "",
        )
        .await;
    assert_eq!(first.status, 200);
    assert!(
        first.body.contains("\"existed\":true"),
        "body: {}",
        first.body
    );

    let second = server
        .request(
            "DELETE",
            "/objects/Note/note-3",
            &[("Authorization", &bearer(&token))],
            "",
        )
        .await;
    assert_eq!(second.status, 200);
    assert!(
        second.body.contains("\"existed\":false"),
        "body: {}",
        second.body
    );
    server.close().await;
}

/// Append → read round-trip on a stream, and the cursor head probe.
#[tokio::test]
async fn append_then_read_stream() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;

    let append = server
        .request(
            "POST",
            "/append",
            &[("Authorization", &bearer(&token))],
            r#"{"stream":"Chat","key":"room-1","event":"message","payload":{"text":"hi"},"requestId":"req-1"}"#,
        )
        .await;
    assert_eq!(append.status, 200, "body: {}", append.body);
    assert!(append.body.contains("\"ok\":true"), "body: {}", append.body);
    assert!(
        append.body.contains("\"sequence\":1"),
        "body: {}",
        append.body
    );

    // Idempotent replay (same requestId) returns the same event, no new sequence.
    let replay = server
        .request(
            "POST",
            "/append",
            &[("Authorization", &bearer(&token))],
            r#"{"stream":"Chat","key":"room-1","event":"message","payload":{"text":"hi"},"requestId":"req-1"}"#,
        )
        .await;
    assert_eq!(replay.status, 200, "body: {}", replay.body);
    assert!(
        replay.body.contains("\"sequence\":1"),
        "body: {}",
        replay.body
    );

    let read = server.get("/streams/Chat/room-1", &token).await;
    assert_eq!(read.status, 200, "body: {}", read.body);
    assert!(
        read.body.contains("\"hasMore\":false"),
        "body: {}",
        read.body
    );
    assert!(read.body.contains("\"text\":\"hi\""), "body: {}", read.body);

    let cursor = server.get("/streams/Chat/room-1/cursor", &token).await;
    assert_eq!(cursor.status, 200, "body: {}", cursor.body);
    assert!(
        cursor.body.contains("\"headSequence\":1"),
        "body: {}",
        cursor.body
    );
    assert!(cursor.body.contains("\"count\":1"), "body: {}", cursor.body);

    // `?since=` with a bad cursor is a 400 stream.invalidCursor.
    let bad = server.get("/streams/Chat/room-1?since=-1", &token).await;
    assert_eq!(bad.status, 400, "body: {}", bad.body);
    assert!(
        bad.body.contains("stream.invalidCursor"),
        "body: {}",
        bad.body
    );
    server.close().await;
}

/// Signal enqueue then drain (at-most-once): the drained payload comes back,
/// and a second drain is empty.
#[tokio::test]
async fn signal_enqueue_then_drain() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;

    let send = server
        .request(
            "POST",
            "/signals/WebRTCSignal/call-1",
            &[("Authorization", &bearer(&token))],
            r#"{"sdp":"offer"}"#,
        )
        .await;
    assert_eq!(send.status, 200, "body: {}", send.body);
    assert!(send.body.contains("\"ok\":true"));

    let drain = server.get("/signals/WebRTCSignal/call-1", &token).await;
    assert_eq!(drain.status, 200, "body: {}", drain.body);
    assert!(drain.body.contains("offer"), "body: {}", drain.body);

    let again = server.get("/signals/WebRTCSignal/call-1", &token).await;
    assert_eq!(again.status, 200, "body: {}", again.body);
    assert!(again.body.contains("\"data\":[]"), "body: {}", again.body);
    server.close().await;
}

/// Share invite → accept → grant lifecycle across two users, then owner revoke.
#[tokio::test]
async fn share_invite_accept_and_revoke() {
    let mut server = TestServer::boot().await;
    let owner = server.login("user-owner").await;
    let grantee = server.login("user-grantee").await;

    let invite = server
        .request(
            "POST",
            "/share/invite",
            &[("Authorization", &bearer(&owner))],
            r#"{"recordType":"Note","recordId":"note-1","permission":"read"}"#,
        )
        .await;
    assert_eq!(invite.status, 201, "body: {}", invite.body);
    assert!(
        invite.body.contains("\"id\":\"inv-"),
        "body: {}",
        invite.body
    );
    let invite_token = extract_json_string(&invite.body, "token");

    // Owner self-accept on a *separate* invitation is rejected (the redeem
    // marks that invitation redeemed first, then the route rejects the
    // self-accept — faithful TS ordering, so the token is consumed).
    let self_invite = server
        .request(
            "POST",
            "/share/invite",
            &[("Authorization", &bearer(&owner))],
            r#"{"recordType":"Note","recordId":"note-2","permission":"read"}"#,
        )
        .await;
    let self_token = extract_json_string(&self_invite.body, "token");
    let self_accept = server
        .request(
            "POST",
            "/share/accept",
            &[("Authorization", &bearer(&owner))],
            &format!(r#"{{"token":"{self_token}"}}"#),
        )
        .await;
    assert_eq!(self_accept.status, 403, "body: {}", self_accept.body);
    assert!(self_accept.body.contains("auth.forbidden"));
    assert!(
        self_accept
            .body
            .contains("Owners cannot accept their own invitations"),
        "body: {}",
        self_accept.body
    );

    // Grantee accepts → a grant is minted.
    let accept = server
        .request(
            "POST",
            "/share/accept",
            &[("Authorization", &bearer(&grantee))],
            &format!(r#"{{"token":"{invite_token}"}}"#),
        )
        .await;
    assert_eq!(accept.status, 201, "body: {}", accept.body);
    assert!(
        accept.body.contains("\"id\":\"grant-"),
        "body: {}",
        accept.body
    );
    let grant_id = extract_json_string(&accept.body, "id");

    // Replaying the same token now reports alreadyRedeemed (403).
    let replay = server
        .request(
            "POST",
            "/share/accept",
            &[("Authorization", &bearer(&grantee))],
            &format!(r#"{{"token":"{invite_token}"}}"#),
        )
        .await;
    assert_eq!(replay.status, 403, "body: {}", replay.body);

    // Owner lists the grant.
    let grants = server.get("/share/grants", &owner).await;
    assert_eq!(grants.status, 200, "body: {}", grants.body);
    assert!(grants.body.contains(&grant_id), "body: {}", grants.body);

    // A non-owner DELETE is a 404 (no existence leak).
    let forbidden_revoke = server
        .request(
            "DELETE",
            &format!("/share/grants/{grant_id}"),
            &[("Authorization", &bearer(&grantee))],
            "",
        )
        .await;
    assert_eq!(
        forbidden_revoke.status, 404,
        "body: {}",
        forbidden_revoke.body
    );

    // Owner revoke succeeds.
    let revoke = server
        .request(
            "DELETE",
            &format!("/share/grants/{grant_id}"),
            &[("Authorization", &bearer(&owner))],
            "",
        )
        .await;
    assert_eq!(revoke.status, 200, "body: {}", revoke.body);
    server.close().await;
}

/// Push registration create → 201, then DELETE of a missing id → 404 (no leak).
#[tokio::test]
async fn push_register_and_revoke() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;

    let register = server
        .request(
            "POST",
            "/push/registrations",
            &[("Authorization", &bearer(&token))],
            r#"{"deviceId":"device-1","platform":"apns","token":"apns-token"}"#,
        )
        .await;
    assert_eq!(register.status, 201, "body: {}", register.body);
    let registration_id = extract_json_string(&register.body, "registrationId");

    // DELETE of another id is a 404.
    let missing = server
        .request(
            "DELETE",
            "/push/registrations/push-does-not-exist",
            &[("Authorization", &bearer(&token))],
            "",
        )
        .await;
    assert_eq!(missing.status, 404, "body: {}", missing.body);
    assert!(missing.body.contains("push_registration_not_found"));

    // DELETE of the owned id is a 204.
    let revoke = server
        .request(
            "DELETE",
            &format!("/push/registrations/{registration_id}"),
            &[("Authorization", &bearer(&token))],
            "",
        )
        .await;
    assert_eq!(revoke.status, 204, "body: {}", revoke.body);
    server.close().await;
}

/// `GET /projections` returns an empty list (FR-245 registry deferred), and a
/// named projection is `projectionNotFound` (404).
#[tokio::test]
async fn projections_empty_and_not_found() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;

    let list = server.get("/projections", &token).await;
    assert_eq!(list.status, 200, "body: {}", list.body);
    assert!(
        list.body.contains("\"projections\":[]"),
        "body: {}",
        list.body
    );

    let missing = server.get("/projections/anything", &token).await;
    assert_eq!(missing.status, 404, "body: {}", missing.body);
    assert!(
        missing.body.contains("storage.notFound"),
        "body: {}",
        missing.body
    );
    server.close().await;
}
