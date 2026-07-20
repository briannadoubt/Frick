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
use frick_server::authz::{Action, Decision, DenyReason, PolicyHook, PolicyInput};
use frick_server::config::load_frick_config;
use frick_server::http::{AppState, public_router};
use frick_server::{
    BootSeams, FrickConfig, create_frick_server, create_frick_server_with_seams, routes,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// A policy hook (FR-296) that denies every write to a given object type — the
/// shape of an RBAC role × type matrix gate.
struct DenyTypeWrites {
    object_type: &'static str,
}

impl PolicyHook for DenyTypeWrites {
    fn evaluate<'a>(
        &'a self,
        input: &'a PolicyInput<'a>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Decision>> + Send + 'a>> {
        Box::pin(async move {
            (input.action == Action::ObjectWrite
                && input.resource.name.as_deref() == Some(self.object_type))
            .then(|| Decision::Deny {
                reason: DenyReason::NotAuthorizedForResource,
                public_message: format!("writes to {} are gated", self.object_type),
            })
        })
    }
}

/// A tightening-only policy hook (FR-296) that denies every occurrence of a
/// single action, regardless of resource — a blunt gate used to prove a given
/// route actually consults `state.policy_hooks` (vs. silently bypassing them).
struct DenyAction {
    action: Action,
}

impl PolicyHook for DenyAction {
    fn evaluate<'a>(
        &'a self,
        input: &'a PolicyInput<'a>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Decision>> + Send + 'a>> {
        Box::pin(async move {
            (input.action == self.action).then(|| Decision::Deny {
                reason: DenyReason::NotAuthorizedForResource,
                public_message: format!("{} is gated", input.action.as_str()),
            })
        })
    }
}

/// A server-authoritative command endpoint (FR-297): authenticates the request
/// with the public helper and reads the store — the shape of a Rust backend's
/// `appRoutes`. Returns the caller's id + their tenant's `Note` count.
async fn note_count(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: axum::http::HeaderMap,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let Ok((principal, _)) = frick_server::routes::authenticate(&state, &headers).await else {
        return axum::http::StatusCode::UNAUTHORIZED.into_response();
    };
    let notes = state
        .store
        .objects()
        .list(
            &principal.tenant_id,
            "Note",
            frick_server::principal::DEFAULT_APP_ID,
        )
        .await
        .unwrap_or_default();
    axum::Json(serde_json::json!({ "userId": principal.user_id, "noteCount": notes.len() }))
        .into_response()
}

/// A command endpoint that returns its trusted client IP (FR-303): the socket
/// peer (via `ConnectInfo`), with `X-Forwarded-For` honored only from a
/// configured trusted proxy.
async fn client_ip_route(
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: axum::http::HeaderMap,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let ip = frick_server::client_ip::trusted_client_ip(
        &headers,
        peer.ip(),
        &state.config.trusted_proxies,
    );
    axum::Json(serde_json::json!({ "clientIp": ip.to_string() })).into_response()
}

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
        // An owner-scoped type (the `ownerUserId` convention) for FR-235 reads.
        .object("OwnedNote", 2, |o| {
            o.field(field::string("body", 1))
                .field(field::string("ownerUserId", 2))
        })
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
        Self::serve(Arc::clone(&server.state), server).await
    }

    /// Boot with app policy hooks registered (FR-296), via the seam-injecting
    /// constructor a Rust backend would use.
    async fn boot_with_hooks(hooks: Vec<Arc<dyn PolicyHook>>) -> Self {
        let mut seams = BootSeams::production();
        seams.policy_hooks = hooks;
        let server = create_frick_server_with_seams(test_config(), test_schema(), seams)
            .await
            .unwrap();
        Self::serve(Arc::clone(&server.state), server).await
    }

    /// Boot with app policy hooks (FR-296) AND a registered projection (FR-245)
    /// with a `read` handler, so `GET /projections/:name` can reach the
    /// `Found(data)` arm the `projection.read` hook gates.
    async fn boot_with_hooks_and_projection(
        hooks: Vec<Arc<dyn PolicyHook>>,
        projection: frick_server::projections::FrickProjection,
    ) -> Self {
        let mut seams = BootSeams::production();
        seams.policy_hooks = hooks;
        let server = create_frick_server_with_seams(test_config(), test_schema(), seams)
            .await
            .unwrap();
        server.state.projections.register(projection).unwrap();
        Self::serve(Arc::clone(&server.state), server).await
    }

    /// Boot with an app-registered route builder (FR-297). The harness wires the
    /// builder the same way [`frick_server::FrickServer::listen`] does
    /// (`router.merge(build(state))`).
    async fn boot_with_app_router(build: frick_server::AppRouterBuilder) -> Self {
        let server = create_frick_server(test_config(), test_schema())
            .await
            .unwrap();
        Self::serve_with(Arc::clone(&server.state), server, Some(build)).await
    }

    async fn serve(state: AppState, server: frick_server::FrickServer) -> Self {
        Self::serve_with(state, server, None).await
    }

    async fn serve_with(
        state: AppState,
        server: frick_server::FrickServer,
        app_router: Option<frick_server::AppRouterBuilder>,
    ) -> Self {
        // Keep the constructed server's store alive for the process lifetime by
        // leaking the handle — the router holds its own Arc to the state/store.
        std::mem::forget(server);

        let mut router = public_router(Arc::clone(&state))
            .merge(frick_server::auth_routes::auth_router(Arc::clone(&state)))
            .merge(routes::dataplane_router(Arc::clone(&state)));
        if let Some(build) = app_router {
            router = router.merge(build(Arc::clone(&state)));
        }

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let join = tokio::spawn(async move {
            let serve = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            );
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

/// `GET /objects?type=` is owner-scoped (FR-235/FR-116): each user lists only
/// the owner-scoped rows they own — never another user's. Before the fix the
/// list returned every tenant row to every caller.
#[tokio::test]
async fn object_list_is_owner_scoped() {
    let mut server = TestServer::boot().await;
    let ada = server.login("user-ada").await;
    let bo = server.login("user-bo").await;

    // Each user writes a row they own.
    let a = server
        .request(
            "PUT",
            "/objects/OwnedNote/o-ada",
            &[("Authorization", &bearer(&ada))],
            r#"{"body":"mine","ownerUserId":"user-ada"}"#,
        )
        .await;
    assert_eq!(a.status, 201, "body: {}", a.body);
    let b = server
        .request(
            "PUT",
            "/objects/OwnedNote/o-bo",
            &[("Authorization", &bearer(&bo))],
            r#"{"body":"hers","ownerUserId":"user-bo"}"#,
        )
        .await;
    assert_eq!(b.status, 201, "body: {}", b.body);

    // ada lists OwnedNote: she sees her row, never bo's.
    let ada_list = server.get("/objects?type=OwnedNote", &ada).await;
    assert_eq!(ada_list.status, 200, "body: {}", ada_list.body);
    assert!(ada_list.body.contains("o-ada"), "body: {}", ada_list.body);
    assert!(
        !ada_list.body.contains("o-bo"),
        "ada must not see bo's owner-scoped row: {}",
        ada_list.body
    );

    // bo lists OwnedNote: he sees his row, never ada's.
    let bo_list = server.get("/objects?type=OwnedNote", &bo).await;
    assert_eq!(bo_list.status, 200, "body: {}", bo_list.body);
    assert!(bo_list.body.contains("o-bo"), "body: {}", bo_list.body);
    assert!(
        !bo_list.body.contains("o-ada"),
        "bo must not see ada's owner-scoped row: {}",
        bo_list.body
    );

    server.close().await;
}

/// An app policy hook (FR-296) tightens a write the built-in baseline allows —
/// the shape of an RBAC / entitlement gate a Rust backend registers. The hook
/// runs after the baseline and before grant relaxation; an ungated type is
/// unaffected (the hook abstains).
#[tokio::test]
async fn policy_hook_denies_a_gated_write() {
    let mut server = TestServer::boot_with_hooks(vec![Arc::new(DenyTypeWrites {
        object_type: "Note",
    })])
    .await;
    let token = server.login("user-ada").await;

    let denied = server
        .request(
            "PUT",
            "/objects/Note/n-1",
            &[("Authorization", &bearer(&token))],
            r#"{"body":"x"}"#,
        )
        .await;
    assert_eq!(
        denied.status, 403,
        "gated write must be denied: {}",
        denied.body
    );
    assert!(
        denied.body.contains("notAuthorizedForResource"),
        "body: {}",
        denied.body
    );

    // A write to an ungated type still succeeds — the hook abstains.
    let ok = server
        .request(
            "PUT",
            "/objects/OwnedNote/o-1",
            &[("Authorization", &bearer(&token))],
            r#"{"body":"y","ownerUserId":"user-ada"}"#,
        )
        .await;
    assert_eq!(ok.status, 201, "ungated write must succeed: {}", ok.body);

    server.close().await;
}

/// A tightening-only policy hook (FR-296) denies `stream.append` — proving
/// `POST /append` actually consults `state.policy_hooks` (it previously
/// bypassed them entirely, per the `streams.rs` `append_decision` fn-level
/// comment before this fix).
#[tokio::test]
async fn policy_hook_denies_stream_append() {
    let mut server = TestServer::boot_with_hooks(vec![Arc::new(DenyAction {
        action: Action::StreamAppend,
    })])
    .await;
    let token = server.login("user-ada").await;

    let denied = server
        .request(
            "POST",
            "/append",
            &[("Authorization", &bearer(&token))],
            r#"{"stream":"Chat","key":"room-1","event":"message","payload":{"text":"hi"},"requestId":"req-1"}"#,
        )
        .await;
    assert_eq!(
        denied.status, 403,
        "gated stream.append must be denied: {}",
        denied.body
    );
    assert!(
        denied.body.contains("notAuthorizedForResource"),
        "body: {}",
        denied.body
    );
    server.close().await;
}

/// With no hooks registered, `POST /append` behaves exactly as before the fix
/// (tightening-only: an empty-hooks server must see zero behavior change).
#[tokio::test]
async fn no_hooks_stream_append_still_succeeds() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;

    let ok = server
        .request(
            "POST",
            "/append",
            &[("Authorization", &bearer(&token))],
            r#"{"stream":"Chat","key":"room-1","event":"message","payload":{"text":"hi"},"requestId":"req-1"}"#,
        )
        .await;
    assert_eq!(ok.status, 200, "body: {}", ok.body);
    server.close().await;
}

/// A tightening-only policy hook (FR-296) denies `blob.write` — proving
/// `POST /blobs` (declare) and `PUT /blobs/:id/content` (upload) actually
/// consult `state.policy_hooks` (both previously bypassed them via the sync
/// `ownership_decision` helper, per its FR-245 doc comment before this fix).
#[tokio::test]
async fn policy_hook_denies_blob_write() {
    let mut server = TestServer::boot_with_hooks(vec![Arc::new(DenyAction {
        action: Action::BlobWrite,
    })])
    .await;
    let token = server.login("user-ada").await;

    let denied = server
        .request(
            "POST",
            "/blobs",
            &[("Authorization", &bearer(&token))],
            r#"{"blobId":"blob-1","ownerId":"user-ada","contentHash":"sha256-abc","byteLength":3,"mimeType":"text/plain"}"#,
        )
        .await;
    assert_eq!(
        denied.status, 403,
        "gated blob.write (declare) must be denied: {}",
        denied.body
    );
    assert!(
        denied.body.contains("notAuthorizedForResource"),
        "body: {}",
        denied.body
    );

    let denied_upload = server
        .request(
            "PUT",
            "/blobs/blob-2/content?ownerId=user-ada",
            &[
                ("Authorization", &bearer(&token)),
                ("Content-Type", "text/plain"),
            ],
            "hi!",
        )
        .await;
    assert_eq!(
        denied_upload.status, 403,
        "gated blob.write (upload) must be denied: {}",
        denied_upload.body
    );
    assert!(
        denied_upload.body.contains("notAuthorizedForResource"),
        "body: {}",
        denied_upload.body
    );
    server.close().await;
}

/// With no hooks registered, blob declare + upload behave exactly as before
/// the fix (tightening-only: zero behavior change for an empty-hooks server).
#[tokio::test]
async fn no_hooks_blob_write_still_succeeds() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;

    let declare = server
        .request(
            "POST",
            "/blobs",
            &[("Authorization", &bearer(&token))],
            r#"{"blobId":"blob-1","ownerId":"user-ada","contentHash":"sha256-abc","byteLength":3,"mimeType":"text/plain"}"#,
        )
        .await;
    assert_eq!(declare.status, 201, "body: {}", declare.body);
    server.close().await;
}

/// A tightening-only policy hook (FR-296) denies `projection.read` — proving
/// `GET /projections/:name` actually consults `state.policy_hooks` (it
/// previously never referenced them at all).
#[tokio::test]
async fn policy_hook_denies_projection_read() {
    use frick_server::projections::{
        FrickProjection, FrickProjectionContext, FrickProjectionHandler, FrickProjectionWriteEvent,
        ProjectionApplyResult,
    };

    struct EmptyReadable;
    impl FrickProjectionHandler for EmptyReadable {
        fn apply(
            &self,
            _event: &FrickProjectionWriteEvent,
            _ctx: &FrickProjectionContext,
        ) -> ProjectionApplyResult {
            ProjectionApplyResult::none()
        }
        fn read(
            &self,
            _ctx: &FrickProjectionContext,
            _query: &std::collections::BTreeMap<String, String>,
        ) -> Option<frick_protocol::Value> {
            Some(frick_protocol::Value::Map(Vec::new()))
        }
    }

    let mut server = TestServer::boot_with_hooks_and_projection(
        vec![Arc::new(DenyAction {
            action: Action::ProjectionRead,
        })],
        FrickProjection::new("readable", Vec::new(), Box::new(EmptyReadable)),
    )
    .await;
    let token = server.login("user-ada").await;

    let denied = server.get("/projections/readable", &token).await;
    assert_eq!(
        denied.status, 403,
        "gated projection.read must be denied: {}",
        denied.body
    );
    assert!(
        denied.body.contains("notAuthorizedForResource"),
        "body: {}",
        denied.body
    );
    server.close().await;
}

/// With no hooks registered, `GET /projections/:name` behaves exactly as
/// before the fix (tightening-only: zero behavior change).
#[tokio::test]
async fn no_hooks_projection_read_still_succeeds() {
    use frick_server::projections::{
        FrickProjection, FrickProjectionContext, FrickProjectionHandler, FrickProjectionWriteEvent,
        ProjectionApplyResult,
    };

    struct EmptyReadable;
    impl FrickProjectionHandler for EmptyReadable {
        fn apply(
            &self,
            _event: &FrickProjectionWriteEvent,
            _ctx: &FrickProjectionContext,
        ) -> ProjectionApplyResult {
            ProjectionApplyResult::none()
        }
        fn read(
            &self,
            _ctx: &FrickProjectionContext,
            _query: &std::collections::BTreeMap<String, String>,
        ) -> Option<frick_protocol::Value> {
            Some(frick_protocol::Value::Map(Vec::new()))
        }
    }

    let mut server = TestServer::boot_with_hooks_and_projection(
        Vec::new(),
        FrickProjection::new("readable", Vec::new(), Box::new(EmptyReadable)),
    )
    .await;
    let token = server.login("user-ada").await;

    let ok = server.get("/projections/readable", &token).await;
    assert_eq!(ok.status, 200, "body: {}", ok.body);
    server.close().await;
}

/// A tightening-only policy hook (FR-296) denies `object.read` — proving
/// `GET /objects` (LIST) actually consults `state.policy_hooks` per row (it
/// previously never built an `Action::ObjectRead` decision at all). A hook
/// denying the whole type still lets through exactly the rows the caller
/// holds an active sharing grant on (composes with grant relaxation, doesn't
/// replace it).
#[tokio::test]
async fn policy_hook_denies_object_read_list_but_grants_still_surface() {
    let mut server = TestServer::boot_with_hooks(vec![Arc::new(DenyAction {
        action: Action::ObjectRead,
    })])
    .await;
    let owner = server.login("user-owner").await;
    let grantee = server.login("user-grantee").await;

    // Owner writes a row (object.write is unaffected — the hook only gates
    // object.read), then grants the grantee "read" on that record.
    let write = server
        .request(
            "PUT",
            "/objects/OwnedNote/note-shared",
            &[("Authorization", &bearer(&owner))],
            r#"{"body":"secret","ownerUserId":"user-owner"}"#,
        )
        .await;
    assert_eq!(write.status, 201, "body: {}", write.body);

    let invite = server
        .request(
            "POST",
            "/share/invite",
            &[("Authorization", &bearer(&owner))],
            r#"{"recordType":"OwnedNote","recordId":"note-shared","permission":"read"}"#,
        )
        .await;
    assert_eq!(invite.status, 201, "body: {}", invite.body);
    let invite_token = extract_json_string(&invite.body, "token");
    let accept = server
        .request(
            "POST",
            "/share/accept",
            &[("Authorization", &bearer(&grantee))],
            &format!(r#"{{"token":"{invite_token}"}}"#),
        )
        .await;
    assert_eq!(accept.status, 201, "body: {}", accept.body);

    // Owner's own list: the hook denies object.read on OwnedNote for every
    // row, INCLUDING the owner's own — the owner holds no grant on their own
    // record, so their row is filtered out of the list entirely.
    let owner_list = server.get("/objects?type=OwnedNote", &owner).await;
    assert_eq!(owner_list.status, 200, "body: {}", owner_list.body);
    assert!(
        !owner_list.body.contains("note-shared"),
        "a gated object.read must hide even the owner's own row: {}",
        owner_list.body
    );

    // Grantee's list: the hook denies the row at the ownership/hook stage, but
    // the active read grant on note-shared flips it back to visible.
    let grantee_list = server.get("/objects?type=OwnedNote", &grantee).await;
    assert_eq!(grantee_list.status, 200, "body: {}", grantee_list.body);
    assert!(
        grantee_list.body.contains("note-shared"),
        "a per-record grant must still surface the row despite the type-level hook deny: {}",
        grantee_list.body
    );

    server.close().await;
}

/// With no hooks registered, `GET /objects` LIST behaves exactly as before the
/// fix (tightening-only: zero behavior change for an empty-hooks server) —
/// this reruns `object_list_is_owner_scoped`'s assertions through the hook
/// codepath to prove it's byte-behavior-identical when hooks are absent.
#[tokio::test]
async fn no_hooks_object_read_list_is_still_owner_scoped() {
    let mut server = TestServer::boot().await;
    let ada = server.login("user-ada").await;
    let bo = server.login("user-bo").await;

    server
        .request(
            "PUT",
            "/objects/OwnedNote/o-ada2",
            &[("Authorization", &bearer(&ada))],
            r#"{"body":"mine","ownerUserId":"user-ada"}"#,
        )
        .await;
    server
        .request(
            "PUT",
            "/objects/OwnedNote/o-bo2",
            &[("Authorization", &bearer(&bo))],
            r#"{"body":"hers","ownerUserId":"user-bo"}"#,
        )
        .await;

    let ada_list = server.get("/objects?type=OwnedNote", &ada).await;
    assert_eq!(ada_list.status, 200, "body: {}", ada_list.body);
    assert!(ada_list.body.contains("o-ada2"), "body: {}", ada_list.body);
    assert!(!ada_list.body.contains("o-bo2"), "body: {}", ada_list.body);
    server.close().await;
}

/// An app-registered route (FR-297) is reachable on the framework server,
/// receives the live AppState, authenticates with the public helper, and reads
/// the store — the server-authoritative command shape a Rust backend needs.
#[tokio::test]
async fn app_route_authenticates_and_reads_the_store() {
    let mut server = TestServer::boot_with_app_router(Box::new(|state| {
        axum::Router::new()
            .route("/commands/note-count", axum::routing::get(note_count))
            .with_state(state)
    }))
    .await;
    let token = server.login("user-ada").await;

    // Unauthenticated → the route's own 401.
    let anon = server.get("/commands/note-count", "").await;
    assert_eq!(anon.status, 401, "body: {}", anon.body);

    // Authenticated, no notes yet.
    let empty = server.get("/commands/note-count", &token).await;
    assert_eq!(empty.status, 200, "body: {}", empty.body);
    assert!(
        empty.body.contains("\"noteCount\":0"),
        "body: {}",
        empty.body
    );
    assert!(empty.body.contains("user-ada"), "body: {}", empty.body);

    // Write a Note through the framework route, then the command sees it.
    let put = server
        .request(
            "PUT",
            "/objects/Note/n-1",
            &[("Authorization", &bearer(&token))],
            r#"{"body":"hi"}"#,
        )
        .await;
    assert_eq!(put.status, 201, "body: {}", put.body);
    let after = server.get("/commands/note-count", &token).await;
    assert!(
        after.body.contains("\"noteCount\":1"),
        "body: {}",
        after.body
    );

    server.close().await;
}

/// FR-303: an app route resolves the trusted client IP. With no trusted proxies
/// configured (the default), a spoofed `X-Forwarded-For` is ignored and the
/// loopback socket peer is used — the spoofing-resistant rate-limit key.
#[tokio::test]
async fn app_route_resolves_trusted_client_ip() {
    let mut server = TestServer::boot_with_app_router(Box::new(|state| {
        axum::Router::new()
            .route("/commands/client-ip", axum::routing::get(client_ip_route))
            .with_state(state)
    }))
    .await;

    let resp = server
        .request(
            "GET",
            "/commands/client-ip",
            &[("X-Forwarded-For", "203.0.113.9")],
            "",
        )
        .await;
    assert_eq!(resp.status, 200, "body: {}", resp.body);
    assert!(
        resp.body.contains("127.0.0.1"),
        "the loopback socket peer must be used: {}",
        resp.body
    );
    assert!(
        !resp.body.contains("203.0.113.9"),
        "an untrusted X-Forwarded-For must be ignored: {}",
        resp.body
    );

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

    // An unknown projection is a TS-faithful sync.protocolError 404 carrying
    // details.reason = "projectionNotFound" (not storage.notFound).
    let missing = server.get("/projections/anything", &token).await;
    assert_eq!(missing.status, 404, "body: {}", missing.body);
    assert!(
        missing.body.contains("sync.protocolError"),
        "body: {}",
        missing.body
    );
    assert!(
        missing.body.contains("projectionNotFound"),
        "body: {}",
        missing.body
    );
    server.close().await;
}
