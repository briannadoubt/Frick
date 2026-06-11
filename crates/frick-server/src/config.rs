//! Server configuration (`apps/server/src/config.ts` + `src/limits.ts`).
//!
//! [`load_frick_config`] reads an environment source then layers explicit
//! overrides on top (overrides win). Every parse helper treats both an absent
//! variable and an empty string as unset, matching the TS helpers. Invalid
//! values raise [`FrickConfigError`] at load time — the same failure mode as
//! the TS `FrickConfigError`.

use std::collections::BTreeMap;

/// Configuration load failure (`FrickConfigError` in TS). The message text
/// mirrors the TS messages so operators see identical diagnostics.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct FrickConfigError(pub String);

impl FrickConfigError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

type Result<T> = std::result::Result<T, FrickConfigError>;

/// Deployment environment (`FRICK_ENV`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrickEnv {
    Development,
    Test,
    Production,
}

impl FrickEnv {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Development => "development",
            Self::Test => "test",
            Self::Production => "production",
        }
    }

    #[must_use]
    pub fn is_production(self) -> bool {
        matches!(self, Self::Production)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DbDriver {
    Sqlite,
    Postgres,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlobDriver {
    Sqlite,
    Filesystem,
    S3,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordHasher {
    Argon2,
    Scrypt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

/// Selected platform-events pipeline backend (`FRICK_PLATFORM_EVENTS_DRIVER`,
/// FR-275). `Memory` (in-process, default for tests/dev) and `Sqlite` (durable,
/// over the migrated `platform_events` tables) are ported; `Kafka` is a
/// documented follow-up — the boot wiring returns a clean "not yet ported" error
/// for it rather than a stub adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformEventsDriver {
    Memory,
    Sqlite,
    Kafka,
}

impl PlatformEventsDriver {
    /// The wire/log label.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Memory => "memory",
            Self::Sqlite => "sqlite",
            Self::Kafka => "kafka",
        }
    }
}

/// Outbound-email provider (`FRICK_EMAIL_PROVIDER`, FR-271). `Noop` is the
/// default: `forgot-password` still returns 200 but no message leaves the
/// process (the [`crate::email::NoopEmailAdapter`] logs + succeeds). `Resend`
/// selects the live [`crate::email::ResendEmailAdapter`] — it additionally
/// requires `FRICK_RESEND_API_KEY` and `FRICK_EMAIL_FROM`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmailProvider {
    Noop,
    Resend,
}

impl EmailProvider {
    /// The wire/log label.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Noop => "noop",
            Self::Resend => "resend",
        }
    }
}

/// An origin-allowlist entry (`FRICK_ALLOWED_ORIGINS`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AllowedOrigin {
    /// `*` — matches every origin.
    Any,
    /// An exact `scheme://host[:port]` origin.
    Exact {
        scheme: String,
        host: String,
        port: Option<u16>,
    },
    /// `scheme://*.suffix` — single leading-label wildcard. Matches when
    /// scheme and port match exactly and the hostname ends with
    /// `.<suffix_host>` with at least one extra label (the apex never matches).
    Wildcard {
        scheme: String,
        suffix_host: String,
        port: Option<u16>,
    },
}

impl AllowedOrigin {
    /// `originMatchesAllowlistEntry` (`config.ts:808-849`).
    #[must_use]
    pub fn matches(&self, scheme: &str, host: &str, port: Option<u16>) -> bool {
        match self {
            Self::Any => true,
            Self::Exact {
                scheme: s,
                host: h,
                port: p,
            } => s == scheme && h.eq_ignore_ascii_case(host) && *p == port,
            Self::Wildcard {
                scheme: s,
                suffix_host,
                port: p,
            } => {
                if s != scheme || *p != port {
                    return false;
                }
                let host = host.to_ascii_lowercase();
                let suffix = format!(".{}", suffix_host.to_ascii_lowercase());
                host.ends_with(&suffix) && host.len() > suffix.len()
            }
        }
    }
}

/// One generic-OIDC provider an app plugs in via `FRICK_OIDC_PROVIDERS`
/// (FR-270). Ported from the deleted TS `OidcProviderConfig` (`auth/oidc.ts`).
///
/// Where Apple/Google hard-wire a single issuer + JWKS URL, this is
/// config-driven: an app declares one or more standards-compliant OIDC issuers
/// (Okta, Auth0, Microsoft Entra, Keycloak, …) keyed by a stable, URL-safe
/// `id`, and Frick verifies the supplied `id_token` against that provider's
/// published JWKS exactly the way the Google path does. The `:id` segment of
/// `POST /auth/oidc/:id/verify` selects the provider; an unknown id is a 404 so
/// a token is NEVER accepted for an unconfigured provider.
///
/// SAML is intentionally out of scope for FR-270 (tracked separately); only the
/// OIDC half is modeled here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OidcProviderConfig {
    /// App-chosen stable id used in the route (`/auth/oidc/:id/verify`) and to
    /// scope the account handle (`oidc:<id>:<sub>`). Unique within the registry.
    pub id: String,
    /// Expected `iss` claim, e.g. `https://example.okta.com`. The verified
    /// id-token's `iss` must equal this exactly.
    pub issuer: String,
    /// The expected `aud` value(s) — the OAuth client id(s) registered with the
    /// provider. The id-token's `aud` must match one of these. Never empty.
    pub audiences: Vec<String>,
    /// The provider's JWKS endpoint, resolved through the [`JwksProvider`] seam.
    ///
    /// [`JwksProvider`]: crate::auth::jwks::JwksProvider
    pub jwks_uri: String,
}

/// Operational limits (`FrickLimits`, `src/limits.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrickLimits {
    pub max_http_body_bytes: i64,
    pub max_stream_append_payload_bytes: i64,
    pub max_blob_bytes: i64,
    pub max_subscriptions_per_connection: i64,
    pub max_stream_page_size: i64,
    pub max_search_query_bytes: i64,
    pub max_search_filter_fields: i64,
    pub max_search_filter_key_bytes: i64,
    pub max_search_filter_value_bytes: i64,
    pub max_pending_appends_per_client: i64,
    pub max_web_socket_frame_bytes: i64,
    pub max_web_socket_connections: i64,
    pub max_connections_per_principal: i64,
    pub max_web_socket_outbound_buffered_bytes: i64,
    pub max_sse_connections: i64,
    pub max_sse_outbound_buffered_bytes: i64,
    pub max_blob_bytes_per_principal: i64,
    pub max_auth_attempts_per_window: i64,
    pub auth_rate_limit_window_ms: i64,
    pub presence_ttl_min_seconds: i64,
    pub presence_ttl_max_seconds: i64,
    pub signal_ttl_min_seconds: i64,
    pub signal_ttl_max_seconds: i64,
    pub heartbeat_interval_seconds: i64,
    pub heartbeat_timeout_seconds: i64,
    pub bind_session_device: bool,
}

impl Default for FrickLimits {
    /// `src/limits.ts:88-118`.
    fn default() -> Self {
        Self {
            max_http_body_bytes: 5_000_000,
            max_stream_append_payload_bytes: 256_000,
            max_blob_bytes: 25_000_000,
            max_subscriptions_per_connection: 256,
            max_stream_page_size: 500,
            max_search_query_bytes: 4_096,
            max_search_filter_fields: 16,
            max_search_filter_key_bytes: 128,
            max_search_filter_value_bytes: 512,
            max_pending_appends_per_client: 1_000,
            max_web_socket_frame_bytes: 524_288,
            max_web_socket_connections: 10_000,
            max_connections_per_principal: 64,
            max_web_socket_outbound_buffered_bytes: 1_048_576,
            max_sse_connections: 10_000,
            max_sse_outbound_buffered_bytes: 1_048_576,
            // `Number.MAX_SAFE_INTEGER` — effectively unlimited.
            max_blob_bytes_per_principal: 9_007_199_254_740_991,
            max_auth_attempts_per_window: 30,
            auth_rate_limit_window_ms: 300_000,
            presence_ttl_min_seconds: 5,
            presence_ttl_max_seconds: 600,
            signal_ttl_min_seconds: 1,
            signal_ttl_max_seconds: 120,
            heartbeat_interval_seconds: 25,
            heartbeat_timeout_seconds: 60,
            bind_session_device: false,
        }
    }
}

/// The fully-resolved server configuration (`FrickConfig` in TS).
#[derive(Debug, Clone, PartialEq)]
pub struct FrickConfig {
    pub env: FrickEnv,
    pub demo_auth_enabled: bool,
    pub session_ttl_seconds: f64,
    pub host: String,
    pub port: u16,
    pub public_url: Option<String>,
    pub allowed_origins: Vec<AllowedOrigin>,
    pub db_driver: DbDriver,
    pub db_path: String,
    pub database_url: Option<String>,
    pub blob_driver: BlobDriver,
    pub password_hasher: PasswordHasher,
    pub blob_storage_path: String,
    pub blob_s3_bucket: Option<String>,
    pub blob_s3_region: Option<String>,
    pub blob_s3_endpoint: Option<String>,
    pub blob_s3_prefix: Option<String>,
    /// Force path-style S3 addressing (`FRICK_BLOB_S3_FORCE_PATH_STYLE`,
    /// FR-273). `None` ⇒ the driver defaults it from the endpoint presence
    /// (path-style when a custom endpoint is set, virtual-hosted otherwise).
    pub blob_s3_force_path_style: Option<bool>,
    pub log_level: LogLevel,
    pub inspection_enabled: bool,
    pub admin_token: Option<String>,
    pub implicit_tenant_creation: bool,
    pub platform_events_driver: PlatformEventsDriver,
    pub platform_events_topic: String,
    pub platform_events_kafka_brokers: Vec<String>,
    pub platform_events_retention_ms: i64,
    pub platform_events_max_rows: i64,
    pub idempotency_replay_window_ms: i64,
    pub idempotency_key_retention_ms: i64,
    pub devtools_events_retention_ms: i64,
    pub expired_session_retention_grace_ms: i64,
    /// Sign in with Apple audience(s) (FR-269): the iOS bundle id(s) and/or
    /// Services id(s) the verified id-token's `aud` must match. From
    /// `FRICK_APPLE_AUDIENCES` (comma list). Empty ⇒ the `/auth/apple/*` routes
    /// answer "provider not configured" rather than accepting unaudienced
    /// tokens.
    pub apple_audiences: Vec<String>,
    /// Sign in with Google audience(s) (FR-269): the OAuth client id(s) the
    /// verified id-token's `aud` must match. From `FRICK_GOOGLE_CLIENT_IDS`
    /// (comma list). Empty ⇒ the `/auth/google/verify` route answers "provider
    /// not configured".
    pub google_client_ids: Vec<String>,
    /// Generic OIDC providers (FR-270), keyed by `id`, from
    /// `FRICK_OIDC_PROVIDERS` (a JSON array). Each entry pins one issuer +
    /// audience(s) + JWKS endpoint for `POST /auth/oidc/:id/verify`. Empty ⇒
    /// every `/auth/oidc/:id/verify` answers "provider not configured" (404).
    pub oidc_providers: Vec<OidcProviderConfig>,
    /// Outbound-email provider (FR-271), from `FRICK_EMAIL_PROVIDER`
    /// (`noop` | `resend`). Defaults to [`EmailProvider::Noop`]; an unconfigured
    /// deployment stays Noop, so `forgot-password` still returns 200 without
    /// sending. `resend` additionally requires `resend_api_key` + `email_from`.
    pub email_provider: EmailProvider,
    /// The Resend API key (`FRICK_RESEND_API_KEY`, FR-271) — the
    /// `Authorization: Bearer <key>` credential. Required when
    /// `email_provider == Resend`; `None` otherwise.
    pub resend_api_key: Option<String>,
    /// The default `from:` address for framework auth emails
    /// (`FRICK_EMAIL_FROM`, FR-271). Required when `email_provider == Resend`;
    /// also used as the [`crate::email::EmailRouter`] `default_from`.
    pub email_from: Option<String>,
    pub limits: FrickLimits,
}

impl FrickConfig {
    /// `adminEnabled = !!adminToken`.
    #[must_use]
    pub fn admin_enabled(&self) -> bool {
        self.admin_token.is_some()
    }

    /// Look up a configured OIDC provider by its `id` (FR-270). `None` ⇒ the
    /// route returns 404 `providerNotConfigured` rather than accepting a token.
    #[must_use]
    pub fn oidc_provider(&self, id: &str) -> Option<&OidcProviderConfig> {
        self.oidc_providers.iter().find(|p| p.id == id)
    }
}

/// An environment source. The real server reads `std::env`; tests pass a map.
pub trait EnvSource {
    fn get(&self, key: &str) -> Option<String>;
}

/// Reads from the process environment.
pub struct ProcessEnv;

impl EnvSource for ProcessEnv {
    fn get(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }
}

impl EnvSource for BTreeMap<String, String> {
    fn get(&self, key: &str) -> Option<String> {
        BTreeMap::get(self, key).cloned()
    }
}

/// Treats absent and empty-after-trim as unset, like the TS `parse*` helpers.
fn read(env: &dyn EnvSource, key: &str) -> Option<String> {
    env.get(key).filter(|value| !value.trim().is_empty())
}

/// `parseBoolean` (`config.ts:561-575`): case-insensitive `true/1/yes` and
/// `false/0/no`; anything else throws.
fn parse_boolean(env: &dyn EnvSource, key: &str) -> Result<Option<bool>> {
    let Some(raw) = read(env, key) else {
        return Ok(None);
    };
    match raw.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" => Ok(Some(true)),
        "false" | "0" | "no" => Ok(Some(false)),
        _ => Err(FrickConfigError::new(format!(
            "Invalid boolean for {key}: \"{raw}\" (expected true/false/1/0/yes/no)"
        ))),
    }
}

fn parse_integer(env: &dyn EnvSource, key: &str) -> Result<Option<i64>> {
    let Some(raw) = read(env, key) else {
        return Ok(None);
    };
    raw.trim()
        .parse::<i64>()
        .map(Some)
        .map_err(|_| FrickConfigError::new(format!("Invalid integer for {key}: \"{raw}\"")))
}

fn parse_positive_integer(env: &dyn EnvSource, key: &str) -> Result<Option<i64>> {
    match parse_integer(env, key)? {
        Some(value) if value > 0 => Ok(Some(value)),
        Some(_) => Err(FrickConfigError::new(format!(
            "Invalid positive integer for {key}"
        ))),
        None => Ok(None),
    }
}

fn parse_non_negative_integer(env: &dyn EnvSource, key: &str) -> Result<Option<i64>> {
    match parse_integer(env, key)? {
        Some(value) if value >= 0 => Ok(Some(value)),
        Some(_) => Err(FrickConfigError::new(format!(
            "Invalid non-negative integer for {key}"
        ))),
        None => Ok(None),
    }
}

fn parse_comma_list(env: &dyn EnvSource, key: &str) -> Vec<String> {
    read(env, key)
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Parse the OIDC provider registry from `FRICK_OIDC_PROVIDERS` (FR-270).
///
/// The value is a JSON array of objects. Each object is:
/// ```json
/// [
///   {
///     "id": "okta",
///     "issuer": "https://example.okta.com",
///     "audiences": ["0oa1b2c3client"],
///     "jwksUri": "https://example.okta.com/oauth2/v1/keys"
///   }
/// ]
/// ```
/// A single string `audience` is also accepted as shorthand for a one-element
/// `audiences`. Absent/empty ⇒ no providers (every `/auth/oidc/:id/verify`
/// answers 404). Every field is required and non-empty; the `id`s must be
/// unique. Any structural error is fatal at load time — the same failure mode
/// the TS used when `identityProviders.oidc` had a duplicate/invalid entry.
/// `aud` shorthand in `FRICK_OIDC_PROVIDERS`: a single string OR an array of
/// strings.
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum AudiencesField {
    One(String),
    Many(Vec<String>),
}

/// The raw JSON shape of one `FRICK_OIDC_PROVIDERS` entry, before validation.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawOidcProvider {
    id: String,
    issuer: String,
    #[serde(default)]
    audience: Option<AudiencesField>,
    #[serde(default)]
    audiences: Option<AudiencesField>,
    jwks_uri: String,
}

fn parse_oidc_providers(env: &dyn EnvSource) -> Result<Vec<OidcProviderConfig>> {
    let Some(raw) = read(env, "FRICK_OIDC_PROVIDERS") else {
        return Ok(Vec::new());
    };

    let parsed: Vec<RawOidcProvider> = serde_json::from_str(&raw).map_err(|err| {
        FrickConfigError::new(format!(
            "Invalid FRICK_OIDC_PROVIDERS: expected a JSON array of {{id, issuer, audiences, jwksUri}}: {err}"
        ))
    })?;

    let mut providers = Vec::with_capacity(parsed.len());
    let mut seen_ids = std::collections::BTreeSet::new();
    for raw in parsed {
        let id = raw.id.trim().to_string();
        if id.is_empty() {
            return Err(FrickConfigError::new(
                "FRICK_OIDC_PROVIDERS entry has an empty \"id\"",
            ));
        }
        if !seen_ids.insert(id.clone()) {
            return Err(FrickConfigError::new(format!(
                "FRICK_OIDC_PROVIDERS has a duplicate provider id \"{id}\""
            )));
        }
        let issuer = raw.issuer.trim().to_string();
        if issuer.is_empty() {
            return Err(FrickConfigError::new(format!(
                "FRICK_OIDC_PROVIDERS provider \"{id}\" has an empty \"issuer\""
            )));
        }
        let jwks_uri = raw.jwks_uri.trim().to_string();
        if jwks_uri.is_empty() {
            return Err(FrickConfigError::new(format!(
                "FRICK_OIDC_PROVIDERS provider \"{id}\" has an empty \"jwksUri\""
            )));
        }
        // `audiences` wins; `audience` is the single-value shorthand. At least
        // one non-empty audience is required so a token's `aud` always has
        // something to match — we never accept an unaudienced OIDC token.
        let audiences: Vec<String> = match (raw.audiences, raw.audience) {
            (Some(field), _) | (None, Some(field)) => match field {
                AudiencesField::One(value) => vec![value],
                AudiencesField::Many(values) => values,
            },
            (None, None) => Vec::new(),
        }
        .into_iter()
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty())
        .collect();
        if audiences.is_empty() {
            return Err(FrickConfigError::new(format!(
                "FRICK_OIDC_PROVIDERS provider \"{id}\" needs at least one audience"
            )));
        }

        providers.push(OidcProviderConfig {
            id,
            issuer,
            audiences,
            jwks_uri,
        });
    }
    Ok(providers)
}

/// Parse one allowlist entry (`config.ts:721-800`). `*` is the wildcard-all;
/// every other entry must be a URL with a non-empty host and no
/// path/query/fragment/credentials.
fn parse_allowed_origin(entry: &str) -> Result<AllowedOrigin> {
    if entry == "*" {
        return Ok(AllowedOrigin::Any);
    }

    let invalid = || FrickConfigError::new(format!("Invalid allowed origin: \"{entry}\""));

    let (scheme, rest) = entry.split_once("://").ok_or_else(invalid)?;
    if scheme.is_empty() || rest.is_empty() {
        return Err(invalid());
    }
    // No path / query / fragment / credentials.
    if rest.contains(['/', '?', '#', '@']) {
        return Err(invalid());
    }

    let (host_part, port) = match rest.rsplit_once(':') {
        Some((host, port_text)) => {
            let port = port_text.parse::<u16>().map_err(|_| invalid())?;
            (host, Some(port))
        }
        None => (rest, None),
    };
    if host_part.is_empty() {
        return Err(invalid());
    }

    if let Some(suffix) = host_part.strip_prefix("*.") {
        if suffix.is_empty() || suffix.contains('*') {
            return Err(invalid());
        }
        Ok(AllowedOrigin::Wildcard {
            scheme: scheme.to_string(),
            suffix_host: suffix.to_string(),
            port,
        })
    } else if host_part.contains('*') {
        Err(invalid())
    } else {
        Ok(AllowedOrigin::Exact {
            scheme: scheme.to_string(),
            host: host_part.to_string(),
            port,
        })
    }
}

/// Load configuration from an [`EnvSource`]. Mirrors `loadFrickConfig`; pass
/// [`ProcessEnv`] in the binary, a map in tests.
#[allow(clippy::too_many_lines)]
pub fn load_frick_config(env: &dyn EnvSource) -> Result<FrickConfig> {
    let frick_env = match read(env, "FRICK_ENV").as_deref() {
        None | Some("development") => FrickEnv::Development,
        Some("test") => FrickEnv::Test,
        Some("production") => FrickEnv::Production,
        Some(other) => {
            return Err(FrickConfigError::new(format!(
                "Invalid FRICK_ENV: \"{other}\" (expected development/test/production)"
            )));
        }
    };
    let production = frick_env.is_production();

    let demo_auth_enabled = parse_boolean(env, "FRICK_DEMO_AUTH_ENABLED")?.unwrap_or(!production);

    let session_ttl_seconds = match read(env, "FRICK_SESSION_TTL_SECONDS") {
        Some(raw) => raw
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite())
            .ok_or_else(|| {
                FrickConfigError::new(format!("Invalid FRICK_SESSION_TTL_SECONDS: \"{raw}\""))
            })?,
        None => 604_800.0,
    };

    let host = read(env, "FRICK_HOST").unwrap_or_else(|| {
        if production {
            "0.0.0.0".into()
        } else {
            "127.0.0.1".into()
        }
    });

    let port = match parse_integer(env, "FRICK_PORT")?.or(parse_integer(env, "PORT")?) {
        Some(value) if (0..=65535).contains(&value) => u16::try_from(value).unwrap_or(4099),
        Some(_) => return Err(FrickConfigError::new("FRICK_PORT must be in [0, 65535]")),
        None => 4099,
    };

    let allowed_origins = {
        let entries = parse_comma_list(env, "FRICK_ALLOWED_ORIGINS");
        if entries.is_empty() {
            if production {
                vec![]
            } else {
                vec![AllowedOrigin::Any]
            }
        } else {
            entries
                .iter()
                .map(|entry| parse_allowed_origin(entry))
                .collect::<Result<_>>()?
        }
    };

    let db_driver = match read(env, "FRICK_DB_DRIVER").as_deref() {
        None | Some("sqlite") => DbDriver::Sqlite,
        Some("postgres") => DbDriver::Postgres,
        Some(other) => {
            return Err(FrickConfigError::new(format!(
                "Invalid FRICK_DB_DRIVER: \"{other}\""
            )));
        }
    };

    let blob_driver = match read(env, "FRICK_BLOB_DRIVER").as_deref() {
        None | Some("sqlite") => BlobDriver::Sqlite,
        Some("filesystem") => BlobDriver::Filesystem,
        Some("s3") => BlobDriver::S3,
        Some(other) => {
            return Err(FrickConfigError::new(format!(
                "Invalid FRICK_BLOB_DRIVER: \"{other}\""
            )));
        }
    };

    let password_hasher = match read(env, "FRICK_PASSWORD_HASHER").as_deref() {
        None | Some("argon2") => PasswordHasher::Argon2,
        Some("scrypt") => PasswordHasher::Scrypt,
        Some(other) => {
            return Err(FrickConfigError::new(format!(
                "Invalid FRICK_PASSWORD_HASHER: \"{other}\""
            )));
        }
    };

    let log_level = match read(env, "FRICK_LOG_LEVEL").as_deref() {
        None | Some("info") => LogLevel::Info,
        Some("debug") => LogLevel::Debug,
        Some("warn") => LogLevel::Warn,
        Some("error") => LogLevel::Error,
        Some(other) => {
            return Err(FrickConfigError::new(format!(
                "Invalid FRICK_LOG_LEVEL: \"{other}\""
            )));
        }
    };

    let platform_events_kafka_brokers =
        parse_comma_list(env, "FRICK_PLATFORM_EVENTS_KAFKA_BROKERS");
    let platform_events_driver = match read(env, "FRICK_PLATFORM_EVENTS_DRIVER").as_deref() {
        Some("memory") => PlatformEventsDriver::Memory,
        Some("sqlite") => PlatformEventsDriver::Sqlite,
        Some("kafka") => PlatformEventsDriver::Kafka,
        Some(other) => {
            return Err(FrickConfigError::new(format!(
                "FRICK_PLATFORM_EVENTS_DRIVER must be one of memory, sqlite, kafka (got \"{other}\")"
            )));
        }
        None => {
            if platform_events_kafka_brokers.is_empty() {
                PlatformEventsDriver::Sqlite
            } else {
                PlatformEventsDriver::Kafka
            }
        }
    };

    let admin_token = read(env, "FRICK_ADMIN_TOKEN");

    let email_provider = match read(env, "FRICK_EMAIL_PROVIDER").as_deref() {
        None | Some("noop") => EmailProvider::Noop,
        Some("resend") => EmailProvider::Resend,
        Some(other) => {
            return Err(FrickConfigError::new(format!(
                "Invalid FRICK_EMAIL_PROVIDER: \"{other}\" (expected noop/resend)"
            )));
        }
    };

    let config = FrickConfig {
        env: frick_env,
        demo_auth_enabled,
        session_ttl_seconds,
        host,
        port,
        public_url: read(env, "FRICK_PUBLIC_URL"),
        allowed_origins,
        db_driver,
        db_path: read(env, "FRICK_DB_PATH").unwrap_or_else(|| "./frick.sqlite".into()),
        database_url: read(env, "FRICK_DATABASE_URL"),
        blob_driver,
        password_hasher,
        blob_storage_path: read(env, "FRICK_BLOB_STORAGE_PATH")
            .unwrap_or_else(|| "./frick-blobs/".into()),
        blob_s3_bucket: read(env, "FRICK_BLOB_S3_BUCKET"),
        blob_s3_region: read(env, "FRICK_BLOB_S3_REGION"),
        blob_s3_endpoint: read(env, "FRICK_BLOB_S3_ENDPOINT"),
        blob_s3_prefix: read(env, "FRICK_BLOB_S3_PREFIX"),
        blob_s3_force_path_style: parse_boolean(env, "FRICK_BLOB_S3_FORCE_PATH_STYLE")?,
        log_level,
        inspection_enabled: parse_boolean(env, "FRICK_INSPECTION_ENABLED")?.unwrap_or(!production),
        admin_token,
        implicit_tenant_creation: parse_boolean(env, "FRICK_IMPLICIT_TENANT_CREATION")?
            .unwrap_or(!production),
        platform_events_driver,
        platform_events_topic: read(env, "FRICK_PLATFORM_EVENTS_TOPIC")
            .unwrap_or_else(|| "frick.platform.events".into()),
        platform_events_kafka_brokers,
        platform_events_retention_ms: parse_positive_integer(
            env,
            "FRICK_PLATFORM_EVENTS_RETENTION_MS",
        )?
        .unwrap_or(604_800_000),
        platform_events_max_rows: parse_positive_integer(env, "FRICK_PLATFORM_EVENTS_MAX_ROWS")?
            .unwrap_or(1_000_000),
        idempotency_replay_window_ms: parse_positive_integer(
            env,
            "FRICK_IDEMPOTENCY_REPLAY_WINDOW_MS",
        )?
        .unwrap_or(86_400_000),
        idempotency_key_retention_ms: parse_positive_integer(
            env,
            "FRICK_IDEMPOTENCY_KEY_RETENTION_MS",
        )?
        .unwrap_or(86_400_000),
        devtools_events_retention_ms: parse_positive_integer(
            env,
            "FRICK_DEVTOOLS_EVENTS_RETENTION_MS",
        )?
        .unwrap_or(3_600_000),
        expired_session_retention_grace_ms: parse_non_negative_integer(
            env,
            "FRICK_EXPIRED_SESSION_RETENTION_GRACE_MS",
        )?
        .unwrap_or(0),
        apple_audiences: parse_comma_list(env, "FRICK_APPLE_AUDIENCES"),
        google_client_ids: parse_comma_list(env, "FRICK_GOOGLE_CLIENT_IDS"),
        oidc_providers: parse_oidc_providers(env)?,
        email_provider,
        resend_api_key: read(env, "FRICK_RESEND_API_KEY"),
        email_from: read(env, "FRICK_EMAIL_FROM"),
        limits: load_limits(env)?,
    };

    validate_cross_field(&config)?;
    Ok(config)
}

fn load_limits(env: &dyn EnvSource) -> Result<FrickLimits> {
    let mut limits = FrickLimits::default();
    if let Some(value) = parse_positive_integer(env, "FRICK_MAX_CONNECTIONS_PER_PRINCIPAL")? {
        limits.max_connections_per_principal = value;
    }
    if let Some(value) = parse_positive_integer(env, "FRICK_MAX_BLOB_BYTES_PER_PRINCIPAL")? {
        limits.max_blob_bytes_per_principal = value;
    }
    if let Some(value) = parse_boolean(env, "FRICK_BIND_SESSION_DEVICE")? {
        limits.bind_session_device = value;
    }
    Ok(limits)
}

/// Cross-field validation (`config.ts:472-506`) — all fatal at load time.
fn validate_cross_field(config: &FrickConfig) -> Result<()> {
    if config.db_driver == DbDriver::Postgres && config.database_url.is_none() {
        return Err(FrickConfigError::new(
            "FRICK_DB_DRIVER=postgres requires FRICK_DATABASE_URL (the Postgres connection string).",
        ));
    }
    if config.blob_driver == BlobDriver::Filesystem && config.blob_storage_path.trim().is_empty() {
        return Err(FrickConfigError::new(
            "FRICK_BLOB_DRIVER=filesystem requires FRICK_BLOB_STORAGE_PATH",
        ));
    }
    if config.blob_driver == BlobDriver::S3
        && config
            .blob_s3_bucket
            .as_deref()
            .is_none_or(|bucket| bucket.trim().is_empty())
    {
        return Err(FrickConfigError::new(
            "FRICK_BLOB_DRIVER=s3 requires FRICK_BLOB_S3_BUCKET",
        ));
    }
    if config.email_provider == EmailProvider::Resend {
        if config
            .resend_api_key
            .as_deref()
            .is_none_or(|key| key.trim().is_empty())
        {
            return Err(FrickConfigError::new(
                "FRICK_EMAIL_PROVIDER=resend requires FRICK_RESEND_API_KEY",
            ));
        }
        if config
            .email_from
            .as_deref()
            .is_none_or(|from| from.trim().is_empty())
        {
            return Err(FrickConfigError::new(
                "FRICK_EMAIL_PROVIDER=resend requires FRICK_EMAIL_FROM (the default `from:` address)",
            ));
        }
    }
    if config.env.is_production() {
        if config.demo_auth_enabled {
            return Err(FrickConfigError::new(
                "demo auth cannot be enabled in production",
            ));
        }
        if config.db_path == ":memory:" {
            return Err(FrickConfigError::new(
                "in-memory database cannot be used in production",
            ));
        }
        if config.admin_enabled()
            && config
                .admin_token
                .as_ref()
                .is_none_or(|token| token.len() < 32)
        {
            return Err(FrickConfigError::new(
                "FRICK_ADMIN_TOKEN must be at least 32 characters in production",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn defaults_are_development() {
        let config = load_frick_config(&env(&[])).unwrap();
        assert_eq!(config.env, FrickEnv::Development);
        assert!(config.demo_auth_enabled);
        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.port, 4099);
        assert_eq!(config.db_driver, DbDriver::Sqlite);
        assert_eq!(config.allowed_origins, vec![AllowedOrigin::Any]);
        assert!(config.inspection_enabled);
        assert!(!config.admin_enabled());
        assert_eq!(config.limits, FrickLimits::default());
    }

    #[test]
    fn production_flips_secure_defaults() {
        let config = load_frick_config(&env(&[("FRICK_ENV", "production")])).unwrap();
        assert!(!config.demo_auth_enabled);
        assert_eq!(config.host, "0.0.0.0");
        assert!(!config.inspection_enabled);
        assert!(config.allowed_origins.is_empty());
    }

    #[test]
    fn production_refuses_demo_auth() {
        let err = load_frick_config(&env(&[
            ("FRICK_ENV", "production"),
            ("FRICK_DEMO_AUTH_ENABLED", "true"),
        ]))
        .unwrap_err();
        assert!(err.0.contains("demo auth"));
    }

    #[test]
    fn production_requires_long_admin_token() {
        let short = load_frick_config(&env(&[
            ("FRICK_ENV", "production"),
            ("FRICK_ADMIN_TOKEN", "short"),
        ]))
        .unwrap_err();
        assert!(short.0.contains("32 characters"));

        let ok = load_frick_config(&env(&[
            ("FRICK_ENV", "production"),
            ("FRICK_ADMIN_TOKEN", "0123456789012345678901234567890123"),
            ("FRICK_ALLOWED_ORIGINS", "https://app.example.com"),
        ]))
        .unwrap();
        assert!(ok.admin_enabled());
    }

    #[test]
    fn postgres_requires_database_url() {
        let err = load_frick_config(&env(&[("FRICK_DB_DRIVER", "postgres")])).unwrap_err();
        assert!(err.0.contains("FRICK_DATABASE_URL"));
    }

    #[test]
    fn empty_string_is_unset() {
        let config = load_frick_config(&env(&[("FRICK_HOST", "  ")])).unwrap();
        assert_eq!(config.host, "127.0.0.1");
    }

    #[test]
    fn s3_driver_requires_bucket() {
        let err = load_frick_config(&env(&[("FRICK_BLOB_DRIVER", "s3")])).unwrap_err();
        assert!(err.0.contains("FRICK_BLOB_S3_BUCKET"), "{}", err.0);
    }

    #[test]
    fn s3_config_parses_full_surface() {
        // FR-273: bucket/region/endpoint/prefix/force-path-style all flow into
        // the config; the driver selection + AWS env credentials do the rest.
        let config = load_frick_config(&env(&[
            ("FRICK_BLOB_DRIVER", "s3"),
            ("FRICK_BLOB_S3_BUCKET", "frick-blobs"),
            ("FRICK_BLOB_S3_REGION", "us-west-2"),
            ("FRICK_BLOB_S3_ENDPOINT", "https://minio.example:9000"),
            ("FRICK_BLOB_S3_PREFIX", "blobs/v1"),
            ("FRICK_BLOB_S3_FORCE_PATH_STYLE", "true"),
        ]))
        .unwrap();
        assert_eq!(config.blob_driver, BlobDriver::S3);
        assert_eq!(config.blob_s3_bucket.as_deref(), Some("frick-blobs"));
        assert_eq!(config.blob_s3_region.as_deref(), Some("us-west-2"));
        assert_eq!(
            config.blob_s3_endpoint.as_deref(),
            Some("https://minio.example:9000")
        );
        assert_eq!(config.blob_s3_prefix.as_deref(), Some("blobs/v1"));
        assert_eq!(config.blob_s3_force_path_style, Some(true));
    }

    #[test]
    fn s3_force_path_style_is_optional_and_validated() {
        // Absent ⇒ None (the driver defaults it from endpoint presence).
        let config = load_frick_config(&env(&[
            ("FRICK_BLOB_DRIVER", "s3"),
            ("FRICK_BLOB_S3_BUCKET", "b"),
        ]))
        .unwrap();
        assert_eq!(config.blob_s3_force_path_style, None);

        // A bad boolean is fatal at load time, like every other boolean knob.
        let err = load_frick_config(&env(&[
            ("FRICK_BLOB_DRIVER", "s3"),
            ("FRICK_BLOB_S3_BUCKET", "b"),
            ("FRICK_BLOB_S3_FORCE_PATH_STYLE", "maybe"),
        ]))
        .unwrap_err();
        assert!(err.0.contains("Invalid boolean"), "{}", err.0);
    }

    #[test]
    fn boolean_parsing_matches_ts() {
        for truthy in ["true", "TRUE", "1", "yes", "YES"] {
            let config = load_frick_config(&env(&[("FRICK_INSPECTION_ENABLED", truthy)])).unwrap();
            assert!(config.inspection_enabled, "{truthy}");
        }
        for falsy in ["false", "0", "no"] {
            let config = load_frick_config(&env(&[("FRICK_INSPECTION_ENABLED", falsy)])).unwrap();
            assert!(!config.inspection_enabled, "{falsy}");
        }
        let err = load_frick_config(&env(&[("FRICK_INSPECTION_ENABLED", "maybe")])).unwrap_err();
        assert!(err.0.contains("Invalid boolean"));
    }

    #[test]
    fn port_range_is_validated() {
        assert!(load_frick_config(&env(&[("FRICK_PORT", "70000")])).is_err());
        assert_eq!(
            load_frick_config(&env(&[("FRICK_PORT", "8080")]))
                .unwrap()
                .port,
            8080
        );
    }

    #[test]
    fn wildcard_origin_matches_subdomains_not_apex() {
        let origin = parse_allowed_origin("https://*.example.com").unwrap();
        assert!(origin.matches("https", "app.example.com", None));
        assert!(origin.matches("https", "APP.EXAMPLE.COM", None));
        assert!(
            !origin.matches("https", "example.com", None),
            "apex never matches"
        );
        assert!(
            !origin.matches("http", "app.example.com", None),
            "scheme must match"
        );
    }

    #[test]
    fn exact_origin_requires_scheme_host_port() {
        let origin = parse_allowed_origin("https://app.example.com:8443").unwrap();
        assert!(origin.matches("https", "app.example.com", Some(8443)));
        assert!(!origin.matches("https", "app.example.com", None));
    }

    #[test]
    fn malformed_origins_are_rejected() {
        for bad in [
            "https://app.example.com/path",
            "https://user@example.com",
            "not-a-url",
            "https://*.*.com",
        ] {
            assert!(
                parse_allowed_origin(bad).is_err(),
                "{bad} should be rejected"
            );
        }
    }

    #[test]
    fn session_ttl_allows_negative_but_not_nan() {
        let config = load_frick_config(&env(&[("FRICK_SESSION_TTL_SECONDS", "-1")])).unwrap();
        assert!((config.session_ttl_seconds - (-1.0)).abs() < f64::EPSILON);
        assert!(load_frick_config(&env(&[("FRICK_SESSION_TTL_SECONDS", "abc")])).is_err());
    }

    #[test]
    fn oidc_providers_default_empty() {
        let config = load_frick_config(&env(&[])).unwrap();
        assert!(config.oidc_providers.is_empty());
        assert!(config.oidc_provider("okta").is_none());
    }

    #[test]
    fn oidc_providers_parse_from_json_array() {
        let config = load_frick_config(&env(&[(
            "FRICK_OIDC_PROVIDERS",
            r#"[
                {"id":"okta","issuer":"https://example.okta.com",
                 "audiences":["client-a","client-b"],
                 "jwksUri":"https://example.okta.com/oauth2/v1/keys"},
                {"id":"auth0","issuer":"https://example.auth0.com/",
                 "audience":"single-client",
                 "jwksUri":"https://example.auth0.com/.well-known/jwks.json"}
            ]"#,
        )]))
        .unwrap();
        assert_eq!(config.oidc_providers.len(), 2);
        let okta = config.oidc_provider("okta").unwrap();
        assert_eq!(okta.issuer, "https://example.okta.com");
        assert_eq!(okta.audiences, vec!["client-a", "client-b"]);
        // The single-string `audience` shorthand becomes a one-element list.
        let auth0 = config.oidc_provider("auth0").unwrap();
        assert_eq!(auth0.audiences, vec!["single-client"]);
    }

    #[test]
    fn oidc_providers_reject_duplicate_id() {
        let err = load_frick_config(&env(&[(
            "FRICK_OIDC_PROVIDERS",
            r#"[
                {"id":"okta","issuer":"https://a","audiences":["c"],"jwksUri":"https://a/keys"},
                {"id":"okta","issuer":"https://b","audiences":["c"],"jwksUri":"https://b/keys"}
            ]"#,
        )]))
        .unwrap_err();
        assert!(err.0.contains("duplicate provider id"), "{}", err.0);
    }

    #[test]
    fn oidc_providers_reject_missing_audience() {
        let err = load_frick_config(&env(&[(
            "FRICK_OIDC_PROVIDERS",
            r#"[{"id":"okta","issuer":"https://a","jwksUri":"https://a/keys"}]"#,
        )]))
        .unwrap_err();
        assert!(err.0.contains("at least one audience"), "{}", err.0);
    }

    #[test]
    fn oidc_providers_reject_invalid_json() {
        let err = load_frick_config(&env(&[("FRICK_OIDC_PROVIDERS", "not json")])).unwrap_err();
        assert!(err.0.contains("Invalid FRICK_OIDC_PROVIDERS"), "{}", err.0);
    }

    #[test]
    fn email_provider_defaults_to_noop() {
        let config = load_frick_config(&env(&[])).unwrap();
        assert_eq!(config.email_provider, EmailProvider::Noop);
        assert!(config.resend_api_key.is_none());
        assert!(config.email_from.is_none());
    }

    #[test]
    fn email_provider_resend_requires_key_and_from() {
        // Provider=resend with no key is fatal.
        let err = load_frick_config(&env(&[("FRICK_EMAIL_PROVIDER", "resend")])).unwrap_err();
        assert!(err.0.contains("FRICK_RESEND_API_KEY"), "{}", err.0);

        // Key present but `from` missing is still fatal.
        let err = load_frick_config(&env(&[
            ("FRICK_EMAIL_PROVIDER", "resend"),
            ("FRICK_RESEND_API_KEY", "re_test_key"),
        ]))
        .unwrap_err();
        assert!(err.0.contains("FRICK_EMAIL_FROM"), "{}", err.0);

        // Fully configured resend loads.
        let config = load_frick_config(&env(&[
            ("FRICK_EMAIL_PROVIDER", "resend"),
            ("FRICK_RESEND_API_KEY", "re_test_key"),
            ("FRICK_EMAIL_FROM", "noreply@frick.dev"),
        ]))
        .unwrap();
        assert_eq!(config.email_provider, EmailProvider::Resend);
        assert_eq!(config.resend_api_key.as_deref(), Some("re_test_key"));
        assert_eq!(config.email_from.as_deref(), Some("noreply@frick.dev"));
    }

    #[test]
    fn email_provider_rejects_unknown_value() {
        let err = load_frick_config(&env(&[("FRICK_EMAIL_PROVIDER", "postmark")])).unwrap_err();
        assert!(err.0.contains("Invalid FRICK_EMAIL_PROVIDER"), "{}", err.0);
    }

    #[test]
    fn platform_events_driver_defaults_to_kafka_with_brokers() {
        let config = load_frick_config(&env(&[(
            "FRICK_PLATFORM_EVENTS_KAFKA_BROKERS",
            "broker-1:9092, broker-2:9092",
        )]))
        .unwrap();
        assert_eq!(config.platform_events_driver, PlatformEventsDriver::Kafka);
        assert_eq!(config.platform_events_kafka_brokers.len(), 2);
    }

    #[test]
    fn platform_events_driver_accepts_memory_and_sqlite() {
        let memory =
            load_frick_config(&env(&[("FRICK_PLATFORM_EVENTS_DRIVER", "memory")])).unwrap();
        assert_eq!(memory.platform_events_driver, PlatformEventsDriver::Memory);

        let sqlite =
            load_frick_config(&env(&[("FRICK_PLATFORM_EVENTS_DRIVER", "sqlite")])).unwrap();
        assert_eq!(sqlite.platform_events_driver, PlatformEventsDriver::Sqlite);
    }

    #[test]
    fn platform_events_driver_defaults_to_sqlite_without_brokers() {
        let config = load_frick_config(&env(&[])).unwrap();
        assert_eq!(config.platform_events_driver, PlatformEventsDriver::Sqlite);
    }

    #[test]
    fn platform_events_driver_rejects_unknown_value() {
        let err =
            load_frick_config(&env(&[("FRICK_PLATFORM_EVENTS_DRIVER", "redis")])).unwrap_err();
        assert!(
            err.0
                .contains("FRICK_PLATFORM_EVENTS_DRIVER must be one of memory, sqlite, kafka"),
            "{}",
            err.0
        );
    }
}
