//! Session resolution, the tenant gate, and session minting — the seam the
//! HTTP routes and the WebSocket gateway share (`src/server.ts:3727-3911`).

use frick_store::FrickStore;

use crate::error::ServerError;
use crate::principal::{ARCHIVED_TENANT_PREFIX, DEFAULT_TENANT_ID, Principal, PrincipalScope};

/// Resolve a bearer session token to a [`Principal`]
/// (`principalFromActiveSessionToken`, `src/server.ts:3791-3815`):
///
/// - active session row → principal
/// - a row exists but is expired (`expiresAt <= now`) →
///   [`ServerError::SessionExpired`] (`auth.sessionExpired`)
/// - no row → generic 401
/// - the principal's tenant is archived → 401 "Tenant is archived"
pub async fn principal_from_active_session_token(
    store: &FrickStore,
    token: &str,
    now_ms: i64,
) -> Result<Principal, ServerError> {
    if let Some(session) = store
        .sessions()
        .read_active(token, now_ms)
        .await
        .map_err(|_| ServerError::Internal)?
    {
        // Archived tenant → 401.
        if is_tenant_archived(store, &session.tenant_id).await? {
            return Err(ServerError::Authentication {
                message: "Tenant is archived".into(),
            });
        }
        return Ok(Principal {
            user_id: session.user_id,
            device_id: session.device_id,
            replica_id: session.replica_id,
            tenant_id: session.tenant_id,
            scope: PrincipalScope::Tenant,
            service_scopes: Vec::new(),
        });
    }

    // No active row: distinguish expired (a stale row exists) from unknown.
    let stale = store
        .sessions()
        .read_any(token)
        .await
        .map_err(|_| ServerError::Internal)?;
    if stale.is_some() {
        return Err(ServerError::SessionExpired);
    }
    Err(ServerError::Authentication {
        message: "Invalid session".into(),
    })
}

/// `ensureTenantAllowed` (`src/server.ts:3895-3911`): `_default` is always
/// allowed; an archived tenant is rejected; an unknown tenant is auto-created
/// when `implicit_tenant_creation` is set, else rejected.
pub async fn ensure_tenant_allowed(
    store: &FrickStore,
    tenant_id: &str,
    implicit_tenant_creation: bool,
    now_ms: i64,
) -> Result<(), ServerError> {
    if tenant_id == DEFAULT_TENANT_ID {
        return Ok(());
    }
    match store
        .tenants()
        .get(tenant_id)
        .await
        .map_err(|_| ServerError::Internal)?
    {
        Some(tenant) if tenant.archived_at.is_some() => Err(ServerError::UnknownTenant {
            tenant_id: tenant_id.to_string(),
        }),
        Some(_) => Ok(()),
        None => {
            if implicit_tenant_creation {
                store
                    .tenants()
                    .ensure(tenant_id, now_ms)
                    .await
                    .map_err(|_| ServerError::Internal)?;
                Ok(())
            } else {
                Err(ServerError::UnknownTenant {
                    tenant_id: tenant_id.to_string(),
                })
            }
        }
    }
}

async fn is_tenant_archived(store: &FrickStore, tenant_id: &str) -> Result<bool, ServerError> {
    if tenant_id == DEFAULT_TENANT_ID {
        return Ok(false);
    }
    // Cheap prefix guard first, then the authoritative store check.
    if tenant_id.starts_with(ARCHIVED_TENANT_PREFIX) {
        return Ok(true);
    }
    let tenant = store
        .tenants()
        .get(tenant_id)
        .await
        .map_err(|_| ServerError::Internal)?;
    Ok(tenant.is_some_and(|t| t.archived_at.is_some()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use frick_store::FrickStore;
    use frick_store::stores::session::CreateSessionInput;

    async fn memory_store() -> FrickStore {
        FrickStore::open(frick_store::FrickStoreOptions::default())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn active_token_resolves_to_principal() {
        let store = memory_store().await;
        store
            .sessions()
            .create(
                &CreateSessionInput {
                    session_token: "tok-1".into(),
                    tenant_id: DEFAULT_TENANT_ID.into(),
                    user_id: "user-1".into(),
                    device_id: "device-1".into(),
                    replica_id: "replica-1".into(),
                    expires_at: "2999-01-01T00:00:00.000Z".into(),
                },
                1_700_000_000_000,
            )
            .await
            .unwrap();

        let principal = principal_from_active_session_token(&store, "tok-1", 1_700_000_000_001)
            .await
            .unwrap();
        assert_eq!(principal.user_id, "user-1");
        assert_eq!(principal.tenant_id, DEFAULT_TENANT_ID);
    }

    #[tokio::test]
    async fn expired_token_reports_session_expired() {
        let store = memory_store().await;
        store
            .sessions()
            .create(
                &CreateSessionInput {
                    session_token: "tok-2".into(),
                    tenant_id: DEFAULT_TENANT_ID.into(),
                    user_id: "user-2".into(),
                    device_id: "d".into(),
                    replica_id: "r".into(),
                    expires_at: "2000-01-01T00:00:00.000Z".into(),
                },
                1_700_000_000_000,
            )
            .await
            .unwrap();

        let err = principal_from_active_session_token(&store, "tok-2", 1_700_000_000_001)
            .await
            .unwrap_err();
        assert!(matches!(err, ServerError::SessionExpired));
    }

    #[tokio::test]
    async fn unknown_token_is_generic_401() {
        let store = memory_store().await;
        let err = principal_from_active_session_token(&store, "nope", 1)
            .await
            .unwrap_err();
        assert!(matches!(err, ServerError::Authentication { .. }));
        assert_eq!(err.http_status(), 401);
    }

    #[tokio::test]
    async fn default_tenant_always_allowed() {
        let store = memory_store().await;
        ensure_tenant_allowed(&store, DEFAULT_TENANT_ID, false, 1)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn unknown_tenant_rejected_unless_implicit() {
        let store = memory_store().await;
        let err = ensure_tenant_allowed(&store, "tenant-x", false, 1)
            .await
            .unwrap_err();
        assert!(matches!(err, ServerError::UnknownTenant { .. }));

        // With implicit creation, the tenant is created and allowed.
        ensure_tenant_allowed(&store, "tenant-x", true, 1)
            .await
            .unwrap();
        assert!(store.tenants().get("tenant-x").await.unwrap().is_some());
    }
}
