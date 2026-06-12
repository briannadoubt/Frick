//! Shared context: turn `--db-path`/`--env` flags into a loaded
//! [`FrickConfig`] and (optionally) an opened [`FrickStore`].
//!
//! Ported from `apps/cli/src/context.ts`. The Rust `load_frick_config` reads an
//! [`EnvSource`] rather than an overrides bag, so the CLI flags are layered as
//! `FRICK_DB_PATH` / `FRICK_ENV` over the real process environment — preserving
//! the TS precedence CLI flags > env vars > defaults. Invalid `--env` values are
//! silently ignored (TS `context.ts:18-19`).

use frick_server::config::{EnvSource, ProcessEnv};
use frick_server::{FrickConfig, load_frick_config};
use frick_store::{FrickStore, FrickStoreOptions};

use crate::argv::ParsedArgs;
use crate::errors::CliError;

/// The resolved `--db-path` / `--env` overrides.
#[derive(Debug, Clone, Default)]
pub struct ContextFlags {
    /// `--db-path` override (`FRICK_DB_PATH`).
    pub db_path: Option<String>,
    /// `--env` override (`FRICK_ENV`), already validated. Invalid values are
    /// dropped silently, matching the TS behavior.
    pub env: Option<String>,
}

/// Extract the shared context flags. An invalid `--env` is silently ignored.
#[must_use]
pub fn context_flags_from(parsed: &ParsedArgs) -> ContextFlags {
    let db_path = parsed.flag_str("db-path").map(ToString::to_string);
    let env = parsed.flag_str("env").and_then(|value| {
        if value == "development" || value == "test" || value == "production" {
            Some(value.to_string())
        } else {
            None
        }
    });
    ContextFlags { db_path, env }
}

/// An [`EnvSource`] that layers a small set of CLI-derived overrides on top of
/// the real process environment, so `load_frick_config` honours CLI > env >
/// defaults.
struct OverlayEnv {
    base: ProcessEnv,
    db_path: Option<String>,
    env: Option<String>,
}

impl EnvSource for OverlayEnv {
    fn get(&self, key: &str) -> Option<String> {
        match key {
            "FRICK_DB_PATH" if self.db_path.is_some() => self.db_path.clone(),
            "FRICK_ENV" if self.env.is_some() => self.env.clone(),
            _ => self.base.get(key),
        }
    }
}

/// Load config with the same precedence as the server (`loadConfig` in TS).
/// A config parse error surfaces as a `cli.config` failure (exit 1) — the TS
/// `loadFrickConfig` throw is caught by the top-level handler the same way.
pub fn load_config(ctx: &ContextFlags) -> Result<FrickConfig, CliError> {
    let overlay = OverlayEnv {
        base: ProcessEnv,
        db_path: ctx.db_path.clone(),
        env: ctx.env.clone(),
    };
    load_frick_config(&overlay).map_err(|err| CliError::failure("cli.config", err.0))
}

/// Open a store against the configured DB. The store opens with `seed: false`
/// and `idempotency_key_prune_interval_ms: 0` — the CLI must never mutate a DB
/// it was asked to read (`openStore` in TS).
pub async fn open_store(config: &FrickConfig) -> Result<FrickStore, CliError> {
    let options = FrickStoreOptions {
        path: config.db_path.clone(),
        seed: false,
        idempotency_key_prune_interval_ms: Some(0),
        ..FrickStoreOptions::default()
    };
    FrickStore::open(options)
        .await
        .map_err(|err| CliError::failure("cli.store", err.to_string()))
}
