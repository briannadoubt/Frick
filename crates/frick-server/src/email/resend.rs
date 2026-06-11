//! The live Resend outbound-email adapter (FR-271).
//!
//! Mirrors the push-adapter pattern (`push/fcm_adapter.rs`): the request — URL,
//! headers, JSON body — is built by a **pure, unit-tested** function
//! ([`build_resend_request`]) and the [`ResendEmailAdapter`] only translates that
//! built [`ResendHttpRequest`] into a `reqwest` call and the HTTP response back
//! into a [`super::EmailError`]. The credential-bearing dependency (the Resend
//! API key) lives here, behind the [`super::FrickEmailAdapter`] trait, so it
//! stays out of the core.
//!
//! Resend's send endpoint is `POST https://api.resend.com/emails` with
//! `Authorization: Bearer <api key>` and a JSON body `{from,to,subject,html,text}`
//! (<https://resend.com/docs/api-reference/emails/send-email>). A 2xx is a
//! success; any other status (or a transport error) is returned as an
//! [`super::EmailError`], which the [`super::EmailRouter`] logs without aborting
//! the calling auth flow.
//!
//! # Testability
//!
//! Live Resend is, by construction, not reachable from CI. The request *shape*
//! (URL, bearer header, body fields) is built and asserted by the unit tests
//! below without a network; the boot-wiring + config selection are covered by
//! the config tests and `tests/email_auth.rs`'s recording adapter. The adapter's
//! `send` is the thin reqwest translation — there is no offline-testable
//! business logic in it.

use std::time::Duration;

use super::{EmailError, EmailMessage, EmailSendFuture, FrickEmailAdapter};

/// Resend's send endpoint.
const RESEND_ENDPOINT: &str = "https://api.resend.com/emails";

/// Default per-request timeout. Resend accepts-or-rejects quickly; a bounded
/// timeout keeps a wedged provider from pinning the calling auth flow.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// A fully-built Resend HTTP request: everything needed to issue the `POST`,
/// produced by [`build_resend_request`] so the shape is unit-testable without a
/// network (the push-adapter `*Request` pattern).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResendHttpRequest {
    /// Always the Resend send endpoint; carried so a test asserts it.
    pub url: String,
    /// The `Authorization` header value (`Bearer <api key>`).
    pub authorization: String,
    /// The serialized JSON request body (`{from,to,subject,html?,text}`).
    pub body: Vec<u8>,
}

/// The JSON body Resend expects (`{from,to,subject,html,text}`). `to` is a
/// single recipient here (the framework's auth emails are 1:1); Resend also
/// accepts an array, but a string is valid and keeps the shape minimal. `html`
/// is omitted when the message has no HTML part (`skip_serializing_if`), so a
/// text-only message sends a clean text-only payload.
#[derive(Debug, serde::Serialize)]
struct ResendBody<'a> {
    from: &'a str,
    to: &'a str,
    subject: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    html: Option<&'a str>,
    text: &'a str,
}

/// Build the Resend `POST /emails` request from a message + API key — pure, no
/// network. The `Authorization` is `Bearer <api key>`; the body is the Resend
/// JSON envelope. The only failure mode is JSON serialization, which cannot
/// happen for these owned `String`/`Option<String>` fields, so this is
/// effectively infallible — but it returns a `Result` for symmetry with the
/// push `build_*_request` functions and to surface a serializer regression
/// loudly rather than panicking.
///
/// # Errors
///
/// Returns [`EmailError`] (`email.serializeFailed`) only if the JSON body fails
/// to serialize — not reachable with the current field types.
pub fn build_resend_request(
    message: &EmailMessage,
    api_key: &str,
) -> Result<ResendHttpRequest, EmailError> {
    let body = ResendBody {
        from: &message.from,
        to: &message.to,
        subject: &message.subject,
        html: message.html.as_deref(),
        text: &message.text,
    };
    let body = serde_json::to_vec(&body)
        .map_err(|err| EmailError::new("email.serializeFailed", err.to_string()))?;
    Ok(ResendHttpRequest {
        url: RESEND_ENDPOINT.to_string(),
        authorization: format!("Bearer {api_key}"),
        body,
    })
}

/// The live Resend adapter. Holds a `reqwest::Client` (rustls) + the API key and
/// POSTs each message Resend's send endpoint. Selected at boot when
/// `FRICK_EMAIL_PROVIDER=resend` (see [`crate::email::EmailRouter::from_config`]).
pub struct ResendEmailAdapter {
    client: reqwest::Client,
    api_key: String,
}

impl ResendEmailAdapter {
    /// Build the adapter with a rustls `reqwest` client and the API key.
    ///
    /// # Panics
    ///
    /// Panics if the rustls `reqwest` client fails to build — a process-level TLS
    /// misconfiguration that should fail loudly at boot, not silently drop
    /// outbound mail. Mirrors the push transports' `expect`.
    #[must_use]
    pub fn new(api_key: impl Into<String>) -> Self {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("build reqwest client (rustls)");
        Self {
            client,
            api_key: api_key.into(),
        }
    }

    /// Build the adapter over an explicit `reqwest::Client` (for advanced wiring
    /// / proxies). The default [`Self::new`] path is what boot uses.
    #[must_use]
    pub fn with_client(client: reqwest::Client, api_key: impl Into<String>) -> Self {
        Self {
            client,
            api_key: api_key.into(),
        }
    }
}

impl FrickEmailAdapter for ResendEmailAdapter {
    fn provider(&self) -> &'static str {
        "resend"
    }

    fn send(&self, message: EmailMessage) -> EmailSendFuture<'_> {
        Box::pin(async move {
            let request = build_resend_request(&message, &self.api_key)?;
            let response = self
                .client
                .post(&request.url)
                .header(reqwest::header::AUTHORIZATION, &request.authorization)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(request.body)
                .send()
                .await
                .map_err(|err| {
                    EmailError::new(
                        "email.resendRequestFailed",
                        format!("Resend request failed: {err}"),
                    )
                })?;

            let status = response.status();
            if status.is_success() {
                return Ok(());
            }
            // Surface Resend's error body (id/name/message) so the router log
            // carries a diagnosable reason; the auth flow is unaffected.
            let detail = response
                .text()
                .await
                .unwrap_or_else(|err| format!("<body read failed: {err}>"));
            Err(EmailError::new(
                "email.resendRejected",
                format!("Resend returned {status}: {detail}"),
            ))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::email::EmailKind;

    fn message() -> EmailMessage {
        EmailMessage {
            to: "ada@example.com".to_string(),
            from: "noreply@frick.dev".to_string(),
            subject: "Reset your password for Frick".to_string(),
            text: "Reset your password: https://app/reset?token=abc".to_string(),
            html: Some(
                "<p>Reset: <a href=\"https://app/reset?token=abc\">link</a></p>".to_string(),
            ),
            kind: EmailKind::PasswordReset,
            tenant_id: "_default".to_string(),
        }
    }

    #[test]
    fn request_targets_resend_with_bearer_auth() {
        let request = build_resend_request(&message(), "re_test_key").unwrap();
        assert_eq!(request.url, "https://api.resend.com/emails");
        assert_eq!(request.authorization, "Bearer re_test_key");
    }

    #[test]
    fn request_body_carries_all_fields() {
        let request = build_resend_request(&message(), "re_test_key").unwrap();
        let json: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(json["from"], "noreply@frick.dev");
        assert_eq!(json["to"], "ada@example.com");
        assert_eq!(json["subject"], "Reset your password for Frick");
        assert_eq!(
            json["text"],
            "Reset your password: https://app/reset?token=abc"
        );
        assert_eq!(
            json["html"],
            "<p>Reset: <a href=\"https://app/reset?token=abc\">link</a></p>"
        );
    }

    #[test]
    fn text_only_message_omits_html_field() {
        let mut message = message();
        message.html = None;
        let request = build_resend_request(&message, "re_test_key").unwrap();
        let json: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
        assert!(
            json.get("html").is_none(),
            "html must be omitted, not null, when absent: {json}"
        );
        assert_eq!(json["text"], message.text);
    }

    #[test]
    fn adapter_reports_resend_provider() {
        let adapter = ResendEmailAdapter::new("re_test_key");
        assert_eq!(adapter.provider(), "resend");
    }
}
