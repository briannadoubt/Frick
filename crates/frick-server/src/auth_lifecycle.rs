//! App auth lifecycle seams (FR-306).
//!
//! Built-in auth routes own credential verification and account rows, but apps
//! may need to create product schema state and choose the tenant carried by the
//! returned session. The default hook is identity-preserving, so standalone
//! Frick keeps foundation behavior.

use std::sync::Arc;

use async_trait::async_trait;
use frick_store::FrickStore;

use crate::error::ServerError;

pub type SharedAuthLifecycle = Arc<dyn AuthLifecycle>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthFullName {
    pub given_name: Option<String>,
    pub family_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthIdentity {
    Email {
        email: String,
    },
    Provider {
        provider: String,
        subject: String,
        handle: String,
        email: Option<String>,
        full_name: Option<AuthFullName>,
    },
}

#[derive(Clone)]
pub struct FirstSignInContext {
    pub store: Arc<FrickStore>,
    pub now_ms: i64,
    pub auth_tenant_id: String,
    pub identity: AuthIdentity,
    pub proposed_user_id: String,
    pub proposed_display_name: String,
}

#[derive(Clone)]
pub struct AuthSessionContext {
    pub store: Arc<FrickStore>,
    pub now_ms: i64,
    pub auth_tenant_id: String,
    pub identity: AuthIdentity,
    pub user_id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthLifecycleOutcome {
    pub session_tenant_id: String,
    pub user_id: String,
    pub display_name: String,
}

impl AuthLifecycleOutcome {
    #[must_use]
    pub fn unchanged(tenant_id: &str, user_id: &str, display_name: &str) -> Self {
        Self {
            session_tenant_id: tenant_id.to_string(),
            user_id: user_id.to_string(),
            display_name: display_name.to_string(),
        }
    }
}

#[async_trait]
pub trait AuthLifecycle: Send + Sync {
    async fn on_first_sign_in(
        &self,
        ctx: FirstSignInContext,
    ) -> Result<AuthLifecycleOutcome, ServerError>;

    async fn resolve_session(
        &self,
        ctx: AuthSessionContext,
    ) -> Result<AuthLifecycleOutcome, ServerError>;
}

#[derive(Debug, Default)]
pub struct NoopAuthLifecycle;

#[async_trait]
impl AuthLifecycle for NoopAuthLifecycle {
    async fn on_first_sign_in(
        &self,
        ctx: FirstSignInContext,
    ) -> Result<AuthLifecycleOutcome, ServerError> {
        Ok(AuthLifecycleOutcome::unchanged(
            &ctx.auth_tenant_id,
            &ctx.proposed_user_id,
            &ctx.proposed_display_name,
        ))
    }

    async fn resolve_session(
        &self,
        ctx: AuthSessionContext,
    ) -> Result<AuthLifecycleOutcome, ServerError> {
        Ok(AuthLifecycleOutcome::unchanged(
            &ctx.auth_tenant_id,
            &ctx.user_id,
            &ctx.display_name,
        ))
    }
}
