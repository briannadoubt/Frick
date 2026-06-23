//! The authorization decision pipeline (`src/authz.ts`).
//!
//! Order for every decision (`decide`): baseline → app policy hooks
//! (synchronous, run only on allow, first deny wins — tightening-only) →
//! grant relaxation (object.read/write owner denies flip to allow when a
//! matching active grant exists) → cascade grant relaxation
//! (stream.read/projection.read by record id). This module ports the baseline
//! and the decision types; the grant relaxation is applied by the caller,
//! which holds the store.

use crate::principal::{Principal, PrincipalScope};

/// Authorizable actions (`src/authz.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Action {
    ObjectRead,
    ObjectWrite,
    StreamRead,
    StreamAppend,
    PresenceRead,
    PresenceWrite,
    SignalSend,
    SignalRead,
    BlobRead,
    BlobWrite,
    ProjectionRead,
    SearchQuery,
    CallCreate,
}

impl Action {
    /// The dotted wire string for this action.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ObjectRead => "object.read",
            Self::ObjectWrite => "object.write",
            Self::StreamRead => "stream.read",
            Self::StreamAppend => "stream.append",
            Self::PresenceRead => "presence.read",
            Self::PresenceWrite => "presence.write",
            Self::SignalSend => "signal.send",
            Self::SignalRead => "signal.read",
            Self::BlobRead => "blob.read",
            Self::BlobWrite => "blob.write",
            Self::ProjectionRead => "projection.read",
            Self::SearchQuery => "search.query",
            Self::CallCreate => "call.create",
        }
    }
}

/// Deny reasons (`src/authz.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DenyReason {
    Unauthenticated,
    NotAuthorizedForResource,
    NotMember,
    OwnerMismatch,
    SchemaIncompatible,
    TenantMismatch,
}

impl DenyReason {
    /// The wire string for this reason (`details.reason`).
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unauthenticated => "unauthenticated",
            Self::NotAuthorizedForResource => "notAuthorizedForResource",
            Self::NotMember => "notMember",
            Self::OwnerMismatch => "ownerMismatch",
            Self::SchemaIncompatible => "schemaIncompatible",
            Self::TenantMismatch => "tenantMismatch",
        }
    }
}

/// An authorization decision (`AuthorizationDecision` in TS).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Deny {
        reason: DenyReason,
        public_message: String,
    },
}

impl Decision {
    #[must_use]
    pub fn is_allow(&self) -> bool {
        matches!(self, Self::Allow)
    }

    fn deny(reason: DenyReason, message: impl Into<String>) -> Self {
        Self::Deny {
            reason,
            public_message: message.into(),
        }
    }
}

/// The resource a decision is about: which tenant owns it and (for
/// owner-scoped actions) which user.
#[derive(Debug, Clone, Default)]
pub struct ResourceContext {
    pub tenant_id: String,
    /// The resource owner's user id, when the action is owner-scoped
    /// (objects, blobs).
    pub owner_user_id: Option<String>,
}

/// The baseline decision (`decide()` in TS), before policy hooks and grant
/// relaxation. Unauthenticated principals are denied; cross-tenant access is
/// denied unless admin; then per-action baselines apply.
#[must_use]
pub fn decide_baseline(
    principal: &Principal,
    action: Action,
    resource: &ResourceContext,
) -> Decision {
    if principal.user_id.is_empty() {
        return Decision::deny(DenyReason::Unauthenticated, "Not authenticated");
    }

    // Cross-tenant access is denied unless the principal is admin.
    if principal.scope != PrincipalScope::Admin
        && !resource.tenant_id.is_empty()
        && resource.tenant_id != principal.tenant_id
    {
        return Decision::deny(DenyReason::TenantMismatch, "Tenant mismatch");
    }

    match action {
        // Owner-only baselines (relaxable by an active grant downstream).
        Action::ObjectRead | Action::ObjectWrite | Action::BlobRead | Action::BlobWrite => {
            match &resource.owner_user_id {
                Some(owner) if owner == &principal.user_id => Decision::Allow,
                Some(_) => Decision::deny(DenyReason::OwnerMismatch, "Not the resource owner"),
                // No owner recorded (e.g. create intent): allow.
                None => Decision::Allow,
            }
        }
        // Everything else in the switch allows at baseline; unknown actions
        // are not representable here (the enum is closed), matching the TS
        // switch's allow-listed actions.
        _ => Decision::Allow,
    }
}

// ---- app policy hooks (FR-296) ---------------------------------------------

/// The resource a policy hook decides about (`FrickPolicyInput.resource`). The
/// built-in baseline only needs the tenant + owner ([`ResourceContext`]); a hook
/// additionally sees the kind/name/key so it can gate by type (e.g. "role X may
/// not write `Invoice`").
#[derive(Debug, Clone)]
pub struct PolicyResource {
    /// `"object"` | `"stream"` | `"presence"` | `"signal"` | `"blob"` |
    /// `"search"` | `"call"`.
    pub kind: &'static str,
    /// The object type / stream / presence / signal / index name, if any.
    pub name: Option<String>,
    /// The record id / stream key / presence key, if any.
    pub key: Option<String>,
    /// For a `stream.append`, the event type being appended (e.g. `MessageSent`,
    /// `MessagePinned`); `None` for non-stream actions. Lets a hook gate by
    /// event type (e.g. "only admins may append `MessageSent` to a channel").
    pub event: Option<String>,
    /// The resource owner's user id, when known.
    pub owner_id: Option<String>,
    /// The tenant the resource belongs to.
    pub tenant_id: String,
}

/// The input an app policy hook decides on (`FrickPolicyInput`).
pub struct PolicyInput<'a> {
    pub principal: &'a Principal,
    pub action: Action,
    pub resource: PolicyResource,
    /// Action-specific context — e.g. the write payload for an object write, so
    /// a hook can gate on field values.
    pub context: Option<&'a frick_protocol::Value>,
}

/// An app-registered authorization hook (`FrickPolicyHook`). **Tightening-only:**
/// a hook may DENY an action the built-in baseline allowed, but can never grant
/// one the baseline denied. Returns `None` to abstain. Async so a hook can
/// consult the store at decision time (e.g. resolve a company's entitlements
/// via `Membership`). The store and any other state a hook needs are captured
/// when the hook is constructed at boot.
pub trait PolicyHook: Send + Sync {
    fn evaluate<'a>(
        &'a self,
        input: &'a PolicyInput<'a>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Decision>> + Send + 'a>>;
}

/// A shared, registration-ordered list of app policy hooks.
pub type PolicyHooks = std::sync::Arc<Vec<std::sync::Arc<dyn PolicyHook>>>;

/// Apply app policy hooks on top of a baseline decision (`applyPolicyHooks`,
/// extended to async). Hooks run only when the baseline ALLOWS, in registration
/// order; the first DENY wins (tightening-only) — a hook that abstains
/// (`None`) or returns an allow is ignored. Pipeline position mirrors the TS:
/// baseline → hooks → grant relaxation.
pub async fn apply_policy_hooks(
    baseline: Decision,
    input: &PolicyInput<'_>,
    hooks: &[std::sync::Arc<dyn PolicyHook>],
) -> Decision {
    if !baseline.is_allow() || hooks.is_empty() {
        return baseline;
    }
    for hook in hooks {
        if let Some(verdict @ Decision::Deny { .. }) = hook.evaluate(input).await {
            return verdict;
        }
    }
    baseline
}

#[cfg(test)]
mod tests {
    use super::*;

    struct DenyWrites;
    impl PolicyHook for DenyWrites {
        fn evaluate<'a>(
            &'a self,
            input: &'a PolicyInput<'a>,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Decision>> + Send + 'a>>
        {
            Box::pin(async move {
                matches!(input.action, Action::ObjectWrite).then(|| {
                    Decision::deny(DenyReason::NotAuthorizedForResource, "writes are gated")
                })
            })
        }
    }

    fn write_input(principal: &Principal) -> PolicyInput<'_> {
        PolicyInput {
            principal,
            action: Action::ObjectWrite,
            resource: PolicyResource {
                kind: "object",
                name: Some("Invoice".into()),
                key: Some("inv-1".into()),
                event: None,
                owner_id: Some(principal.user_id.clone()),
                tenant_id: principal.tenant_id.clone(),
            },
            context: None,
        }
    }

    #[tokio::test]
    async fn policy_hook_tightens_an_allowed_write() {
        let user = principal("ada", "t", PrincipalScope::Tenant);
        let hooks: Vec<std::sync::Arc<dyn PolicyHook>> = vec![std::sync::Arc::new(DenyWrites)];
        let decided = apply_policy_hooks(Decision::Allow, &write_input(&user), &hooks).await;
        assert!(matches!(
            decided,
            Decision::Deny {
                reason: DenyReason::NotAuthorizedForResource,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn policy_hook_never_relaxes_a_baseline_deny() {
        let user = principal("ada", "t", PrincipalScope::Tenant);
        // Baseline already denied: hooks must not run / flip it to allow.
        let baseline = Decision::deny(DenyReason::OwnerMismatch, "not owner");
        let hooks: Vec<std::sync::Arc<dyn PolicyHook>> = vec![std::sync::Arc::new(DenyWrites)];
        let decided = apply_policy_hooks(baseline, &write_input(&user), &hooks).await;
        assert!(matches!(
            decided,
            Decision::Deny {
                reason: DenyReason::OwnerMismatch,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn no_hooks_leaves_the_baseline_unchanged() {
        let user = principal("ada", "t", PrincipalScope::Tenant);
        let decided = apply_policy_hooks(Decision::Allow, &write_input(&user), &[]).await;
        assert!(decided.is_allow());
    }

    fn principal(user: &str, tenant: &str, scope: PrincipalScope) -> Principal {
        Principal {
            user_id: user.into(),
            device_id: "d".into(),
            replica_id: "r".into(),
            tenant_id: tenant.into(),
            scope,
            service_scopes: Vec::new(),
        }
    }

    #[test]
    fn unauthenticated_is_denied() {
        let anon = principal("", "t", PrincipalScope::Tenant);
        let decision = decide_baseline(&anon, Action::ObjectRead, &ResourceContext::default());
        assert!(matches!(
            decision,
            Decision::Deny {
                reason: DenyReason::Unauthenticated,
                ..
            }
        ));
    }

    #[test]
    fn cross_tenant_denied_unless_admin() {
        let user = principal("u", "tenant-a", PrincipalScope::Tenant);
        let resource = ResourceContext {
            tenant_id: "tenant-b".into(),
            owner_user_id: None,
        };
        assert!(matches!(
            decide_baseline(&user, Action::StreamRead, &resource),
            Decision::Deny {
                reason: DenyReason::TenantMismatch,
                ..
            }
        ));

        let admin = Principal::admin();
        let resource = ResourceContext {
            tenant_id: "tenant-b".into(),
            owner_user_id: None,
        };
        assert!(decide_baseline(&admin, Action::StreamRead, &resource).is_allow());
    }

    #[test]
    fn object_read_is_owner_scoped() {
        let user = principal("owner", "t", PrincipalScope::Tenant);
        let mine = ResourceContext {
            tenant_id: "t".into(),
            owner_user_id: Some("owner".into()),
        };
        assert!(decide_baseline(&user, Action::ObjectRead, &mine).is_allow());

        let theirs = ResourceContext {
            tenant_id: "t".into(),
            owner_user_id: Some("other".into()),
        };
        assert!(matches!(
            decide_baseline(&user, Action::ObjectRead, &theirs),
            Decision::Deny {
                reason: DenyReason::OwnerMismatch,
                ..
            }
        ));
    }

    #[test]
    fn stream_read_allows_at_baseline_within_tenant() {
        let user = principal("u", "t", PrincipalScope::Tenant);
        let resource = ResourceContext {
            tenant_id: "t".into(),
            owner_user_id: None,
        };
        assert!(decide_baseline(&user, Action::StreamRead, &resource).is_allow());
    }
}
