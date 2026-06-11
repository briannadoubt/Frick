//! Boot-sequence integration test for the standalone `frick-server` binary
//! (ASSIGNMENT A). The binary's `main` waits on OS signals, which is awkward to
//! drive in a test, so this exercises the same path the binary takes —
//! `load_schema` + `load_frick_config` + `create_frick_server` + `listen` —
//! and proves the server answers `GET /health`, then shuts down gracefully.

use std::collections::BTreeMap;

use frick_server::standalone::load_schema;
use frick_server::{create_frick_server, load_frick_config};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn standalone_boot_path_serves_health_with_foundation_schema() {
    // No FRICK_SCHEMA_PATH → the foundation schema, exactly like the binary's
    // default.
    let schema = load_schema(&BTreeMap::new()).unwrap();
    assert_eq!(schema.schema_id, "frick-foundation");

    // The binary builds its config from the process environment; here we hand
    // it an explicit in-memory, ephemeral-port test config.
    let mut env = BTreeMap::new();
    env.insert("FRICK_ENV".to_string(), "test".to_string());
    env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
    env.insert("FRICK_PORT".to_string(), "0".to_string());
    let config = load_frick_config(&env).unwrap();

    let mut server = create_frick_server(config, schema).await.unwrap();
    let port = server.listen().await.unwrap();
    assert!(port > 0, "listen should report the bound port");

    let body = http_get(&format!("127.0.0.1:{port}"), "/health").await;
    assert!(
        body.contains("\"ok\":true"),
        "health body should report ok: {body}"
    );

    server.close().await;
}

/// `FRICK_PLATFORM_EVENTS_DRIVER=memory` boots and serves the in-process
/// platform-events pipeline; `/_frick/inspect/platform-events` reports the
/// `memory` adapter (FR-275).
#[tokio::test]
async fn boot_with_memory_platform_events_driver() {
    let schema = load_schema(&BTreeMap::new()).unwrap();
    let mut env = BTreeMap::new();
    env.insert("FRICK_ENV".to_string(), "test".to_string());
    env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
    env.insert("FRICK_PORT".to_string(), "0".to_string());
    env.insert(
        "FRICK_PLATFORM_EVENTS_DRIVER".to_string(),
        "memory".to_string(),
    );
    // The inspect surface is admin-or-session authorized; configure an admin
    // token and present it as a bearer.
    let admin_token = "0123456789012345678901234567890123";
    env.insert("FRICK_ADMIN_TOKEN".to_string(), admin_token.to_string());
    let config = load_frick_config(&env).unwrap();

    let mut server = create_frick_server(config, schema).await.unwrap();
    let port = server.listen().await.unwrap();

    let body = http_get_with_bearer(
        &format!("127.0.0.1:{port}"),
        "/_frick/inspect/platform-events",
        admin_token,
    )
    .await;
    assert!(
        body.contains("\"adapter\":\"memory\""),
        "platform-events health should report the memory adapter: {body}"
    );

    server.close().await;
}

/// `FRICK_PLATFORM_EVENTS_DRIVER=kafka` is a documented follow-up: boot fails
/// fast with a clear "not yet ported" error rather than wiring a stub adapter
/// (FR-275).
#[tokio::test]
async fn boot_with_kafka_platform_events_driver_is_not_yet_ported() {
    let schema = load_schema(&BTreeMap::new()).unwrap();
    let mut env = BTreeMap::new();
    env.insert("FRICK_ENV".to_string(), "test".to_string());
    env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
    env.insert("FRICK_PORT".to_string(), "0".to_string());
    env.insert(
        "FRICK_PLATFORM_EVENTS_DRIVER".to_string(),
        "kafka".to_string(),
    );
    env.insert(
        "FRICK_PLATFORM_EVENTS_KAFKA_BROKERS".to_string(),
        "broker:9092".to_string(),
    );
    let config = load_frick_config(&env).unwrap();

    let message = match create_frick_server(config, schema).await {
        Ok(_) => panic!("kafka driver should fail boot, not succeed"),
        Err(error) => error.to_string(),
    };
    assert!(
        message.contains("not yet ported"),
        "kafka driver should report a not-yet-ported boot error: {message}"
    );
}

/// Minimal HTTP/1.1 GET so the test pulls in no extra client dependency.
async fn http_get(host_port: &str, path: &str) -> String {
    let mut stream = tokio::net::TcpStream::connect(host_port).await.unwrap();
    let request = format!("GET {path} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    response
}

/// As [`http_get`] but with an `Authorization: Bearer <token>` header.
async fn http_get_with_bearer(host_port: &str, path: &str, token: &str) -> String {
    let mut stream = tokio::net::TcpStream::connect(host_port).await.unwrap();
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host_port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    response
}
