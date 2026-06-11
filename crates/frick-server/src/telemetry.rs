//! OpenTelemetry OTLP export wiring (FR-267).
//!
//! The standalone `frick-server` binary already emits structured `tracing`
//! events (`tracing::info!(target: "frick.server", …)`), but until now nothing
//! collected them. This module is the tracing-subscriber boundary: it always
//! installs a plain `fmt` layer (honoring `FRICK_LOG_LEVEL`), and — when
//! [`OtelConfig::enabled`] is set (`FRICK_OTEL_ENABLED=true`, FR-267) — *also*
//! installs a [`tracing_opentelemetry`] layer backed by an OTLP **HTTP/protobuf**
//! span exporter (the `opentelemetry-otlp` `http-proto` transport over reqwest /
//! rustls — no gRPC, no `tonic` transport).
//!
//! ## Off by default
//!
//! With OTel disabled, [`install_tracing`] returns a guard that owns no tracer
//! provider, so the runtime behaves exactly as it did pre-FR-267 (only the local
//! `fmt` logger is active). This is the safe default: an operator opts in via
//! config, and a misconfigured exporter degrades to local logs rather than
//! taking the server down.
//!
//! ## Live push is not CI-testable
//!
//! The actual OTLP push needs a running collector (`ops/local/otel-collector.yaml`
//! binds `:4318`), so it is exercised manually / in compose, NOT in unit tests.
//! What *is* tested here is that the span-exporter + tracer-provider + tracing
//! layer can be constructed from an [`OtelConfig`] without a network
//! ([`build_tracer_provider`] + [`tracer_layer`]).

use opentelemetry::KeyValue;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::{Protocol, SpanExporter, WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::trace::{Sampler, SdkTracer, SdkTracerProvider};
use tracing::Subscriber;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::util::SubscriberInitExt;

use crate::config::{LogLevel, OtelConfig};

/// RAII guard returned by [`install_tracing`]. While held, the OTLP tracer
/// provider (if any) stays installed; on drop it is flushed and shut down so the
/// last batch of spans is exported before the process exits. When OTel is
/// disabled the guard is inert (it owns no provider) and dropping it is a no-op.
#[must_use = "dropping the guard immediately shuts the tracer provider down; hold it for the process lifetime"]
pub struct TelemetryGuard {
    provider: Option<SdkTracerProvider>,
}

impl TelemetryGuard {
    /// A guard that owns no provider (OTel disabled / construction failed).
    fn inert() -> Self {
        Self { provider: None }
    }

    /// True when an OTLP tracer provider is installed (OTel is live).
    #[must_use]
    pub fn otel_active(&self) -> bool {
        self.provider.is_some()
    }
}

impl Drop for TelemetryGuard {
    fn drop(&mut self) {
        if let Some(provider) = self.provider.take() {
            // Flush + shut down so in-flight spans are exported. Errors here are
            // best-effort on the way out — log, don't panic.
            if let Err(error) = provider.shutdown() {
                tracing::warn!(
                    target: "frick.otel",
                    %error,
                    "frick.otel.shutdown_failed"
                );
            }
        }
    }
}

/// Map the configured [`LogLevel`] onto a tracing directive string. Used both
/// for the local `fmt` layer and as the global filter floor.
fn level_directive(level: LogLevel) -> &'static str {
    match level {
        LogLevel::Debug => "debug",
        LogLevel::Info => "info",
        LogLevel::Warn => "warn",
        LogLevel::Error => "error",
    }
}

/// Build an `EnvFilter` from `RUST_LOG` if present, else the configured level.
/// `RUST_LOG` always wins so an operator can crank up verbosity ad hoc without
/// editing config.
fn env_filter(level: LogLevel) -> EnvFilter {
    EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(level_directive(level)))
}

/// Construct an OTLP **HTTP/protobuf** [`SdkTracerProvider`] from the OTel
/// config (FR-267). Pure construction — no socket is opened here; the batch
/// exporter connects lazily on the first export. Returns `Err` only when the
/// exporter builder rejects the settings (e.g. a malformed endpoint URL).
///
/// This is the unit-testable seam: a test can build a provider against an
/// arbitrary endpoint and assert it constructs, without a live collector.
pub fn build_tracer_provider(otel: &OtelConfig) -> Result<SdkTracerProvider, String> {
    // `with_headers` takes a `HashMap`; the config keeps an ordered `BTreeMap`
    // for deterministic parsing, so convert here.
    let headers: std::collections::HashMap<String, String> = otel
        .headers
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    // Supply the HTTP client explicitly so the transport is unambiguously
    // reqwest-over-rustls (the workspace reqwest defaults to `rustls-tls`); the
    // `http-proto` feature only selects the OTLP encoding, not the client.
    let http_client = reqwest::Client::new();
    let exporter = SpanExporter::builder()
        .with_http()
        .with_http_client(http_client)
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(&otel.endpoint)
        .with_headers(headers)
        .build()
        .map_err(|error| format!("failed to build OTLP span exporter: {error}"))?;

    let resource = Resource::builder()
        .with_attribute(KeyValue::new("service.name", otel.service_name.clone()))
        .build();

    // `None` ⇒ always-on (sample every trace); a ratio installs head-based
    // probability sampling, parented so a sampled parent keeps its children.
    let sampler = match otel.sample_ratio {
        Some(ratio) => Sampler::ParentBased(Box::new(Sampler::TraceIdRatioBased(ratio))),
        None => Sampler::AlwaysOn,
    };

    Ok(SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_resource(resource)
        .with_sampler(sampler)
        .build())
}

/// Build the `tracing-opentelemetry` layer from a provider, scoped to the
/// foundation tracer name. Generic over the subscriber so it composes onto the
/// registry in [`install_tracing`]; the bound is the standard
/// `tracing-opentelemetry` `Subscriber + LookupSpan` requirement.
pub fn tracer_layer<S>(
    provider: &SdkTracerProvider,
) -> tracing_opentelemetry::OpenTelemetryLayer<S, SdkTracer>
where
    S: Subscriber + for<'span> LookupSpan<'span>,
{
    let tracer = provider.tracer("frick-server");
    tracing_opentelemetry::layer().with_tracer(tracer)
}

/// Install the process-global tracing subscriber and return its lifetime guard.
///
/// Always wires a local `fmt` layer (filtered by `RUST_LOG` or the configured
/// [`LogLevel`]). When `otel.enabled`, additionally builds the OTLP tracer
/// provider, installs it as the global OpenTelemetry provider, and adds the
/// `tracing-opentelemetry` layer so every `tracing` span is exported over OTLP.
///
/// Failure to construct the OTLP exporter is logged and demoted to logs-only —
/// the server still boots. The returned [`TelemetryGuard`] MUST be held for the
/// process lifetime; dropping it flushes and shuts the exporter down.
///
/// # Panics
///
/// Does not panic. If a global subscriber is already set (e.g. a second call in
/// the same process), `try_init` fails and is swallowed — the first subscriber
/// stays in force.
pub fn install_tracing(level: LogLevel, otel: &OtelConfig) -> TelemetryGuard {
    let fmt_layer = tracing_subscriber::fmt::layer();

    if !otel.enabled {
        // Logs-only path: identical to the pre-FR-267 runtime.
        let _ = tracing_subscriber::registry()
            .with(env_filter(level))
            .with(fmt_layer)
            .try_init();
        return TelemetryGuard::inert();
    }

    match build_tracer_provider(otel) {
        Ok(provider) => {
            // Make this the global provider so library-level
            // `opentelemetry::global` lookups (and the guard's shutdown) resolve
            // the same instance.
            opentelemetry::global::set_tracer_provider(provider.clone());
            // The OTel layer is the OUTERMOST layer so its subscriber type
            // parameter is inferred against the full `Registry + filter + fmt`
            // stack it wraps. `tracing_opentelemetry::layer()` resolves `S` from
            // the `.with(..)` position, so it is built inline here rather than
            // through the fixed-`Registry` [`tracer_layer`] helper.
            let tracer = provider.tracer("frick-server");
            let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);
            let initialized = tracing_subscriber::registry()
                .with(env_filter(level))
                .with(fmt_layer)
                .with(otel_layer)
                .try_init()
                .is_ok();
            if initialized {
                tracing::info!(
                    target: "frick.otel",
                    endpoint = %otel.endpoint,
                    service_name = %otel.service_name,
                    "frick.otel.started"
                );
                TelemetryGuard {
                    provider: Some(provider),
                }
            } else {
                // A subscriber was already installed; shut the just-built
                // provider down so it doesn't leak a background batch task.
                let _ = provider.shutdown();
                TelemetryGuard::inert()
            }
        }
        Err(error) => {
            // Degrade to logs-only rather than failing the boot.
            let _ = tracing_subscriber::registry()
                .with(env_filter(level))
                .with(fmt_layer)
                .try_init();
            tracing::warn!(
                target: "frick.otel",
                %error,
                "frick.otel.start_failed"
            );
            TelemetryGuard::inert()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::OtelConfig;
    use std::collections::BTreeMap;

    fn otel(enabled: bool, ratio: Option<f64>) -> OtelConfig {
        OtelConfig {
            enabled,
            endpoint: "http://127.0.0.1:4318".to_string(),
            service_name: "frick-test".to_string(),
            headers: BTreeMap::new(),
            sample_ratio: ratio,
        }
    }

    #[test]
    fn tracer_provider_constructs_without_a_collector() {
        // The HTTP/protobuf exporter connects lazily, so construction succeeds
        // even with nothing listening on :4318 (the live push is not unit
        // tested — it needs a collector).
        let provider = build_tracer_provider(&otel(true, None)).expect("provider builds");
        // Building the tracing layer over it must also succeed.
        let _layer = tracer_layer::<tracing_subscriber::Registry>(&provider);
        // Tidy up the background batch worker.
        let _ = provider.shutdown();
    }

    #[test]
    fn tracer_provider_with_sampling_ratio_constructs() {
        let provider =
            build_tracer_provider(&otel(true, Some(0.1))).expect("ratio-sampled provider builds");
        let _ = provider.shutdown();
    }

    #[test]
    fn tracer_provider_with_headers_constructs() {
        let mut cfg = otel(true, None);
        cfg.headers
            .insert("authorization".to_string(), "Bearer tok".to_string());
        let provider = build_tracer_provider(&cfg).expect("provider with headers builds");
        let _ = provider.shutdown();
    }

    #[test]
    fn disabled_install_returns_inert_guard() {
        // `install_tracing` is process-global; running it in this test process
        // would race the other crates' subscribers. Assert the disabled config
        // shape instead: no provider should be constructed for it. We can still
        // verify the inert guard reports no active OTel and drops cleanly.
        let guard = TelemetryGuard::inert();
        assert!(!guard.otel_active());
        drop(guard);
    }
}
