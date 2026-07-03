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
    /// Retained so a test can inspect the store (e.g. enqueued `blob.process`
    /// jobs). The router holds its own `Arc`, so this never drops the store.
    state: AppState,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    join: Option<tokio::task::JoinHandle<()>>,
}

impl TestServer {
    async fn boot() -> Self {
        Self::boot_with(test_config()).await
    }

    async fn boot_with(config: FrickConfig) -> Self {
        let server = create_frick_server(config, test_schema()).await.unwrap();
        Self::serve(server).await
    }

    /// Boot with app-provided blob processors (FR-272) registered via the boot
    /// seam, so the sync-validate → 415 and async-enqueue paths run live.
    async fn boot_with_processors(
        processors: Vec<frick_server::blob_processors::SharedBlobProcessor>,
    ) -> Self {
        let mut seams = frick_server::BootSeams::production();
        seams.blob_processors = processors;
        let server =
            frick_server::create_frick_server_with_seams(test_config(), test_schema(), seams)
                .await
                .unwrap();
        Self::serve(server).await
    }

    async fn serve(server: frick_server::FrickServer) -> Self {
        let state: AppState = Arc::clone(&server.state);
        // Keep the store alive for the process; the router holds its own Arc.
        std::mem::forget(server);

        let router = public_router(Arc::clone(&state))
            .merge(frick_server::auth_routes::auth_router(Arc::clone(&state)))
            .merge(routes::dataplane_router(Arc::clone(&state)));

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
            state,
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

// ── blob processors / validators (FR-272) ───────────────────────────────────

/// A sync validator that rejects everything except `text/plain` produces a
/// `415 blob.unsupportedContentType` with the processor id + rejection reason,
/// and NO blob row is created.
#[tokio::test]
async fn sync_validator_rejects_with_415() {
    use frick_server::blob_processors::{MimeSizeValidatorOptions, mime_size_validator};
    let validator = mime_size_validator(MimeSizeValidatorOptions {
        id: "text-only".to_string(),
        allowed_mime_types: vec!["text/plain".to_string()],
        ..Default::default()
    });
    let mut server = TestServer::boot_with_processors(vec![validator]).await;
    let token = server.login("user-ada").await;

    // A PNG upload is rejected by the validator (415).
    let upload = server
        .request(
            "PUT",
            "/blobs/img-1/content?ownerId=user-ada",
            &[
                ("Authorization", &bearer(&token)),
                ("Content-Type", "image/png"),
            ],
            b"\x89PNG\r\n\x1a\n not really",
        )
        .await;
    assert_eq!(upload.status, 415, "body: {}", upload.text());
    assert!(
        upload.text().contains("blob.unsupportedContentType"),
        "{}",
        upload.text()
    );
    assert!(upload.text().contains("text-only"), "{}", upload.text());
    assert!(
        upload.text().contains("blobValidationRejected"),
        "{}",
        upload.text()
    );

    // No metadata row was written — a follow-up GET is a 404.
    let meta = server.get("/blobs/img-1", &token).await;
    assert_eq!(meta.status, 404, "body: {}", meta.text());

    // An allowed text upload to the SAME validator goes through (201).
    let ok = server
        .request(
            "PUT",
            "/blobs/txt-1/content?ownerId=user-ada",
            &[
                ("Authorization", &bearer(&token)),
                ("Content-Type", "text/plain"),
            ],
            b"hello",
        )
        .await;
    assert_eq!(ok.status, 201, "body: {}", ok.text());
    server.close().await;
}

/// An async processor (a `process` hook, no `validate`) enqueues exactly one
/// `blob.process` job per upload, with the `{blobId, processorId}` payload and
/// the `<blobId>:<processorId>:<contentHash>` idempotency key (a re-upload of
/// the same bytes is a no-op enqueue).
#[tokio::test]
async fn async_processor_enqueues_blob_process_job() {
    use std::sync::Arc;

    use frick_server::blob_processors::{
        BlobProcessContext, BlobProcessOutcome, BlobProcessor, ProcessFuture, ProcessorMatch,
    };
    use frick_store::stores::job::ListJobsFilter;

    struct ThumbProcessor;
    impl BlobProcessor for ThumbProcessor {
        #[allow(clippy::unnecessary_literal_bound)] // trait sig is `-> &str`
        fn id(&self) -> &str {
            "thumb"
        }
        fn has_process(&self) -> bool {
            true
        }
        fn process<'a>(&'a self, _ctx: BlobProcessContext<'a>) -> ProcessFuture<'a> {
            Box::pin(async { Ok(BlobProcessOutcome::default()) })
        }
        fn matches(&self) -> ProcessorMatch {
            ProcessorMatch::default()
        }
    }

    let mut server = TestServer::boot_with_processors(vec![Arc::new(ThumbProcessor)]).await;
    let token = server.login("user-ada").await;

    let upload = server
        .request(
            "PUT",
            "/blobs/pic/content?ownerId=user-ada",
            &[
                ("Authorization", &bearer(&token)),
                ("Content-Type", "image/png"),
            ],
            b"pixels",
        )
        .await;
    assert_eq!(upload.status, 201, "body: {}", upload.text());

    // Exactly one blob.process job was enqueued for this tenant.
    let jobs = server
        .state
        .store
        .jobs()
        .list(&ListJobsFilter {
            job_type: Some("blob.process".to_string()),
            ..ListJobsFilter::default()
        })
        .await
        .unwrap();
    assert_eq!(jobs.len(), 1, "expected one blob.process job, got {jobs:?}");

    // Re-uploading the SAME bytes is idempotent — still exactly one job.
    let again = server
        .request(
            "PUT",
            "/blobs/pic/content?ownerId=user-ada",
            &[
                ("Authorization", &bearer(&token)),
                ("Content-Type", "image/png"),
            ],
            b"pixels",
        )
        .await;
    assert_eq!(again.status, 200, "body: {}", again.text());
    let jobs = server
        .state
        .store
        .jobs()
        .list(&ListJobsFilter {
            job_type: Some("blob.process".to_string()),
            ..ListJobsFilter::default()
        })
        .await
        .unwrap();
    assert_eq!(jobs.len(), 1, "re-upload should be idempotent: {jobs:?}");

    server.close().await;
}

/// A duplicate processor id is a boot-time config error (fail loud).
#[tokio::test]
async fn duplicate_processor_id_fails_boot() {
    use frick_server::blob_processors::{MimeSizeValidatorOptions, mime_size_validator};
    let a = mime_size_validator(MimeSizeValidatorOptions {
        id: "dupe".to_string(),
        ..Default::default()
    });
    let b = mime_size_validator(MimeSizeValidatorOptions {
        id: "dupe".to_string(),
        ..Default::default()
    });
    let mut seams = frick_server::BootSeams::production();
    seams.blob_processors = vec![a, b];
    let result =
        frick_server::create_frick_server_with_seams(test_config(), test_schema(), seams).await;
    assert!(result.is_err(), "duplicate processor id should fail boot");
}

// ── AURA-432: chunked/resumable upload ──────────────────────────────────────

impl TestServer {
    /// PUT one chunk of a resumable upload: a `Content-Range: bytes
    /// <start>-<end>/<total>` header alongside the raw chunk bytes.
    async fn put_chunk(
        &self,
        path: &str,
        token: &str,
        start: usize,
        end: usize,
        total: usize,
        chunk: &[u8],
    ) -> HttpResponse {
        self.request(
            "PUT",
            path,
            &[
                ("Authorization", &bearer(token)),
                ("Content-Range", &format!("bytes {start}-{end}/{total}")),
            ],
            chunk,
        )
        .await
    }

    async fn head(&self, path: &str, token: &str) -> HttpResponse {
        self.request("HEAD", path, &[("Authorization", &bearer(token))], b"")
            .await
    }
}

/// Two chunks land in order, the final chunk assembles + commits the whole
/// blob exactly like a whole-body upload, and the `HEAD` probe reports 0
/// once the upload is finalized (nothing left staged).
#[tokio::test]
async fn chunked_upload_two_chunks_assembles_and_commits() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;

    let full = b"hello chunked world!!"; // 21 bytes
    assert_eq!(full.len(), 21);
    let (first, second) = full.split_at(11);

    // Probe before any chunk lands: nothing staged.
    let probe = server.head("/blobs/chunked-1/content", &token).await;
    assert_eq!(probe.status, 200, "body: {}", probe.text());
    assert_eq!(probe.header("x-frick-upload-offset"), Some("0"));

    // First (non-final) chunk → 202, reports the new offset.
    let chunk1 = server
        .put_chunk(
            "/blobs/chunked-1/content?ownerId=user-ada",
            &token,
            0,
            10,
            full.len(),
            first,
        )
        .await;
    assert_eq!(chunk1.status, 202, "body: {}", chunk1.text());
    assert!(
        chunk1.text().contains("\"receivedOffset\":11"),
        "{}",
        chunk1.text()
    );

    // The metadata row does not exist yet — the upload is still in flight.
    let meta_during = server.get("/blobs/chunked-1", &token).await;
    assert_eq!(meta_during.status, 404, "body: {}", meta_during.text());

    // HEAD now reports the staged offset.
    let probe2 = server.head("/blobs/chunked-1/content", &token).await;
    assert_eq!(probe2.status, 200, "body: {}", probe2.text());
    assert_eq!(probe2.header("x-frick-upload-offset"), Some("11"));

    // Final chunk completes the range → 201 (new blob), same shape as a
    // whole-body upload response.
    let chunk2 = server
        .put_chunk(
            "/blobs/chunked-1/content?ownerId=user-ada",
            &token,
            11,
            full.len() - 1,
            full.len(),
            second,
        )
        .await;
    assert_eq!(chunk2.status, 201, "body: {}", chunk2.text());
    assert!(chunk2.text().contains("\"ok\":true"), "{}", chunk2.text());
    assert!(
        chunk2.text().contains("\"byteLength\":21"),
        "{}",
        chunk2.text()
    );

    // The assembled bytes round-trip exactly through the normal download path.
    let download = server.get("/blobs/chunked-1/content", &token).await;
    assert_eq!(download.status, 200, "body: {}", download.text());
    assert_eq!(download.body, full);

    // The staging area is cleared on finalize — HEAD reports 0 again (the
    // blob is complete, not "in flight").
    let probe3 = server.head("/blobs/chunked-1/content", &token).await;
    assert_eq!(probe3.status, 200, "body: {}", probe3.text());
    assert_eq!(probe3.header("x-frick-upload-offset"), Some("0"));

    server.close().await;
}

/// A chunk whose declared `start` does not match the server's staged offset
/// is rejected with a 409 naming the offset the server actually has, so a
/// client can resync.
#[tokio::test]
async fn chunked_upload_out_of_order_chunk_is_rejected() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;

    let full = b"0123456789abcdef"; // 16 bytes
    let chunk1 = server
        .put_chunk(
            "/blobs/chunked-2/content?ownerId=user-ada",
            &token,
            0,
            7,
            full.len(),
            &full[..8],
        )
        .await;
    assert_eq!(chunk1.status, 202, "body: {}", chunk1.text());

    // Retrying the SAME range (start=0) instead of resuming from 8 is a
    // conflict: the server already has 8 bytes staged.
    let replay = server
        .put_chunk(
            "/blobs/chunked-2/content?ownerId=user-ada",
            &token,
            0,
            7,
            full.len(),
            &full[..8],
        )
        .await;
    assert_eq!(replay.status, 409, "body: {}", replay.text());
    assert!(
        replay.text().contains("\"expectedOffset\":8"),
        "{}",
        replay.text()
    );

    // Skipping ahead (start=9, past the staged offset of 8) is also rejected.
    let skip_ahead = server
        .put_chunk(
            "/blobs/chunked-2/content?ownerId=user-ada",
            &token,
            9,
            15,
            full.len(),
            &full[9..],
        )
        .await;
    assert_eq!(skip_ahead.status, 409, "body: {}", skip_ahead.text());
    assert!(
        skip_ahead.text().contains("\"expectedOffset\":8"),
        "{}",
        skip_ahead.text()
    );

    server.close().await;
}

/// A client that lost track of its own progress can call `HEAD` to learn the
/// server's committed offset and resume the upload from exactly that point.
#[tokio::test]
async fn chunked_upload_resumes_from_probed_offset() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;

    let full = b"resume-me-please-thanks"; // 23 bytes
    let path = "/blobs/chunked-3/content?ownerId=user-ada";

    let chunk1 = server
        .put_chunk(path, &token, 0, 9, full.len(), &full[..10])
        .await;
    assert_eq!(chunk1.status, 202, "body: {}", chunk1.text());

    // Simulate a client restart: it doesn't remember its offset, so it asks.
    let probe = server.head("/blobs/chunked-3/content", &token).await;
    assert_eq!(probe.status, 200, "body: {}", probe.text());
    let offset: usize = probe
        .header("x-frick-upload-offset")
        .and_then(|value| value.parse().ok())
        .expect("offset header present");
    assert_eq!(offset, 10);

    // Resume from the probed offset through to the end.
    let finish = server
        .put_chunk(
            path,
            &token,
            offset,
            full.len() - 1,
            full.len(),
            &full[offset..],
        )
        .await;
    assert_eq!(finish.status, 201, "body: {}", finish.text());

    let download = server.get("/blobs/chunked-3/content", &token).await;
    assert_eq!(download.status, 200, "body: {}", download.text());
    assert_eq!(download.body, full);

    server.close().await;
}

/// The final chunk's assembled length is checked against the declared total
/// — a client that lies about `total` (or drops bytes) gets a 400, not a
/// silently truncated/corrupted blob.
#[tokio::test]
async fn chunked_upload_final_chunk_length_mismatch_is_rejected() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;

    // Declares total=10 but only ever sends 5 bytes as the "final" chunk
    // (end+1 == total is satisfied by the header math, the actual body is
    // short).
    let bad = server
        .put_chunk(
            "/blobs/chunked-4/content?ownerId=user-ada",
            &token,
            0,
            9,
            10,
            b"short",
        )
        .await;
    assert_eq!(bad.status, 400, "body: {}", bad.text());

    server.close().await;
}

/// The reserved staging namespace can never be read back through the public
/// derivatives surface, even by the same owner who is running the chunked
/// upload — the staged bytes are only ever visible to the finalize step.
#[tokio::test]
async fn chunked_upload_staging_is_not_reachable_via_derivatives_api() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;

    let chunk1 = server
        .put_chunk(
            "/blobs/chunked-5/content?ownerId=user-ada",
            &token,
            0,
            4,
            10,
            b"hello",
        )
        .await;
    assert_eq!(chunk1.status, 202, "body: {}", chunk1.text());

    // Declare + "own" a blob whose id equals the reserved staging parent key
    // for chunked-5, then try to read its derivatives — must 404, not leak
    // the in-flight staged bytes.
    let staging_key = "\u{0}aura-432-upload\u{0}chunked-5";
    // The JSON body needs the NUL bytes JSON-escaped (a raw NUL is not
    // legal inside a JSON string); the URL path below uses the literal bytes.
    let json_escaped_key = staging_key.replace('\u{0}', "\\u0000");
    let declare_body = format!(
        r#"{{"blobId":"{json_escaped_key}","ownerId":"user-ada","contentHash":"sha256-pending","byteLength":0,"mimeType":"text/plain"}}"#
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

    let derivatives = server
        .get(
            &format!("/blobs/{}/derivatives", urlencode(staging_key)),
            &token,
        )
        .await;
    assert_eq!(derivatives.status, 404, "body: {}", derivatives.text());
    assert!(
        derivatives.text().contains("blob_not_found"),
        "{}",
        derivatives.text()
    );

    server.close().await;
}

/// Percent-encode a path segment's NUL bytes (the only characters our test
/// staging key contains that aren't already URL-safe) so it survives the raw
/// HTTP request line intact.
fn urlencode(input: &str) -> String {
    input.replace('\u{0}', "%00")
}
