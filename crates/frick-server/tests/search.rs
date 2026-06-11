//! Integration tests for the search subsystem (FR-245, map 03 §13).
//!
//! These boot a real server over a loopback socket with a registered search
//! index over a `Note` object type, dev-login to mint a session token, write
//! objects through the store (driving the boot-installed search projector into
//! the FTS tables), then exercise `POST /search`:
//!
//! - (a) the projector indexed the writes (a query returns hits),
//! - (b) the route returns `{hits, total}` with reserved `__frickSource*`
//!   fields stripped and the limits enforced (q too large / bad filter key →
//!   `invalidSearchQuery`),
//! - (c) deleting an object removes it from results,
//! - (d) an unauthorized principal is filtered from the hits.
//!
//! Mirrors the `dataplane.rs` harness (it merges the data-plane router, which
//! now includes `POST /search`).

use std::sync::Arc;

use frick_protocol::{FrickSchema, Value};
use frick_schema::SchemaBuilder;
use frick_schema::builder::field;
use frick_server::config::load_frick_config;
use frick_server::http::{AppState, public_router};
use frick_server::search::{FrickSearchIndexDefinition, SearchDoc, SearchSource};
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

/// A `Note` object carrying a searchable `body` and an `ownerId` (so the
/// per-hit owner-read baseline can distinguish principals).
fn test_schema() -> FrickSchema {
    SchemaBuilder::new("search-test", "search-test")
        .hash("search-test-hash")
        .object("Note", 1, |o| {
            o.field(field::string("body", 1).required())
                .field(field::string("ownerId", 2))
                .field(field::string("room", 3))
        })
        .build()
        .expect("test schema validates")
}

/// Pull a string field out of an rmpv map value.
fn map_str(value: &Value, key: &str) -> Option<String> {
    let Value::Map(entries) = value else {
        return None;
    };
    entries
        .iter()
        .find(|(k, _)| k.as_str() == Some(key))
        .and_then(|(_, v)| v.as_str())
        .map(str::to_string)
}

/// The `notes` index: text = the note body; carries `ownerId` through as a
/// filter field. The reserved source fields are injected by the registry.
fn notes_index() -> FrickSearchIndexDefinition {
    FrickSearchIndexDefinition::new(
        "notes",
        SearchSource::Object {
            type_name: "Note".to_string(),
        },
        Arc::new(|value: &Value| {
            let body = map_str(value, "body")?;
            let mut doc = SearchDoc::new(map_str(value, "id").unwrap_or_default(), body);
            if let Some(owner) = map_str(value, "ownerId") {
                doc.fields
                    .insert("ownerId".to_string(), serde_json::Value::from(owner));
            }
            if let Some(room) = map_str(value, "room") {
                doc.fields
                    .insert("room".to_string(), serde_json::Value::from(room));
            }
            Some(doc)
        }),
    )
}

struct TestServer {
    state: AppState,
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
        // Register the index BEFORE any write; the boot-installed projector
        // closure reads this live registry on every store write.
        state.search.register(notes_index()).unwrap();
        // Keep the constructed server's store alive for the process lifetime.
        std::mem::forget(server);

        let router = public_router(Arc::clone(&state))
            .merge(frick_server::auth_routes::auth_router(Arc::clone(&state)))
            .merge(routes::dataplane_router(Arc::clone(&state)))
            .merge(routes::inspect::inspect_router(Arc::clone(&state)));

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
            state,
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

    /// `POST /search` with a bearer token.
    async fn search(&self, token: &str, body: &str) -> HttpResponse {
        self.request(
            "POST",
            "/search",
            &[("Authorization", &bearer(token))],
            body,
        )
        .await
    }

    /// Write a `Note` through the store so the search projector runs.
    async fn put_note(&self, token: &str, id: &str, body: &str, owner: &str) -> HttpResponse {
        let payload = format!(r#"{{"body":"{body}","ownerId":"{owner}"}}"#);
        self.request(
            "PUT",
            &format!("/objects/Note/{id}"),
            &[("Authorization", &bearer(token))],
            &payload,
        )
        .await
    }

    /// Like [`Self::put_note`] but also sets the `room` filter field.
    async fn put_note_room(
        &self,
        token: &str,
        id: &str,
        body: &str,
        owner: &str,
        room: &str,
    ) -> HttpResponse {
        let payload = format!(r#"{{"body":"{body}","ownerId":"{owner}","room":"{room}"}}"#);
        self.request(
            "PUT",
            &format!("/objects/Note/{id}"),
            &[("Authorization", &bearer(token))],
            &payload,
        )
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
        let status = head
            .split("\r\n")
            .next()
            .unwrap_or("")
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

// ── tests ───────────────────────────────────────────────────────────────────

/// (a) + (b): the projector indexes object writes, and `POST /search` returns
/// hits with reserved fields stripped.
#[tokio::test]
async fn search_indexes_writes_and_strips_reserved_fields() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;

    let create = server
        .put_note(&token, "note-1", "alpha bravo charlie", "user-ada")
        .await;
    assert_eq!(create.status, 201, "body: {}", create.body);
    server
        .put_note(&token, "note-2", "delta echo foxtrot", "user-ada")
        .await;

    // (a) the projector indexed them — a matching query returns the hit.
    let response = server
        .search(&token, r#"{"index":"notes","q":"bravo"}"#)
        .await;
    assert_eq!(response.status, 200, "body: {}", response.body);
    assert!(
        response.body.contains("\"docId\":\"note-1\""),
        "body: {}",
        response.body
    );
    assert!(
        !response.body.contains("note-2"),
        "delta-only note must not match 'bravo': {}",
        response.body
    );
    assert!(
        response.body.contains("\"total\":1"),
        "body: {}",
        response.body
    );

    // (b) reserved __frickSource* fields are stripped; the app field survives.
    assert!(
        !response.body.contains("__frickSource"),
        "reserved fields must be stripped: {}",
        response.body
    );
    assert!(
        response.body.contains("\"ownerId\":\"user-ada\""),
        "app field must survive: {}",
        response.body
    );

    server.close().await;
}

/// (b): limit enforcement — a `limit` clamps the page size.
#[tokio::test]
async fn search_limit_is_enforced() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;
    server
        .put_note(&token, "n1", "common word here", "user-ada")
        .await;
    server
        .put_note(&token, "n2", "common word here", "user-ada")
        .await;
    server
        .put_note(&token, "n3", "common word here", "user-ada")
        .await;

    let response = server
        .search(&token, r#"{"index":"notes","q":"common","limit":2}"#)
        .await;
    assert_eq!(response.status, 200, "body: {}", response.body);
    // Exactly two hits returned despite three matches.
    let hit_count = response.body.matches("\"docId\"").count();
    assert_eq!(hit_count, 2, "body: {}", response.body);

    server.close().await;
}

/// A valid exact-match `filter` narrows results to docs whose field matches.
#[tokio::test]
async fn search_filter_narrows_results() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;
    // Two notes share the search term but carry different `room` filter values.
    server
        .put_note_room(&token, "room-a", "common term apple", "user-ada", "lobby")
        .await;
    server
        .put_note_room(&token, "room-b", "common term apple", "user-ada", "vault")
        .await;

    // Filtering on room=vault returns only room-b (both notes are owned by the
    // querying principal, so the per-hit authz post-filter keeps both — the
    // filter alone narrows the result).
    let response = server
        .search(
            &token,
            r#"{"index":"notes","q":"apple","filter":{"room":"vault"}}"#,
        )
        .await;
    assert_eq!(response.status, 200, "body: {}", response.body);
    assert!(
        response.body.contains("room-b"),
        "filtered match present: {}",
        response.body
    );
    assert!(
        !response.body.contains("room-a"),
        "non-matching filter row absent: {}",
        response.body
    );

    server.close().await;
}

/// (b): a q over `maxSearchQueryBytes` is `invalidSearchQuery` (400).
#[tokio::test]
async fn search_rejects_oversized_query() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;

    let big_q = "x".repeat(5000); // > maxSearchQueryBytes (4096)
    let body = format!(r#"{{"index":"notes","q":"{big_q}"}}"#);
    let response = server.search(&token, &body).await;
    assert_eq!(response.status, 400, "body: {}", response.body);
    assert!(
        response.body.contains("invalidSearchQuery"),
        "body: {}",
        response.body
    );

    server.close().await;
}

/// (b): a filter with a bad key shape is rejected (`invalidSearchQuery`).
#[tokio::test]
async fn search_rejects_bad_filter_key() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;

    // Key with an illegal `$` character.
    let response = server
        .search(
            &token,
            r#"{"index":"notes","q":"alpha","filter":{"bad$key":"x"}}"#,
        )
        .await;
    assert_eq!(response.status, 400, "body: {}", response.body);
    assert!(
        response.body.contains("invalidSearchQuery"),
        "body: {}",
        response.body
    );

    // A reserved __frickSource* filter key is also rejected.
    let reserved = server
        .search(
            &token,
            r#"{"index":"notes","q":"alpha","filter":{"__frickSourceId":"x"}}"#,
        )
        .await;
    assert_eq!(reserved.status, 400, "body: {}", reserved.body);
    assert!(
        reserved.body.contains("invalidSearchQuery"),
        "body: {}",
        reserved.body
    );

    server.close().await;
}

/// An unknown index is a 404 `storage.notFound` / `searchIndexNotFound`.
#[tokio::test]
async fn search_unknown_index_is_not_found() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;
    let response = server
        .search(&token, r#"{"index":"nope","q":"alpha"}"#)
        .await;
    assert_eq!(response.status, 404, "body: {}", response.body);
    assert!(
        response.body.contains("searchIndexNotFound"),
        "body: {}",
        response.body
    );
    server.close().await;
}

/// (c): deleting an object removes it from search results.
#[tokio::test]
async fn search_delete_removes_from_results() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;
    server
        .put_note(&token, "note-del", "deletable uniqueterm", "user-ada")
        .await;

    // It is searchable first.
    let before = server
        .search(&token, r#"{"index":"notes","q":"uniqueterm"}"#)
        .await;
    assert!(before.body.contains("note-del"), "body: {}", before.body);

    // Delete it through the store (drives the projector's delete op).
    let delete = server
        .request(
            "DELETE",
            "/objects/Note/note-del",
            &[("Authorization", &bearer(&token))],
            "",
        )
        .await;
    assert_eq!(delete.status, 200, "body: {}", delete.body);

    let after = server
        .search(&token, r#"{"index":"notes","q":"uniqueterm"}"#)
        .await;
    assert_eq!(after.status, 200, "body: {}", after.body);
    assert!(
        !after.body.contains("note-del"),
        "deleted note must not appear: {}",
        after.body
    );
    assert!(after.body.contains("\"total\":0"), "body: {}", after.body);

    server.close().await;
}

/// (d): a non-owner principal is filtered from the hits (the per-hit
/// object-read baseline denies on owner mismatch), and `total` reflects the
/// visible count.
#[tokio::test]
async fn search_filters_unauthorized_principal() {
    let mut server = TestServer::boot().await;
    let ada = server.login("user-ada").await;
    let bob = server.login("user-bob").await;

    // Ada writes a note she owns.
    server
        .put_note(&ada, "ada-note", "shared keyword secret", "user-ada")
        .await;

    // Ada (the owner) sees it.
    let owner_view = server
        .search(&ada, r#"{"index":"notes","q":"keyword"}"#)
        .await;
    assert_eq!(owner_view.status, 200, "body: {}", owner_view.body);
    assert!(
        owner_view.body.contains("ada-note"),
        "owner must see her note: {}",
        owner_view.body
    );

    // Bob (a different non-admin in the same tenant) is filtered out: the
    // object's ownerId is user-ada, so the object-read baseline denies him.
    let other_view = server
        .search(&bob, r#"{"index":"notes","q":"keyword"}"#)
        .await;
    assert_eq!(other_view.status, 200, "body: {}", other_view.body);
    assert!(
        !other_view.body.contains("ada-note"),
        "non-owner must be filtered out: {}",
        other_view.body
    );
    assert!(
        other_view.body.contains("\"total\":0"),
        "non-admin total is the visible count: {}",
        other_view.body
    );

    server.close().await;
}

/// The `/_frick/inspect/search` report lists the registered index + the real
/// adapter id.
#[tokio::test]
async fn inspect_search_reports_adapter_and_indexes() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-ada").await;
    let response = server
        .request(
            "GET",
            "/_frick/inspect/search",
            &[("Authorization", &bearer(&token))],
            "",
        )
        .await;
    assert_eq!(response.status, 200, "body: {}", response.body);
    assert!(
        response.body.contains("\"adapter\":\"sqlite-fts5\""),
        "body: {}",
        response.body
    );
    assert!(
        response.body.contains("\"name\":\"notes\""),
        "body: {}",
        response.body
    );
    assert!(
        response.body.contains("\"kind\":\"object\""),
        "body: {}",
        response.body
    );

    // Keep `state` referenced so the field isn't flagged unused.
    let _ = server.state.search.index_names();
    server.close().await;
}
