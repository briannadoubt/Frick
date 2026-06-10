//! CORS middleware mirroring the TS `setCors` / `handlePreflight` contract
//! (map 02 §, `src/server.ts:3213-3250`). Applied to the composed router so
//! browser clients on a separate origin — the web client dev setup
//! (`:5173` → `:4099`) and production allowlists — receive the
//! `Access-Control-*` headers and preflight handling they need. Without this
//! the configured `FRICK_ALLOWED_ORIGINS` allowlist would have no effect and
//! every cross-origin HTTP call would fail.

use axum::http::{HeaderName, HeaderValue, Method};
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::config::AllowedOrigin;

/// Request headers a browser may send (`Access-Control-Allow-Headers`).
const ALLOW_HEADERS: &[&str] = &[
    "authorization",
    "content-type",
    "if-match",
    "x-frick-idempotency-key",
    "x-frick-owner-id",
    "x-frick-session-token",
    "x-frick-trace-id",
];

/// Response headers a browser may read (`Access-Control-Expose-Headers`).
const EXPOSE_HEADERS: &[&str] = &[
    "etag",
    "x-frick-schema-hash",
    "x-frick-blob-id",
    "x-frick-content-hash",
];

/// Build the CORS layer from the configured origin allowlist. An allowed
/// origin is echoed back (with `Vary: Origin`); a disallowed one receives no
/// `Access-Control-Allow-Origin`, so the browser blocks the response.
pub fn cors_layer(origins: &[AllowedOrigin]) -> CorsLayer {
    let origins = origins.to_vec();
    CorsLayer::new()
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers(
            ALLOW_HEADERS
                .iter()
                .map(|name| HeaderName::from_static(name))
                .collect::<Vec<_>>(),
        )
        .expose_headers(
            EXPOSE_HEADERS
                .iter()
                .map(|name| HeaderName::from_static(name))
                .collect::<Vec<_>>(),
        )
        .allow_origin(AllowOrigin::predicate(move |origin, _request| {
            origin_allowed(&origins, origin)
        }))
}

/// Whether a request `Origin` header is permitted by the allowlist.
fn origin_allowed(origins: &[AllowedOrigin], origin: &HeaderValue) -> bool {
    if origins
        .iter()
        .any(|entry| matches!(entry, AllowedOrigin::Any))
    {
        return true;
    }
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let Some((scheme, host, port)) = parse_origin(origin) else {
        return false;
    };
    origins
        .iter()
        .any(|entry| entry.matches(scheme, host, port))
}

/// Parse a concrete `scheme://host[:port]` origin (origins carry no path,
/// query, or fragment). Returns `None` for anything malformed.
fn parse_origin(origin: &str) -> Option<(&str, &str, Option<u16>)> {
    let (scheme, rest) = origin.split_once("://")?;
    if scheme.is_empty() || rest.is_empty() || rest.contains('/') {
        return None;
    }
    let (host, port) = match rest.rsplit_once(':') {
        // A trailing `:<digits>` is a port; anything else (e.g. a bare
        // unbracketed IPv6 literal) is treated as a host with no port.
        Some((host, maybe_port)) => match maybe_port.parse::<u16>() {
            Ok(port) => (host, Some(port)),
            Err(_) => (rest, None),
        },
        None => (rest, None),
    };
    if host.is_empty() {
        return None;
    }
    Some((scheme, host, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin(value: &str) -> HeaderValue {
        HeaderValue::from_str(value).unwrap()
    }

    #[test]
    fn wildcard_allows_every_origin() {
        let origins = vec![AllowedOrigin::Any];
        assert!(origin_allowed(
            &origins,
            &origin("https://anything.example")
        ));
    }

    #[test]
    fn exact_origin_matches_only_itself() {
        let origins = vec![AllowedOrigin::Exact {
            scheme: "https".into(),
            host: "app.example.com".into(),
            port: None,
        }];
        assert!(origin_allowed(&origins, &origin("https://app.example.com")));
        assert!(!origin_allowed(
            &origins,
            &origin("https://evil.example.com")
        ));
        assert!(!origin_allowed(&origins, &origin("http://app.example.com")));
    }

    #[test]
    fn empty_allowlist_rejects_all() {
        assert!(!origin_allowed(&[], &origin("https://app.example.com")));
    }

    #[test]
    fn parses_host_and_port() {
        assert_eq!(
            parse_origin("http://127.0.0.1:5173"),
            Some(("http", "127.0.0.1", Some(5173)))
        );
        assert_eq!(
            parse_origin("https://app.example.com"),
            Some(("https", "app.example.com", None))
        );
        assert_eq!(parse_origin("not-an-origin"), None);
        assert_eq!(parse_origin("https://app.example.com/path"), None);
    }
}
