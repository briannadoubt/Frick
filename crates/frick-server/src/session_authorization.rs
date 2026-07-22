//! App-owned authorization for otherwise active bearer sessions.
//!
//! The framework validates token existence, expiry, and tenant state first.
//! An app can then tighten access (for example, hold an enrolled-MFA session
//! in a pending state until step-up succeeds). The default hook allows every
//! active session, preserving standalone Frick behavior.

use std::sync::Arc;

use async_trait::async_trait;
use frick_store::FrickStore;

use crate::error::ServerError;
use crate::principal::Principal;

pub type SharedSessionAuthorization = Arc<dyn SessionAuthorization>;

#[derive(Clone)]
pub struct SessionAuthorizationContext {
    pub store: Arc<FrickStore>,
    pub session_token: String,
    pub principal: Principal,
    pub now_ms: i64,
}

#[async_trait]
pub trait SessionAuthorization: Send + Sync {
    async fn authorize(&self, context: SessionAuthorizationContext) -> Result<(), ServerError>;
}

#[derive(Debug, Default)]
pub struct AllowActiveSessions;

#[async_trait]
impl SessionAuthorization for AllowActiveSessions {
    async fn authorize(&self, _context: SessionAuthorizationContext) -> Result<(), ServerError> {
        Ok(())
    }
}
