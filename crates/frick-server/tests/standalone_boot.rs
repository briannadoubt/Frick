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

/// Minimal HTTP/1.1 GET so the test pulls in no extra client dependency.
async fn http_get(host_port: &str, path: &str) -> String {
    let mut stream = tokio::net::TcpStream::connect(host_port).await.unwrap();
    let request = format!("GET {path} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    response
}
