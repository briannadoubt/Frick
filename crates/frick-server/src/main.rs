//! The standalone `frick-server` binary.
//!
//! Boots the embeddable [`frick_server`] runtime from the process environment,
//! serves either `FRICK_SCHEMA_PATH` (an app's own schema) or the foundation
//! schema, and runs until a SIGINT/SIGTERM signal triggers a graceful
//! shutdown. All testable logic lives in [`frick_server::standalone`]; this
//! entry point only wires config + schema into the runtime and waits.

use frick_server::standalone::{config_env, load_schema};
use frick_server::{create_frick_server, load_frick_config};

#[tokio::main]
async fn main() {
    if let Err(message) = run().await {
        eprintln!("frick-server: {message}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let env = config_env();

    let config =
        load_frick_config(&env).map_err(|error| format!("invalid configuration: {error}"))?;
    let schema = load_schema(&env)?;
    let schema_id = schema.schema_id.clone();

    let mut server = create_frick_server(config, schema)
        .await
        .map_err(|error| format!("failed to construct server: {error}"))?;
    let port = server
        .listen()
        .await
        .map_err(|error| format!("failed to bind/listen: {error}"))?;

    eprintln!("frick-server listening on port {port} (schema {schema_id})");

    wait_for_shutdown().await;

    server.close().await;
    eprintln!("frick-server shut down cleanly");
    Ok(())
}

/// Resolve when either SIGINT (Ctrl-C) or SIGTERM (the container/orchestrator
/// stop signal) arrives. On non-Unix targets only Ctrl-C is awaited.
async fn wait_for_shutdown() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};

        let mut terminate = match signal(SignalKind::terminate()) {
            Ok(stream) => stream,
            Err(error) => {
                eprintln!("frick-server: failed to install SIGTERM handler: {error}");
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                if let Err(error) = result {
                    eprintln!("frick-server: failed to listen for Ctrl-C: {error}");
                }
            }
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        if let Err(error) = tokio::signal::ctrl_c().await {
            eprintln!("frick-server: failed to listen for Ctrl-C: {error}");
        }
    }
}
