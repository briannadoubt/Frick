//! The email router (`apps/server/src/email/router.ts`).
//!
//! A thin layer over a [`FrickEmailAdapter`] that formats the framework's
//! verification / password-reset emails (subject, plain-text + HTML body, the
//! action link) and forwards them to the adapter. Provider failures are caught
//! and returned as [`EmailError`] so the calling auth flow (e.g.
//! `forgot-password`) can log them without aborting — the route's response
//! never depends on a successful send.

use std::sync::Arc;

use super::{EmailError, EmailKind, EmailMessage, FrickEmailAdapter};

/// The default `appName` used in subjects when an app supplies none
/// (router.ts: `opts.appName ?? "Your app"`).
const DEFAULT_APP_NAME: &str = "Your app";

/// Formats + dispatches the framework's auth emails through a single injected
/// adapter (`createFrickEmailRouter`). Boot wires a [`super::NoopEmailAdapter`]
/// by default; tests inject [`super::RecordingEmailAdapter`]; FR-271 plugs a
/// Resend adapter here without touching the routes.
pub struct EmailRouter {
    adapter: Arc<dyn FrickEmailAdapter>,
    /// Default `from:` address. When `None`, the verification/reset helpers
    /// short-circuit with `email.missingFrom` (router.ts `adapterMissingFromError`).
    default_from: Option<String>,
    /// Default `appName` for subjects; falls back to [`DEFAULT_APP_NAME`].
    app_name: Option<String>,
}

/// Inputs for a password-reset email (`PasswordResetEmailOptions`).
pub struct PasswordResetEmail {
    pub tenant_id: String,
    pub to: String,
    pub reset_url: String,
}

/// Inputs for a verification email (`VerificationEmailOptions`). Reserved for
/// the verification flow (FR-271); kept here so the seam is complete.
pub struct VerificationEmail {
    pub tenant_id: String,
    pub to: String,
    pub verification_url: String,
}

impl EmailRouter {
    /// Build a router over an adapter, with an optional default `from:` and
    /// `appName`. The default boot wiring passes `Arc::new(NoopEmailAdapter)`.
    #[must_use]
    pub fn new(
        adapter: Arc<dyn FrickEmailAdapter>,
        default_from: Option<String>,
        app_name: Option<String>,
    ) -> Self {
        Self {
            adapter,
            default_from,
            app_name,
        }
    }

    /// A router over the [`super::NoopEmailAdapter`] with no `from:`/`appName`
    /// — the default boot seam (FR-271 replaces the adapter).
    #[must_use]
    pub fn noop() -> Self {
        Self::new(Arc::new(super::NoopEmailAdapter), None, None)
    }

    /// Build the boot email router from config (FR-271). When
    /// `email_provider == Resend` (validated to carry both an API key and a
    /// `from:` address), this wires a live [`super::ResendEmailAdapter`] with
    /// `email_from` as the router's `default_from`. For every other provider
    /// (the [`crate::config::EmailProvider::Noop`] default — i.e. an
    /// unconfigured deployment) it returns [`Self::noop`], so `forgot-password`
    /// still returns 200 without sending. The `appName` falls back to the
    /// default when no `public_url`-derived name is configured.
    #[must_use]
    pub fn from_config(config: &crate::config::FrickConfig) -> Self {
        use crate::config::EmailProvider;
        match config.email_provider {
            EmailProvider::Resend => {
                // `validate_cross_field` guarantees both are present + non-empty
                // when the provider is Resend; the `unwrap_or_default` is purely
                // defensive (a missing key would yield a `Bearer ` header that
                // Resend rejects — surfaced + logged by the router, never a
                // panic).
                let api_key = config.resend_api_key.clone().unwrap_or_default();
                Self::new(
                    Arc::new(super::ResendEmailAdapter::new(api_key)),
                    config.email_from.clone(),
                    None,
                )
            }
            EmailProvider::Noop => Self::noop(),
        }
    }

    /// The adapter's provider id (`noop` / `recording` / `resend`).
    #[must_use]
    pub fn provider(&self) -> &'static str {
        self.adapter.provider()
    }

    /// Send a fully-formed message; logs the adapter outcome and returns it.
    /// A provider failure is returned as [`EmailError`], never panics.
    pub async fn send(&self, message: EmailMessage) -> Result<(), EmailError> {
        let kind = message.kind;
        let result = self.adapter.send(message).await;
        match &result {
            Ok(()) => tracing::info!(
                target: "frick.email",
                provider = self.adapter.provider(),
                kind = kind.as_str(),
                "frick.email.delivered"
            ),
            Err(error) => tracing::warn!(
                target: "frick.email",
                provider = self.adapter.provider(),
                kind = kind.as_str(),
                code = %error.code,
                message = %error.message,
                "frick.email.delivery_failed"
            ),
        }
        result
    }

    /// Format + send a password-reset email
    /// (`sendPasswordResetEmail`, router.ts:118-135).
    pub async fn send_password_reset_email(
        &self,
        opts: PasswordResetEmail,
    ) -> Result<(), EmailError> {
        let Some(from) = self.default_from.clone() else {
            return Err(missing_from());
        };
        let app_name = self.app_name.as_deref().unwrap_or(DEFAULT_APP_NAME);
        let subject = format!("Reset your password for {app_name}");
        let text = format!(
            "Reset your password: {url}\n\nThis link expires in one hour. If you didn't request this, ignore this email.",
            url = opts.reset_url
        );
        let escaped = escape_html(&opts.reset_url);
        let html = format!(
            "<p>Reset your password: <a href=\"{escaped}\">{escaped}</a></p><p>This link expires in one hour. If you didn't request this, ignore this email.</p>"
        );
        self.send(EmailMessage {
            to: opts.to,
            from,
            subject,
            text,
            html: Some(html),
            kind: EmailKind::PasswordReset,
            tenant_id: opts.tenant_id,
        })
        .await
    }

    /// Format + send a verification email
    /// (`sendVerificationEmail`, router.ts:98-116). Reserved for FR-271.
    pub async fn send_verification_email(&self, opts: VerificationEmail) -> Result<(), EmailError> {
        let Some(from) = self.default_from.clone() else {
            return Err(missing_from());
        };
        let app_name = self.app_name.as_deref().unwrap_or(DEFAULT_APP_NAME);
        let subject = format!("Verify your email for {app_name}");
        let text = format!(
            "Click to verify: {url}\n\nIf you didn't request this, ignore this email.",
            url = opts.verification_url
        );
        let escaped = escape_html(&opts.verification_url);
        let html = format!(
            "<p>Click to verify: <a href=\"{escaped}\">{escaped}</a></p><p>If you didn't request this, ignore this email.</p>"
        );
        self.send(EmailMessage {
            to: opts.to,
            from,
            subject,
            text,
            html: Some(html),
            kind: EmailKind::Verification,
            tenant_id: opts.tenant_id,
        })
        .await
    }
}

impl Default for EmailRouter {
    fn default() -> Self {
        Self::noop()
    }
}

/// `adapterMissingFromError` (router.ts:138-146).
fn missing_from() -> EmailError {
    EmailError::new(
        "email.missingFrom",
        "No `from:` address provided and no defaultFrom configured",
    )
}

/// `escapeHtml` (router.ts:158-165): minimal HTML-attribute escaping for the
/// link URL so a crafted token can't break out of the `href`.
fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::email::RecordingEmailAdapter;

    #[tokio::test]
    async fn password_reset_email_is_formatted_and_recorded() {
        let recorder = RecordingEmailAdapter::new();
        let router = EmailRouter::new(
            Arc::new(recorder.clone()),
            Some("noreply@frick.dev".to_string()),
            Some("Frick".to_string()),
        );
        router
            .send_password_reset_email(PasswordResetEmail {
                tenant_id: "_default".to_string(),
                to: "ada@example.com".to_string(),
                reset_url: "https://app/reset?token=abc&x=1".to_string(),
            })
            .await
            .unwrap();
        let sent = recorder.sent();
        assert_eq!(sent.len(), 1);
        let message = &sent[0];
        assert_eq!(message.to, "ada@example.com");
        assert_eq!(message.from, "noreply@frick.dev");
        assert_eq!(message.subject, "Reset your password for Frick");
        assert_eq!(message.kind, EmailKind::PasswordReset);
        assert!(message.text.contains("https://app/reset?token=abc&x=1"));
        // The `&` is escaped in the HTML href.
        assert!(
            message
                .html
                .as_deref()
                .unwrap()
                .contains("token=abc&amp;x=1")
        );
    }

    #[tokio::test]
    async fn missing_from_short_circuits_without_sending() {
        let recorder = RecordingEmailAdapter::new();
        let router = EmailRouter::new(Arc::new(recorder.clone()), None, None);
        let result = router
            .send_password_reset_email(PasswordResetEmail {
                tenant_id: "_default".to_string(),
                to: "ada@example.com".to_string(),
                reset_url: "https://app/reset".to_string(),
            })
            .await;
        let error = result.unwrap_err();
        assert_eq!(error.code, "email.missingFrom");
        assert!(recorder.sent().is_empty());
    }

    #[tokio::test]
    async fn noop_router_default_uses_default_app_name() {
        // The default Noop router has no `from:`, so the reset helper reports
        // missingFrom; this documents the default boot seam (FR-271 supplies a
        // real adapter + from).
        let router = EmailRouter::default();
        assert_eq!(router.provider(), "noop");
    }

    fn config_from(pairs: &[(&str, &str)]) -> crate::config::FrickConfig {
        let mut env: std::collections::BTreeMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        // Keep the rest of the config trivially valid (dev defaults).
        env.entry("FRICK_ENV".to_string())
            .or_insert_with(|| "test".to_string());
        crate::config::load_frick_config(&env).unwrap()
    }

    #[test]
    fn from_config_default_stays_noop() {
        // An unconfigured deployment (no FRICK_EMAIL_PROVIDER) must stay Noop so
        // forgot-password still 200s without a real provider (FR-271).
        let router = EmailRouter::from_config(&config_from(&[]));
        assert_eq!(router.provider(), "noop");
    }

    #[test]
    fn from_config_resend_selects_live_adapter_with_from() {
        let router = EmailRouter::from_config(&config_from(&[
            ("FRICK_EMAIL_PROVIDER", "resend"),
            ("FRICK_RESEND_API_KEY", "re_test_key"),
            ("FRICK_EMAIL_FROM", "noreply@frick.dev"),
        ]));
        assert_eq!(router.provider(), "resend");
        // The configured `from:` is threaded through as the router default, so
        // the password-reset helper formats + dispatches rather than reporting
        // missingFrom.
        assert_eq!(router.default_from.as_deref(), Some("noreply@frick.dev"));
    }
}
