//! Integration tests for the blob content HTTP surface (map 05 §3.5/§3.6).
//!
//! Boot a real server over loopback, dev-login to mint a session token, then
//! exercise the blob routes end-to-end: declare → PUT content → GET content
//! round-trips the raw bytes, the 404 shapes, and the oversize 413. The server
//! uses the default sqlite blob-bytes driver (`blob_content` table).
//!
//! The harness mirrors `tests/dataplane.rs`; the routes reach the wire via
//! `routes::dataplane_router`, which merges `blobs::blobs_router` (the
//! integrator's `dataplane_router` merge, already in place).

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
    config_with(&[])
}

fn config_with(extra: &[(&str, &str)]) -> FrickConfig {
    let mut env = std::collections::BTreeMap::new();
    env.insert("FRICK_ENV".to_string(), "test".to_string());
    env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
    env.insert("FRICK_PORT".to_string(), "0".to_string());
    for (key, value) in extra {
        env.insert((*key).to_string(), (*value).to_string());
    }
    load_frick_config(&env).unwrap()
}

fn test_schema() -> FrickSchema {
    SchemaBuilder::new("blobs-test", "blobs-test")
        .hash("blobs-test-hash")
        .object("Note", 1, |o| o.field(field::string("body", 1).required()))
        .build()
        .expect("test schema validates")
}

struct TestServer {
    port: u16,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    join: Option<tokio::task::JoinHandle<()>>,
}

impl TestServer {
    async fn boot() -> Self {
        Self::boot_with(test_config()).await
    }

    async fn boot_with(config: FrickConfig) -> Self {
        let server = create_frick_server(config, test_schema()).await.unwrap();
        let state: AppState = Arc::clone(&server.state);
        // Keep the store alive for the process; the router holds its own Arc.
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

    async fn login(&self, user_id: &str) -> String {
        let body = format!(r#"{{"userId":"{user_id}"}}"#);
        let response = self
            .request(
                "POST",
                "/auth/dev-login",
                &[("Content-Type", "application/json")],
                body.as_bytes(),
            )
            .await;
        extract_json_string(&response.text(), "sessionToken")
    }

    /// Issue an HTTP/1.1 request over a fresh connection. `body` is raw bytes so
    /// blob uploads can carry arbitrary content.
    async fn request(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: &[u8],
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
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\n{header_block}Content-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let mut raw = request.into_bytes();
        raw.extend_from_slice(body);
        stream.write_all(&raw).await.unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        HttpResponse::parse(&response)
    }

    async fn get(&self, path: &str, token: &str) -> HttpResponse {
        self.request("GET", path, &[("Authorization", &bearer(token))], b"")
            .await
    }
}

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

/// A minimally-parsed HTTP response: status, headers, raw body bytes.
struct HttpResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl HttpResponse {
    fn parse(raw: &[u8]) -> Self {
        // Split on the CRLFCRLF header/body boundary, working on bytes so a
        // binary body survives intact.
        let split = raw
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map(|i| (i, i + 4));
        let (head, body) = match split {
            Some((head_end, body_start)) => (&raw[..head_end], raw[body_start..].to_vec()),
            None => (raw, Vec::new()),
        };
        let head = String::from_utf8_lossy(head);
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
            body,
        }
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
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

// ── tests ─────────────────────────────────────────────────────────────────

/// Every blob route requires authentication.
#[tokio::test]
async fn blobs_require_authentication() {
    let mut server = TestServer::boot().await;
    let response = server.request("GET", "/blobs", &[], b"").await;
    assert_eq!(response.status, 401, "body: {}", response.text());
    assert!(response.text().contains("auth.unauthenticated"));
    server.close().await;
}

/// Declare metadata → PUT content → GET content round-trips the exact bytes,
/// with the documented headers; the empty `GET /blobs` usage block is present.
#[tokio::test]
async fn declare_put_get_content_round_trip() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;

    // 1. Declare metadata (owner must be the caller's userId).
    let declare = server
        .request(
            "POST",
            "/blobs",
            &[
                ("Authorization", &bearer(&token)),
                ("Content-Type", "application/json"),
            ],
            br#"{"blobId":"blob-1","ownerId":"user-ada","contentHash":"sha256-pending","byteLength":11,"mimeType":"text/plain"}"#,
        )
        .await;
    assert_eq!(declare.status, 201, "body: {}", declare.text());
    assert!(declare.text().contains("\"ok\":true"));
    assert!(declare.text().contains("\"blobId\":\"blob-1\""));

    // 2. Upload bytes. The stored contentHash is "sha256-pending" (not a
    // sha256- match check would fail) — so re-declare with the real hash first
    // for the overwrite path. Here we just upload to a fresh blob via the NEW
    // path on a different id to keep the hash check out of scope.
    let upload = server
        .request(
            "PUT",
            "/blobs/blob-2/content?ownerId=user-ada",
            &[
                ("Authorization", &bearer(&token)),
                ("Content-Type", "text/plain"),
            ],
            b"hello world",
        )
        .await;
    assert_eq!(upload.status, 201, "body: {}", upload.text());
    assert!(upload.text().contains("\"ok\":true"), "{}", upload.text());
    assert!(
        upload.text().contains("\"byteLength\":11"),
        "{}",
        upload.text()
    );
    // contentHash of "hello world".
    assert!(
        upload
            .text()
            .contains("sha256-b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"),
        "{}",
        upload.text()
    );

    // 3. Download: exact bytes + headers.
    let download = server.get("/blobs/blob-2/content", &token).await;
    assert_eq!(download.status, 200, "body: {}", download.text());
    assert_eq!(download.body, b"hello world");
    assert_eq!(download.header("content-type"), Some("text/plain"));
    assert_eq!(download.header("content-length"), Some("11"));
    assert_eq!(download.header("x-frick-blob-id"), Some("blob-2"));
    assert_eq!(
        download.header("x-frick-content-hash"),
        Some("sha256-b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9")
    );

    // 4. Metadata GET reflects the created row.
    let meta = server.get("/blobs/blob-2", &token).await;
    assert_eq!(meta.status, 200, "body: {}", meta.text());
    assert!(meta.text().contains("\"blobId\":\"blob-2\""));
    assert!(meta.text().contains("\"byteLength\":11"));
    assert!(meta.text().contains("\"mimeType\":\"text/plain\""));

    // 5. Owner-scoped GET /blobs carries the usage block (quota null = unlimited).
    let list = server.get("/blobs", &token).await;
    assert_eq!(list.status, 200, "body: {}", list.text());
    assert!(list.text().contains("\"usage\""), "{}", list.text());
    assert!(
        list.text().contains("\"quotaBytes\":null"),
        "{}",
        list.text()
    );
    // Both the declared-only blob-1 (11) and the uploaded blob-2 (11) count.
    assert!(list.text().contains("\"usedBytes\":22"), "{}", list.text());
    assert!(list.text().contains("blob-2"), "{}", list.text());

    server.close().await;
}

/// The declared-then-upload path validates byteLength + (sha256-) contentHash
/// against the stored metadata, and overwrites on a 200.
#[tokio::test]
async fn declared_then_upload_validates_and_overwrites() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;

    // Declare with the correct sha256 hash + length of "hi".
    let correct_hash = "sha256-8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4";
    let declare_body = format!(
        r#"{{"blobId":"blob-3","ownerId":"user-ada","contentHash":"{correct_hash}","byteLength":2,"mimeType":"text/plain"}}"#
    );
    let declare = server
        .request(
            "POST",
            "/blobs",
            &[
                ("Authorization", &bearer(&token)),
                ("Content-Type", "application/json"),
            ],
            declare_body.as_bytes(),
        )
        .await;
    assert_eq!(declare.status, 201, "body: {}", declare.text());

    // A length mismatch (3 bytes vs declared 2) is a 400.
    let bad_len = server
        .request(
            "PUT",
            "/blobs/blob-3/content",
            &[("Authorization", &bearer(&token))],
            b"abc",
        )
        .await;
    assert_eq!(bad_len.status, 400, "body: {}", bad_len.text());
    assert!(
        bad_len.text().contains("byteLength mismatch"),
        "{}",
        bad_len.text()
    );

    // The correct bytes upload → 200 (existing metadata path) and the response
    // echoes the STORED contentHash.
    let ok = server
        .request(
            "PUT",
            "/blobs/blob-3/content",
            &[("Authorization", &bearer(&token))],
            b"hi",
        )
        .await;
    assert_eq!(ok.status, 200, "body: {}", ok.text());
    assert!(ok.text().contains(correct_hash), "{}", ok.text());

    server.close().await;
}

/// Unknown ids 404 with the documented shapes.
#[tokio::test]
async fn missing_blob_404_shapes() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;

    let meta = server.get("/blobs/nope", &token).await;
    assert_eq!(meta.status, 404, "body: {}", meta.text());
    assert!(meta.text().contains("blob_not_found"), "{}", meta.text());

    let content = server.get("/blobs/nope/content", &token).await;
    assert_eq!(content.status, 404, "body: {}", content.text());
    assert!(
        content.text().contains("blob_content_not_found"),
        "{}",
        content.text()
    );

    // Derivative content of an unknown parent is `blob_not_found`.
    let deriv = server
        .get("/blobs/nope/derivatives/thumb/content", &token)
        .await;
    assert_eq!(deriv.status, 404, "body: {}", deriv.text());
    assert!(deriv.text().contains("blob_not_found"), "{}", deriv.text());

    // Empty derivative list of an unknown parent is `blob_not_found`.
    let deriv_list = server.get("/blobs/nope/derivatives", &token).await;
    assert_eq!(deriv_list.status, 404, "body: {}", deriv_list.text());
    assert!(
        deriv_list.text().contains("blob_not_found"),
        "{}",
        deriv_list.text()
    );

    server.close().await;
}

/// A blob with metadata but no bytes → `blob_content_not_found` on the content
/// GET, while its derivative list is empty (200 `{derivatives:[]}`).
#[tokio::test]
async fn declared_without_bytes_has_no_content_and_empty_derivatives() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;

    server
        .request(
            "POST",
            "/blobs",
            &[
                ("Authorization", &bearer(&token)),
                ("Content-Type", "application/json"),
            ],
            br#"{"blobId":"meta-only","ownerId":"user-ada","contentHash":"sha256-x","byteLength":0,"mimeType":"text/plain"}"#,
        )
        .await;

    let content = server.get("/blobs/meta-only/content", &token).await;
    assert_eq!(content.status, 404, "body: {}", content.text());
    assert!(content.text().contains("blob_content_not_found"));

    let derivatives = server.get("/blobs/meta-only/derivatives", &token).await;
    assert_eq!(derivatives.status, 200, "body: {}", derivatives.text());
    assert!(
        derivatives.text().contains("\"derivatives\":[]"),
        "{}",
        derivatives.text()
    );

    server.close().await;
}

/// An oversize upload is a 413 `blob.tooLarge`. The default `maxBlobBytes` is
/// 25 MB, so we lower it via a tenant-settings override would be ideal — but
/// the route reads `config.limits.max_blob_bytes`, which the test config can't
/// cheaply shrink. Instead assert the envelope code/shape on a normal upload's
/// success and rely on the unit test for the size math; here we confirm a small
/// upload is NOT rejected (the boundary is exercised in `routes::blobs::tests`).
#[tokio::test]
async fn small_upload_is_not_rejected_as_too_large() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;

    let upload = server
        .request(
            "PUT",
            "/blobs/small/content?ownerId=user-ada",
            &[("Authorization", &bearer(&token))],
            b"tiny",
        )
        .await;
    assert_eq!(upload.status, 201, "body: {}", upload.text());
    server.close().await;
}

/// A new-blob upload missing both `?ownerId=` and `x-frick-owner-id` is a 400.
#[tokio::test]
async fn new_upload_requires_owner_id() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;

    let upload = server
        .request(
            "PUT",
            "/blobs/no-owner/content",
            &[("Authorization", &bearer(&token))],
            b"bytes",
        )
        .await;
    assert_eq!(upload.status, 400, "body: {}", upload.text());
    assert!(upload.text().contains("ownerId"), "{}", upload.text());
    server.close().await;
}

/// A non-admin uploading to a blob owned by ANOTHER user is forbidden (the
/// `blob.write` baseline `ownerMismatch` deny — no cascade for writes).
#[tokio::test]
async fn upload_to_another_users_blob_is_forbidden() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;

    let upload = server
        .request(
            "PUT",
            "/blobs/theirs/content?ownerId=user-bob",
            &[("Authorization", &bearer(&token))],
            b"bytes",
        )
        .await;
    assert_eq!(upload.status, 403, "body: {}", upload.text());
    assert!(
        upload.text().contains("auth.forbidden"),
        "{}",
        upload.text()
    );
    server.close().await;
}

/// With a finite per-principal quota, an upload whose projected total exceeds
/// the cap is a 413 `blob.quotaExceeded`; an upload within the cap succeeds.
#[tokio::test]
async fn upload_exceeding_quota_is_413() {
    // Cap the owner at 8 bytes (FRICK_MAX_BLOB_BYTES_PER_PRINCIPAL).
    let mut server =
        TestServer::boot_with(config_with(&[("FRICK_MAX_BLOB_BYTES_PER_PRINCIPAL", "8")])).await;
    let token = server.login("user-ada").await;

    // 5 bytes ≤ 8 → allowed.
    let first = server
        .request(
            "PUT",
            "/blobs/q-1/content?ownerId=user-ada",
            &[("Authorization", &bearer(&token))],
            b"abcde",
        )
        .await;
    assert_eq!(first.status, 201, "body: {}", first.text());

    // A second blob of 5 bytes projects to 10 > 8 → 413 blob.quotaExceeded.
    let second = server
        .request(
            "PUT",
            "/blobs/q-2/content?ownerId=user-ada",
            &[("Authorization", &bearer(&token))],
            b"fghij",
        )
        .await;
    assert_eq!(second.status, 413, "body: {}", second.text());
    assert!(
        second.text().contains("blob.quotaExceeded"),
        "{}",
        second.text()
    );
    assert!(
        second
            .text()
            .contains("blob quota exceeded for owner user-ada"),
        "{}",
        second.text()
    );

    server.close().await;
}

/// With a tiny `maxBlobBytes` the over-size upload is a 413 `blob.tooLarge`
/// carrying `configuredMax`/`actualValue` details.
#[tokio::test]
async fn upload_exceeding_max_blob_bytes_is_413() {
    // There is no env var for maxBlobBytes; shrink it on the resolved config.
    let mut config = test_config();
    config.limits.max_blob_bytes = 4;
    let mut server = TestServer::boot_with(config).await;
    let token = server.login("user-ada").await;

    let upload = server
        .request(
            "PUT",
            "/blobs/big/content?ownerId=user-ada",
            &[("Authorization", &bearer(&token))],
            b"hello world",
        )
        .await;
    assert_eq!(upload.status, 413, "body: {}", upload.text());
    assert!(upload.text().contains("blob.tooLarge"), "{}", upload.text());
    assert!(upload.text().contains("configuredMax"), "{}", upload.text());
    server.close().await;
}
