//! Server construction, listen, and graceful shutdown
//! (`createFrickServer` / `listen` / `close`, `src/server.ts`).

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use frick_protocol::FrickSchema;
use frick_store::{FrickStore, FrickStoreOptions, StoreError};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::config::{DbDriver, FrickConfig};
use crate::http::{AppState, AppStateInner, public_router};

/// A running (or constructed-but-not-yet-listening) server.
pub struct FrickServer {
    pub state: AppState,
    pub config: FrickConfig,
    shutdown: Option<oneshot::Sender<()>>,
    join: Option<tokio::task::JoinHandle<()>>,
    bound_port: u16,
}

/// Construction failure.
#[derive(Debug, thiserror::Error)]
pub enum BootError {
    #[error("{0}")]
    Config(#[from] crate::config::FrickConfigError),
    #[error("{0}")]
    Store(#[from] StoreError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// Build a server from config + schema (`createFrickServer`). The store is
/// opened and migrated here; call [`FrickServer::listen`] to bind the socket.
pub async fn create_frick_server(
    config: FrickConfig,
    schema: FrickSchema,
) -> Result<FrickServer, BootError> {
    if config.db_driver == DbDriver::Postgres {
        return Err(BootError::Store(StoreError::store(
            "the Postgres driver is not yet ported (FR-242)",
        )));
    }

    let options = FrickStoreOptions {
        path: config.db_path.clone(),
        schema: Some(schema.clone()),
        idempotency_replay_window_ms: Some(config.idempotency_replay_window_ms),
        idempotency_key_retention_ms: Some(config.idempotency_key_retention_ms),
        ..FrickStoreOptions::default()
    };
    let store = FrickStore::open(options).await?;

    let state = Arc::new(AppStateInner {
        config: config.clone(),
        store,
        schema,
        started_at: now_iso(),
    });

    Ok(FrickServer {
        state,
        config,
        shutdown: None,
        join: None,
        bound_port: 0,
    })
}

impl FrickServer {
    /// Bind the socket and start serving in the background
    /// (`listen`). Returns the bound port (useful when `port == 0`).
    pub async fn listen(&mut self) -> Result<u16, BootError> {
        let address = format!("{}:{}", self.config.host, self.config.port);
        let listener = TcpListener::bind(&address).await?;
        let bound_port = listener.local_addr()?.port();
        self.bound_port = bound_port;

        let router = public_router(Arc::clone(&self.state));
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        self.shutdown = Some(shutdown_tx);

        let join = tokio::spawn(async move {
            let server = axum::serve(listener, router);
            let graceful = server.with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            });
            if let Err(error) = graceful.await {
                tracing::error!(target: "frick.server", %error, "serve loop failed");
            }
        });
        self.join = Some(join);

        tracing::info!(
            target: "frick.server",
            schema_id = %self.state.schema.schema_id,
            schema_revision = self.state.schema.schema_revision,
            host = %self.config.host,
            port = bound_port,
            env = %self.config.env.as_str(),
            "frick.server.listen"
        );
        Ok(bound_port)
    }

    /// The port the server is bound to (0 before [`Self::listen`]).
    #[must_use]
    pub fn port(&self) -> u16 {
        self.bound_port
    }

    /// The base HTTP URL.
    #[must_use]
    pub fn http_url(&self) -> String {
        format!("http://{}:{}", self.config.host, self.bound_port)
    }

    /// Graceful shutdown (`close`): signal the serve loop and await it.
    /// Idempotent.
    pub async fn close(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(join) = self.join.take() {
            let _ = join.await;
        }
        tracing::info!(target: "frick.server", "frick.server.closed");
    }
}

/// Current time as an ISO-8601 UTC millisecond string (`Date.toISOString`
/// format). Used only for the `startedAt` log/inspection field.
fn now_iso() -> String {
    let total_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
    let (days, ms_of_day) = (
        total_ms.div_euclid(86_400_000),
        total_ms.rem_euclid(86_400_000),
    );
    let (year, month, day) = civil_from_days(days);
    let (hour, minute) = (ms_of_day / 3_600_000, (ms_of_day / 60_000) % 60);
    let (second, milli) = ((ms_of_day / 1_000) % 60, ms_of_day % 1_000);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z")
}

/// Days since 1970-01-01 → (year, month, day). Howard Hinnant's algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = u32::try_from(doy - (153 * mp + 2) / 5 + 1).unwrap_or(1);
    let month = u32::try_from(if mp < 10 { mp + 3 } else { mp - 9 }).unwrap_or(1);
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::load_frick_config;
    use std::collections::BTreeMap;

    fn test_config() -> FrickConfig {
        let mut env = BTreeMap::new();
        env.insert("FRICK_ENV".to_string(), "test".to_string());
        env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
        env.insert("FRICK_PORT".to_string(), "0".to_string());
        load_frick_config(&env).unwrap()
    }

    #[tokio::test]
    async fn server_boots_listens_and_serves_health() {
        let schema = frick_protocol::foundation_schema();
        let mut server = create_frick_server(test_config(), schema).await.unwrap();
        let port = server.listen().await.unwrap();
        assert!(port > 0);

        let body = reqwest_get(&format!("http://127.0.0.1:{port}/health")).await;
        assert!(body.contains("\"ok\":true"), "health body was {body}");

        let ready = reqwest_get(&format!("http://127.0.0.1:{port}/ready")).await;
        assert!(
            ready.contains("\"status\":\"ready\""),
            "ready body was {ready}"
        );

        server.close().await;
    }

    #[tokio::test]
    async fn postgres_driver_is_rejected() {
        let mut env = BTreeMap::new();
        env.insert("FRICK_DB_DRIVER".to_string(), "postgres".to_string());
        env.insert("FRICK_DATABASE_URL".to_string(), "postgres://x".to_string());
        let config = load_frick_config(&env).unwrap();
        let result = create_frick_server(config, frick_protocol::foundation_schema()).await;
        let Err(err) = result else {
            panic!("expected the Postgres driver to be rejected")
        };
        assert!(err.to_string().contains("FR-242"));
    }

    /// Minimal blocking HTTP GET (avoids pulling a full client dep into tests).
    async fn reqwest_get(url: &str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let url = url.strip_prefix("http://").unwrap();
        let (host_port, path) = url.split_once('/').map_or((url, ""), |(h, p)| (h, p));
        let mut stream = tokio::net::TcpStream::connect(host_port).await.unwrap();
        let request =
            format!("GET /{path} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }
}
