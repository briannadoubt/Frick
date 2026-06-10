//! The authenticated principal and tenancy constants (`src/authz.ts`,
//! `src/app-id.ts`).

/// `_default` — the default tenant and app partition (`src/app-id.ts`).
pub const DEFAULT_TENANT_ID: &str = "_default";
pub const DEFAULT_APP_ID: &str = "_default";

/// Prefix marking an archived tenant id in the cheap `#isPrincipalActive`
/// check (`src/sync/gateway.ts:2254-2256`).
pub const ARCHIVED_TENANT_PREFIX: &str = "_archived_";

/// A principal's authorization scope (`src/authz.ts:51-89`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PrincipalScope {
    #[default]
    Tenant,
    Admin,
    Service,
}

/// An authenticated principal (`Principal` in TS).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Principal {
    pub user_id: String,
    pub device_id: String,
    pub replica_id: String,
    pub tenant_id: String,
    pub scope: PrincipalScope,
    /// Populated for `scope == Service` (FR-46).
    pub service_scopes: Vec<String>,
}

impl Principal {
    /// The fixed admin principal (`src/server.ts:3861-3867`).
    #[must_use]
    pub fn admin() -> Self {
        Self {
            user_id: "_admin".into(),
            device_id: "_admin".into(),
            replica_id: "_admin".into(),
            tenant_id: DEFAULT_TENANT_ID.into(),
            scope: PrincipalScope::Admin,
            service_scopes: Vec::new(),
        }
    }

    #[must_use]
    pub fn is_admin(&self) -> bool {
        self.scope == PrincipalScope::Admin
    }

    /// Cheap liveness check (`#isPrincipalActive`): admin, or a tenant id that
    /// is not archived-prefixed. The authoritative archived check hits the
    /// tenants store.
    #[must_use]
    pub fn is_active_cheap(&self) -> bool {
        self.is_admin() || !self.tenant_id.starts_with(ARCHIVED_TENANT_PREFIX)
    }

    /// The NUL-separated connection key (`#principalConnectionKey`,
    /// `src/sync/gateway.ts:554`): `tenantId\0userId`. The NUL separator
    /// prevents ids containing other delimiters from colliding.
    #[must_use]
    pub fn connection_key(&self) -> String {
        format!("{}\0{}", self.tenant_id, self.user_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_key_uses_nul_separator() {
        let principal = Principal {
            user_id: "user-1".into(),
            device_id: "d".into(),
            replica_id: "r".into(),
            tenant_id: "tenant-1".into(),
            scope: PrincipalScope::Tenant,
            service_scopes: Vec::new(),
        };
        assert_eq!(principal.connection_key(), "tenant-1\0user-1");
    }

    #[test]
    fn admin_is_always_active() {
        assert!(Principal::admin().is_active_cheap());
    }

    #[test]
    fn archived_tenant_is_inactive_cheap() {
        let principal = Principal {
            user_id: "u".into(),
            device_id: "d".into(),
            replica_id: "r".into(),
            tenant_id: "_archived_tenant-1".into(),
            scope: PrincipalScope::Tenant,
            service_scopes: Vec::new(),
        };
        assert!(!principal.is_active_cheap());
    }
}
