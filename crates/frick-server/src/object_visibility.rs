//! Per-record object read visibility (FR-116 / FR-235 / FR-234).
//!
//! Object list, subscription snapshot, and live delta fan-out are scoped per
//! reader: a subscriber sees their own rows, rows of types that declare no
//! owner, rows whose owner value is absent (fail-open for migrated data), and
//! rows they hold an active sharing grant on. This ports the deleted TS
//! gateway's `isObjectVisibleToUser` / `canPrincipalReadObjectRow` /
//! `#subscriberCanReadObject` pipeline. Tenant + app scoping is enforced by the
//! callers' storage lookups; this layer adds only the ownership baseline and
//! the sharing-grant relaxation (the Rust server has no policy hooks yet —
//! FR-245).

use frick_protocol::Value;
use frick_protocol::schema::{FieldKind, FrickSchema, object_by_name};
use frick_store::FrickStore;

use crate::authz::{
    Action, Decision, PolicyHooks, PolicyInput, PolicyResource, apply_policy_hooks,
};
use crate::principal::Principal;

/// The conventional owner field (`ownerUserId`): a `string` field with this
/// name makes its type owner-scoped unless the deployment opts out of owner
/// scoping. Mirrors the TS `CONVENTIONAL_OWNER_FIELD`.
pub const CONVENTIONAL_OWNER_FIELD: &str = "ownerUserId";

/// Server-wide object read visibility (`FRICK_OBJECT_VISIBILITY`). The default
/// is owner-scoped; a deployment that genuinely wants tenant-wide reads opts
/// out explicitly (mirrors the TS `objectVisibility.mode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ObjectVisibilityMode {
    /// Owner-field-bearing types are scoped to their owner (the default).
    #[default]
    OwnerScoped,
    /// Every in-tenant row is visible to every tenant member (legacy opt-out).
    TenantWide,
}

impl ObjectVisibilityMode {
    /// Parse the `FRICK_OBJECT_VISIBILITY` value; `None` for an unrecognized
    /// string (the caller rejects it at boot).
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "ownerScoped" | "owner_scoped" | "owner-scoped" => Some(Self::OwnerScoped),
            "tenantWide" | "tenant_wide" | "tenant-wide" => Some(Self::TenantWide),
            _ => None,
        }
    }

    /// The canonical wire string.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OwnerScoped => "ownerScoped",
            Self::TenantWide => "tenantWide",
        }
    }
}

/// Resolve the owner field for `object_type` — the `ownerUserId` string-field
/// convention. Returns `None` when the type declares no owner concept (so it is
/// tenant-visible), or when the type is unknown.
#[must_use]
pub fn owner_field_for_type<'a>(schema: &'a FrickSchema, object_type: &str) -> Option<&'a str> {
    let object = object_by_name(schema, object_type).ok()?;
    object
        .fields
        .iter()
        .find(|field| field.name == CONVENTIONAL_OWNER_FIELD && field.kind == FieldKind::String)
        .map(|field| field.name.as_str())
}

/// Read a string field from an object map, if present.
fn object_field_str<'a>(object: &'a Value, field: &str) -> Option<&'a str> {
    object.as_map().and_then(|entries| {
        entries
            .iter()
            .find(|(key, _)| key.as_str() == Some(field))
            .and_then(|(_, value)| value.as_str())
    })
}

/// The record id of an object row (its `id` field), if a string.
#[must_use]
pub fn object_record_id(object: &Value) -> Option<&str> {
    object_field_str(object, "id")
}

/// FR-235 ownership baseline (the store's `isObjectVisibleToUser`). Visible for:
/// tenant-wide mode; a type with no owner field; a row whose owner value is
/// absent/empty (fail-open for rows written before owner scoping — FR-234);
/// otherwise the owner value must equal the reader. This is the *baseline* only
/// — admin bypass and sharing-grant relaxation layer on top in
/// [`subscriber_can_read_object`], so a `false` here is not final for a grantee.
#[must_use]
pub fn is_object_visible_to_user(
    mode: ObjectVisibilityMode,
    owner_field: Option<&str>,
    object: &Value,
    user_id: &str,
) -> bool {
    if mode == ObjectVisibilityMode::TenantWide {
        return true;
    }
    let Some(field) = owner_field else {
        // No owner concept declared for this type — tenant-visible.
        return true;
    };
    match object_field_str(object, field) {
        Some(owner) if !owner.is_empty() => owner == user_id,
        // Fail-open for rows that predate owner scoping (no owner value): a
        // migrated database must keep serving — and fanning out — its rows.
        _ => true,
    }
}

/// `true` when per-record grant evaluation can change the row set a subscriber
/// sees — i.e. a sharing grant has ever been issued. When `false`, the snapshot
/// / fan-out / list paths skip per-row grant lookups and the ownership baseline
/// is final, at zero per-row SQL cost (a single `EXISTS` probe). The Rust
/// server has no policy hooks (FR-245), so grants are the only relaxation.
pub async fn per_record_read_authz_active(store: &FrickStore) -> bool {
    !store.grants().is_empty_async().await.unwrap_or(false)
}

/// Per-record read visibility for one subscriber, using the same authz the HTTP
/// object read path applies (FR-235 / FR-116): the ownership baseline, then
/// sharing-grant relaxation. Admin principals bypass the baseline. When
/// `writer_user_id` matches the reader, the baseline always passes so a write's
/// own echo is never suppressed by owner-field state (FR-234). Tenant + app
/// scoping is the caller's responsibility.
#[allow(clippy::too_many_arguments)] // the full read pipeline's inputs
pub async fn subscriber_can_read_object(
    store: &FrickStore,
    mode: ObjectVisibilityMode,
    owner_field: Option<&str>,
    principal: &Principal,
    object_type: &str,
    object: &Value,
    per_record_active: bool,
    writer_user_id: Option<&str>,
) -> bool {
    let baseline = writer_user_id == Some(principal.user_id.as_str())
        || is_object_visible_to_user(mode, owner_field, object, &principal.user_id);
    let visible = principal.is_admin() || baseline;
    if visible {
        return true;
    }
    if !per_record_active {
        return false;
    }
    // Owner mismatch with grants live: an active read-satisfying grant on this
    // exact record flips the deny to allow (`relaxWithGrants`).
    let Some(id) = object_record_id(object) else {
        return false;
    };
    store
        .grants()
        .has_active_grant_for(
            &principal.tenant_id,
            &principal.user_id,
            object_type,
            id,
            "read",
        )
        .await
        .unwrap_or(false)
}

/// Per-record read visibility, additionally gated by app policy hooks
/// (FR-296). Used by the `GET /objects` LIST route (`routes/objects.rs`),
/// where a hook can tighten a whole object TYPE (e.g. "role X may not read
/// `Invoice`"). Pipeline per row, mirroring the single-resource write pipeline
/// (`authz.rs:3-9`): ownership/admin baseline → app policy hooks → sharing
/// grant relaxation. A hook denying the type still lets through exactly the
/// rows the caller holds an active read-satisfying grant on — the grant check
/// re-runs even after a hook deny, so a coarse type-level hook composes with
/// per-record grants rather than overriding them. When `hooks` is empty this
/// is behavior-identical to [`subscriber_can_read_object`] (the hook stage is
/// a no-op per [`apply_policy_hooks`]'s empty-hooks fast path).
#[allow(clippy::too_many_arguments)] // the full read pipeline's inputs
pub async fn subscriber_can_read_object_with_hooks(
    store: &FrickStore,
    hooks: &PolicyHooks,
    mode: ObjectVisibilityMode,
    owner_field: Option<&str>,
    principal: &Principal,
    object_type: &str,
    object: &Value,
    per_record_active: bool,
    writer_user_id: Option<&str>,
) -> bool {
    let owner_baseline = writer_user_id == Some(principal.user_id.as_str())
        || is_object_visible_to_user(mode, owner_field, object, &principal.user_id);
    let admin_or_owner_visible = principal.is_admin() || owner_baseline;

    // The hook stage only ever tightens an allow, so with no hooks registered
    // (or an owner-deny baseline) this reduces to exactly the pre-existing
    // ownership + grant pipeline.
    let baseline_decision = if admin_or_owner_visible {
        Decision::Allow
    } else {
        Decision::Deny {
            reason: crate::authz::DenyReason::OwnerMismatch,
            public_message: "Not the resource owner".to_string(),
        }
    };

    let owner_id = object_field_str(object, owner_field.unwrap_or(CONVENTIONAL_OWNER_FIELD))
        .map(str::to_string);
    let record_id = object_record_id(object).map(str::to_string);
    let decision = apply_policy_hooks(
        baseline_decision,
        &PolicyInput {
            principal,
            action: Action::ObjectRead,
            resource: PolicyResource {
                kind: "object",
                name: Some(object_type.to_string()),
                key: record_id,
                event: None,
                owner_id,
                tenant_id: principal.tenant_id.clone(),
            },
            context: Some(object),
        },
        hooks,
    )
    .await;

    if decision.is_allow() {
        return true;
    }
    if !per_record_active {
        return false;
    }
    // A hook deny (or the original owner-mismatch deny) is still eligible for
    // per-record grant relaxation: an active read-satisfying grant on this
    // exact record flips it back to allow, same as the no-hooks path.
    let Some(id) = object_record_id(object) else {
        return false;
    };
    store
        .grants()
        .has_active_grant_for(
            &principal.tenant_id,
            &principal.user_id,
            object_type,
            id,
            "read",
        )
        .await
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(pairs: &[(&str, &str)]) -> Value {
        Value::Map(
            pairs
                .iter()
                .map(|(k, v)| (Value::from(*k), Value::from(*v)))
                .collect(),
        )
    }

    #[test]
    fn mode_parses_known_values_and_rejects_others() {
        assert_eq!(
            ObjectVisibilityMode::parse("ownerScoped"),
            Some(ObjectVisibilityMode::OwnerScoped)
        );
        assert_eq!(
            ObjectVisibilityMode::parse("tenantWide"),
            Some(ObjectVisibilityMode::TenantWide)
        );
        assert_eq!(ObjectVisibilityMode::parse("nonsense"), None);
        assert_eq!(
            ObjectVisibilityMode::default(),
            ObjectVisibilityMode::OwnerScoped
        );
    }

    #[test]
    fn owner_match_is_visible_owner_mismatch_is_not() {
        let row = obj(&[("id", "r1"), ("ownerUserId", "ada")]);
        assert!(is_object_visible_to_user(
            ObjectVisibilityMode::OwnerScoped,
            Some("ownerUserId"),
            &row,
            "ada",
        ));
        assert!(!is_object_visible_to_user(
            ObjectVisibilityMode::OwnerScoped,
            Some("ownerUserId"),
            &row,
            "grace",
        ));
    }

    #[test]
    fn no_owner_field_is_tenant_visible() {
        let row = obj(&[("id", "r1"), ("title", "shared")]);
        assert!(is_object_visible_to_user(
            ObjectVisibilityMode::OwnerScoped,
            None,
            &row,
            "anyone",
        ));
    }

    #[test]
    fn empty_owner_value_fails_open_for_migrated_rows() {
        let row = obj(&[("id", "r1"), ("ownerUserId", "")]);
        assert!(is_object_visible_to_user(
            ObjectVisibilityMode::OwnerScoped,
            Some("ownerUserId"),
            &row,
            "grace",
        ));
        // A row missing the field entirely also fails open.
        let no_owner = obj(&[("id", "r1")]);
        assert!(is_object_visible_to_user(
            ObjectVisibilityMode::OwnerScoped,
            Some("ownerUserId"),
            &no_owner,
            "grace",
        ));
    }

    #[test]
    fn tenant_wide_mode_ignores_owner() {
        let row = obj(&[("id", "r1"), ("ownerUserId", "ada")]);
        assert!(is_object_visible_to_user(
            ObjectVisibilityMode::TenantWide,
            Some("ownerUserId"),
            &row,
            "grace",
        ));
    }

    #[test]
    fn record_id_reads_the_id_field() {
        let row = obj(&[("id", "r-42"), ("ownerUserId", "ada")]);
        assert_eq!(object_record_id(&row), Some("r-42"));
        assert_eq!(object_record_id(&obj(&[("ownerUserId", "ada")])), None);
    }
}
