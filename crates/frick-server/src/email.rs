//! The outbound-email seam (`apps/server/src/email/{types,router,test-adapter}.ts`).
//!
//! Mirrors the push-adapter pattern: the framework defines a trait
//! ([`FrickEmailAdapter`]), boot registers an implementation, and the
//! framework's password-reset (and, later, verification) flow calls into it
//! through an [`EmailRouter`] that formats the subject/body/links. Keeping the
//! credential-bearing dependencies (Resend, SES, Postmark) behind the trait
//! keeps them out of the core.
//!
//! Two adapters ship here:
//! - [`NoopEmailAdapter`] — the default. Logs `email not configured` and
//!   *succeeds*, so `forgot-password` can call the router unconditionally and
//!   still return 200 (the route never depends on a real send).
//! - [`RecordingEmailAdapter`] — a test double that captures every sent
//!   message for assertions and always succeeds (the Rust port of the TS
//!   `createFrickTestEmailAdapter`).
//!
//! The live Resend HTTP adapter ships in [`resend`] (FR-271): a `reqwest`-backed
//! [`ResendEmailAdapter`] selected at boot when `FRICK_EMAIL_PROVIDER=resend`
//! (else the Noop default keeps the seam inert). [`EmailRouter::from_config`] is
//! the config-driven injection point.

use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;

pub mod resend;
pub mod router;

pub use resend::ResendEmailAdapter;
pub use router::EmailRouter;

/// A fully-formed outbound message (`FrickEmailMessage`, email/types.ts:25-37).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmailMessage {
    pub to: String,
    pub from: String,
    pub subject: String,
    /// Plain-text body. Always present so every adapter can deliver something.
    pub text: String,
    /// Optional HTML body for adapters that support multipart.
    pub html: Option<String>,
    /// The message kind (`verification` / `passwordReset`) — adapter routing
    /// + observability (`tags.kind` in the TS).
    pub kind: EmailKind,
    /// The tenant the message belongs to (carried for routing/telemetry).
    pub tenant_id: String,
}

/// The message kind, the typed equivalent of the TS `tags.kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmailKind {
    /// Email-address verification (reserved for FR-271's verification flow).
    Verification,
    /// Password-reset link.
    PasswordReset,
}

impl EmailKind {
    /// The wire/log label (`tags.kind`).
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Verification => "verification",
            Self::PasswordReset => "passwordReset",
        }
    }
}

/// An adapter delivery failure (`FrickEmailDelivery { status: "failed", error }`).
/// The router never lets this tear down the calling auth flow — it is logged
/// and returned, never propagated as a route error.
#[derive(Debug, Clone, thiserror::Error)]
#[error("email delivery failed ({code}): {message}")]
pub struct EmailError {
    /// A short machine code (`adapter.threw`, `email.missingFrom`, …).
    pub code: String,
    pub message: String,
}

impl EmailError {
    /// Build an error with an explicit code + message.
    #[must_use]
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

/// A boxed, `Send` future returned by [`FrickEmailAdapter::send`] — the
/// object-safe form the codebase uses in place of `async-trait` (mirrors the
/// push-adapter `send`).
pub type EmailSendFuture<'a> =
    Pin<Box<dyn std::future::Future<Output = Result<(), EmailError>> + Send + 'a>>;

/// The pluggable outbound-email surface (`FrickEmailAdapter`, email/types.ts:39-44).
///
/// Implementations should be defensive; a returned [`EmailError`] is logged by
/// the [`EmailRouter`] but never aborts the auth flow that triggered the send.
/// `send` returns a boxed future (not `async fn`) so the trait stays
/// object-safe and dispatchable behind `Arc<dyn FrickEmailAdapter>` without an
/// `async-trait` dependency.
pub trait FrickEmailAdapter: Send + Sync {
    /// Identifier for adapter selection / telemetry (`provider`).
    fn provider(&self) -> &'static str;

    /// Deliver a message. `Ok(())` on success; an [`EmailError`] is recorded
    /// by the router but does not change the route's response.
    fn send(&self, message: EmailMessage) -> EmailSendFuture<'_>;
}

/// The default adapter: succeeds without sending so `forgot-password` is not
/// dead code and still returns 200 when no real provider is configured. Logs
/// once per send at INFO so an operator can see that email is unconfigured.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopEmailAdapter;

impl FrickEmailAdapter for NoopEmailAdapter {
    fn provider(&self) -> &'static str {
        "noop"
    }

    fn send(&self, message: EmailMessage) -> EmailSendFuture<'_> {
        Box::pin(async move {
            tracing::info!(
                target: "frick.email",
                kind = message.kind.as_str(),
                tenant_id = %message.tenant_id,
                "email not configured; message dropped (NoopEmailAdapter)"
            );
            Ok(())
        })
    }
}

/// A captured send (`{ message, delivery }` in the TS test adapter — here the
/// delivery always succeeds, so only the message is retained).
pub type RecordedEmail = EmailMessage;

/// A test adapter that records every message and always succeeds (the Rust
/// port of `createFrickTestEmailAdapter`). Cloneable so a test can hold a
/// handle to its captures after handing the adapter to boot.
#[derive(Debug, Default, Clone)]
pub struct RecordingEmailAdapter {
    sent: Arc<Mutex<Vec<RecordedEmail>>>,
}

impl RecordingEmailAdapter {
    /// A fresh recording adapter with no captures.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// A snapshot of every message captured so far, in send order.
    ///
    /// # Panics
    ///
    /// Panics only if the internal mutex was poisoned by a panic in another
    /// thread mid-`send` — never in normal operation.
    #[must_use]
    pub fn sent(&self) -> Vec<RecordedEmail> {
        self.sent
            .lock()
            .expect("recording mutex not poisoned")
            .clone()
    }

    /// Clear the captured messages (`reset()` in the TS adapter).
    ///
    /// # Panics
    ///
    /// See [`RecordingEmailAdapter::sent`].
    pub fn reset(&self) {
        self.sent
            .lock()
            .expect("recording mutex not poisoned")
            .clear();
    }
}

impl FrickEmailAdapter for RecordingEmailAdapter {
    fn provider(&self) -> &'static str {
        "recording"
    }

    fn send(&self, message: EmailMessage) -> EmailSendFuture<'_> {
        Box::pin(async move {
            self.sent
                .lock()
                .expect("recording mutex not poisoned")
                .push(message);
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(kind: EmailKind, to: &str) -> EmailMessage {
        EmailMessage {
            to: to.to_string(),
            from: "noreply@example.com".to_string(),
            subject: "s".to_string(),
            text: "t".to_string(),
            html: None,
            kind,
            tenant_id: "_default".to_string(),
        }
    }

    #[tokio::test]
    async fn noop_adapter_always_succeeds() {
        let adapter = NoopEmailAdapter;
        assert_eq!(adapter.provider(), "noop");
        adapter
            .send(message(EmailKind::PasswordReset, "a@b.com"))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn recording_adapter_captures_in_order_and_resets() {
        let adapter = RecordingEmailAdapter::new();
        adapter
            .send(message(EmailKind::PasswordReset, "first@b.com"))
            .await
            .unwrap();
        adapter
            .send(message(EmailKind::Verification, "second@b.com"))
            .await
            .unwrap();
        let captured = adapter.sent();
        assert_eq!(captured.len(), 2);
        assert_eq!(captured[0].to, "first@b.com");
        assert_eq!(captured[0].kind, EmailKind::PasswordReset);
        assert_eq!(captured[1].to, "second@b.com");

        adapter.reset();
        assert!(adapter.sent().is_empty());
    }
}
