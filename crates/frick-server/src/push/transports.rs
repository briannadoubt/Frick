//! Live `reqwest`-backed push transports (map 06 §3.7-3.9; FR-265).
//!
//! The adapters ([`apns_adapter`](super::apns_adapter) /
//! [`fcm_adapter`](super::fcm_adapter) /
//! [`webpush_adapter`](super::webpush_adapter)) build the request — URL, method,
//! headers, auth-token shape, body — as pure, unit-tested functions and hand the
//! resulting `*Request` struct to a transport behind a documented network seam.
//! Until FR-265 the only transports shipped were the `Unavailable*` defaults
//! (every send fails loudly) and the recording stubs used by tests; production
//! had no way to actually reach Apple / Google / a Web Push service.
//!
//! This module supplies the three real transports. Each holds a `reqwest::Client`
//! (rustls, no native TLS) and performs exactly the one send the adapter already
//! shaped:
//!
//! - [`ReqwestApnsTransport`] — HTTP/2 `POST {endpoint}/3/device/{token}` with
//!   `authorization`/`apns-topic`/`apns-push-type` and the JSON body. APNs
//!   mandates HTTP/2 with prior knowledge; the client is built with
//!   [`reqwest::ClientBuilder::http2_prior_knowledge`].
//! - [`ReqwestFcmTransport`] — `POST` for both the OAuth2 token exchange and the
//!   v1 `messages:send`, switching `content-type` / `authorization` per the
//!   [`FcmHttpRequest`].
//! - [`ReqwestWebPushTransport`] — `POST {endpoint}` with the VAPID
//!   `authorization`, `ttl`, and (when encrypted) `content-encoding: aes128gcm`
//!   headers and the `aes128gcm` body. **Owns the send-time SSRF DNS re-screen**
//!   (the literal-host guard in [`webpush_adapter`](super::webpush_adapter) can't
//!   resolve hostnames): before connecting it resolves the endpoint host and
//!   rejects the send if any resolved address is on the deny-list
//!   ([`is_unsafe_resolved_ip`](super::webpush_adapter::is_unsafe_resolved_ip)).
//!
//! # Testability
//!
//! The request *shape* is built and asserted in the adapter unit tests without a
//! network. These transports only translate a built request into a `reqwest`
//! call and translate the HTTP response back into the adapter's `*Response`
//! struct — there is no business logic here to unit-test offline. The only
//! offline-testable behaviour these add is the Web Push SSRF DNS re-screen
//! (`screen_endpoint_host`), which is covered below. Live delivery against the
//! real Apple/Google/push-service endpoints is, by construction, not reachable
//! from CI; the boot-wiring integration test exercises the full path with a
//! recording transport instead.

use std::time::Duration;

use super::apns_adapter::{ApnsRequest, ApnsResponse, ApnsTransport};
use super::fcm_adapter::{FcmHttpRequest, FcmHttpResponse, FcmTransport};
use super::webpush_adapter::{
    WebPushRequest, WebPushResponse, WebPushTransport, endpoint_host, is_unsafe_resolved_ip,
};

/// Default per-request timeout for the live transports. Push providers are quick
/// to accept-or-reject; a bounded timeout keeps a wedged provider from pinning a
/// worker.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Build the shared rustls `reqwest::Client` used by FCM and Web Push (ordinary
/// HTTP/1.1-or-2 negotiation). A client build failure (misconfigured TLS) is a
/// boot-time problem; the caller `expect`s it.
fn default_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .expect("build reqwest client (rustls)")
}

// ---- APNs --------------------------------------------------------------------

/// Live APNs HTTP/2 transport. APNs requires HTTP/2 with prior knowledge, so the
/// client is pinned to h2.
pub struct ReqwestApnsTransport {
    client: reqwest::Client,
}

impl ReqwestApnsTransport {
    /// Build the transport with an HTTP/2-prior-knowledge rustls client.
    ///
    /// # Panics
    ///
    /// Panics if the rustls `reqwest` client fails to build — a process-level TLS
    /// misconfiguration that should fail loudly at boot, not silently drop pushes.
    #[must_use]
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .http2_prior_knowledge()
            .build()
            .expect("build reqwest HTTP/2 client (rustls)");
        Self { client }
    }
}

impl Default for ReqwestApnsTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl ApnsTransport for ReqwestApnsTransport {
    fn send<'a>(
        &'a self,
        request: &'a ApnsRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<ApnsResponse, String>> + Send + 'a>,
    > {
        Box::pin(async move {
            let url = format!(
                "{}/3/device/{}",
                request.endpoint.trim_end_matches('/'),
                request.device_token
            );
            let response = self
                .client
                .post(&url)
                .header("authorization", &request.authorization)
                .header("apns-topic", &request.apns_topic)
                .header("apns-push-type", &request.apns_push_type)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(request.body.clone())
                .send()
                .await
                .map_err(|err| format!("APNs request failed: {err}"))?;

            let status = response.status().as_u16();
            let apns_id = response
                .headers()
                .get("apns-id")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let body = response
                .text()
                .await
                .map_err(|err| format!("APNs response body read failed: {err}"))?;
            Ok(ApnsResponse {
                status,
                apns_id,
                body,
            })
        })
    }
}

// ---- FCM ---------------------------------------------------------------------

/// Live FCM transport. Performs both the OAuth2 token exchange and the v1 send;
/// the `content-type` / `authorization` switch is carried by the request.
pub struct ReqwestFcmTransport {
    client: reqwest::Client,
}

impl ReqwestFcmTransport {
    /// Build the transport with the shared rustls client.
    ///
    /// # Panics
    ///
    /// Panics if the rustls `reqwest` client fails to build (a boot-time TLS
    /// misconfiguration).
    #[must_use]
    pub fn new() -> Self {
        Self {
            client: default_client(),
        }
    }
}

impl Default for ReqwestFcmTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl FcmTransport for ReqwestFcmTransport {
    fn request<'a>(
        &'a self,
        request: &'a FcmHttpRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<FcmHttpResponse, String>> + Send + 'a>,
    > {
        Box::pin(async move {
            let mut builder = self
                .client
                .post(&request.url)
                .header(reqwest::header::CONTENT_TYPE, &request.content_type)
                .body(request.body.clone());
            if let Some(authorization) = &request.authorization {
                builder = builder.header(reqwest::header::AUTHORIZATION, authorization);
            }
            let response = builder
                .send()
                .await
                .map_err(|err| format!("FCM request failed: {err}"))?;
            let status = response.status().as_u16();
            let body = response
                .text()
                .await
                .map_err(|err| format!("FCM response body read failed: {err}"))?;
            Ok(FcmHttpResponse { status, body })
        })
    }
}

// ---- Web Push ----------------------------------------------------------------

/// Live Web Push transport. POSTs the ciphertext to the subscription endpoint.
///
/// Owns the **send-time SSRF DNS re-screen**: the synchronous
/// [`is_safe_web_push_endpoint`](super::webpush_adapter::is_safe_web_push_endpoint)
/// guard only screens a literal host, so a hostname that resolves to a private /
/// link-local / loopback address (DNS rebinding) would slip past it. Because
/// this transport now owns DNS, it resolves the endpoint host and rejects the
/// send when ANY resolved address is on the deny-list, before any bytes leave
/// the process.
pub struct ReqwestWebPushTransport {
    client: reqwest::Client,
}

impl ReqwestWebPushTransport {
    /// Build the transport with the shared rustls client.
    ///
    /// # Panics
    ///
    /// Panics if the rustls `reqwest` client fails to build (a boot-time TLS
    /// misconfiguration).
    #[must_use]
    pub fn new() -> Self {
        Self {
            client: default_client(),
        }
    }
}

impl Default for ReqwestWebPushTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl WebPushTransport for ReqwestWebPushTransport {
    fn send<'a>(
        &'a self,
        request: &'a WebPushRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<WebPushResponse, String>> + Send + 'a>,
    > {
        Box::pin(async move {
            // SSRF DNS re-screen: resolve the host and reject the send if any
            // resolved address is on the deny-list. This is the DNS step the
            // synchronous literal-host guard cannot perform.
            screen_endpoint_host(&request.endpoint).await?;

            let mut builder = self
                .client
                .post(&request.endpoint)
                .header("ttl", &request.ttl)
                .body(request.body.clone());
            if let Some(content_encoding) = &request.content_encoding {
                builder = builder.header(reqwest::header::CONTENT_ENCODING, content_encoding);
            }
            // The VAPID authorization is `vapid t=<jwt>, k=<key>`.
            builder = builder.header(reqwest::header::AUTHORIZATION, &request.authorization);

            let response = builder
                .send()
                .await
                .map_err(|err| format!("Web Push request failed: {err}"))?;
            Ok(WebPushResponse {
                status: response.status().as_u16(),
            })
        })
    }
}

/// Resolve the endpoint host and reject the send if any resolved address is on
/// the SSRF deny-list. Returns `Ok(())` only when every resolved address is
/// allowed; an unresolvable host, a malformed endpoint, or any unsafe address is
/// an `Err` carrying a `push.deliveryFailed`-shaped message.
async fn screen_endpoint_host(endpoint: &str) -> Result<(), String> {
    let Some(host) = endpoint_host(endpoint) else {
        return Err("Web Push endpoint is not a valid https URL".to_string());
    };

    // A literal IP host: screen it directly (no DNS needed).
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        if is_unsafe_resolved_ip(ip) {
            return Err(format!(
                "Web Push endpoint host {host} resolves to a disallowed address"
            ));
        }
        return Ok(());
    }

    // Resolve via the system resolver (port is irrelevant for the screen).
    let addrs = resolve_host(&host).await?;
    if addrs.is_empty() {
        return Err(format!("Web Push endpoint host {host} did not resolve"));
    }
    for ip in addrs {
        if is_unsafe_resolved_ip(ip) {
            return Err(format!(
                "Web Push endpoint host {host} resolves to a disallowed address"
            ));
        }
    }
    Ok(())
}

/// Resolve a hostname to its IP addresses on a blocking-resolver thread (the std
/// resolver is sync). `:443` is appended so `to_socket_addrs` has a port; the
/// port is then discarded — only the addresses matter for the screen.
async fn resolve_host(host: &str) -> Result<Vec<std::net::IpAddr>, String> {
    let host = host.to_string();
    tokio::task::spawn_blocking(move || {
        use std::net::ToSocketAddrs as _;
        (host.as_str(), 443u16)
            .to_socket_addrs()
            .map(|iter| iter.map(|addr| addr.ip()).collect::<Vec<_>>())
            .map_err(|err| format!("Web Push endpoint host {host} did not resolve: {err}"))
    })
    .await
    .map_err(|err| format!("DNS resolution task failed: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    // The SSRF DNS re-screen is the one piece of offline-testable logic these
    // transports add. Live delivery is not reachable from CI.

    #[tokio::test]
    async fn screen_rejects_a_non_https_or_malformed_endpoint() {
        assert!(screen_endpoint_host("ftp://example.com/x").await.is_err());
        assert!(screen_endpoint_host("not a url").await.is_err());
    }

    #[tokio::test]
    async fn screen_rejects_a_literal_loopback_host() {
        // 127.0.0.1 / ::1 are on the deny-list — screened without DNS.
        let err = screen_endpoint_host("https://127.0.0.1/push/abc")
            .await
            .unwrap_err();
        assert!(err.contains("disallowed"), "got: {err}");
        let err6 = screen_endpoint_host("https://[::1]/push/abc")
            .await
            .unwrap_err();
        assert!(err6.contains("disallowed"), "got: {err6}");
    }

    #[tokio::test]
    async fn screen_rejects_a_literal_private_and_link_local_host() {
        for endpoint in [
            "https://10.0.0.5/p",
            "https://192.168.1.1/p",
            "https://169.254.169.254/latest/meta-data", // cloud metadata
            "https://172.16.0.1/p",
        ] {
            let err = screen_endpoint_host(endpoint).await.unwrap_err();
            assert!(err.contains("disallowed"), "{endpoint} -> {err}");
        }
    }

    #[tokio::test]
    async fn screen_allows_a_literal_public_host() {
        // A public literal address passes the screen (no DNS, just the
        // deny-list check).
        assert!(
            screen_endpoint_host("https://93.184.216.34/push/abc")
                .await
                .is_ok()
        );
    }
}
