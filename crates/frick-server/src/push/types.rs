//! Core push types (map 06 §3.1; `apps/server/src/push/types.ts`).
//!
//! A [`FrickNotificationIntent`] is the privacy-safe, already-translated
//! description of "what should be delivered to whom". Apps construct intents and
//! hand them to the [`NotificationRouter`](crate::push::router::NotificationRouter);
//! the router resolves recipient devices, groups by platform, and delegates
//! physical delivery to a [`PushAdapter`](crate::push::registry::PushAdapter),
//! which returns one [`FrickPushDelivery`].

use std::collections::BTreeSet;

use frick_protocol::Value;
pub use frick_store::stores::push_registration::{
    PushDeviceRegistration, PushEnvironment, PushPlatform,
};

/// `FrickNotificationIntent.body` (types.ts:46-50): the user-visible alert text
/// plus structured `data`. All three fields are optional. `data` is a msgpack
/// map ([`Value::Map`]); the adapters hoist / stringify its entries per platform
/// (§3.7 / §3.8). An empty/`None` body is allowed (a data-only or wake-up push).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NotificationBody {
    /// Alert title (`body.title`), or `None`.
    pub title: Option<String>,
    /// Alert body (`body.body`), or `None`.
    pub body: Option<String>,
    /// Structured custom payload (`body.data`) — a msgpack map, or `None`.
    pub data: Option<Value>,
}

/// `FrickNotificationIntent` (types.ts:42-53): a privacy-safe, already-translated
/// description of a notification to send.
///
/// `intent` is a stable semantic id (convention `"<noun>.<verb>"`, e.g.
/// `"message.new"`). `recipient_user_ids` is an explicit list for v1 (broadcast
/// is out of scope). Keep `body.data` small and non-sensitive — the adapter caps
/// it (APNs ~4 KB).
#[derive(Debug, Clone, PartialEq)]
pub struct FrickNotificationIntent {
    /// Stable semantic identifier (`intent`).
    pub intent: String,
    /// Tenant the intent belongs to (`tenantId`).
    pub tenant_id: String,
    /// Explicit recipient user ids (`recipientUserIds`).
    pub recipient_user_ids: Vec<String>,
    /// Alert + structured payload (`body`).
    pub body: NotificationBody,
    /// Optional grouping id (`threadId`).
    pub thread_id: Option<String>,
    /// Optional deep link (`deepLink`).
    pub deep_link: Option<String>,
}

/// Outcome of one delivery attempt for one `(intent, registration)` pair
/// (types.ts:72-78). Wire literals: `"delivered" | "failed" | "skipped"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushDeliveryStatus {
    /// Adapter handed the payload off to the platform.
    Delivered,
    /// Adapter rejected the registration; `error` is populated.
    Failed,
    /// No adapter registered for the platform, or the adapter declined for a
    /// non-error reason (e.g. missing credentials, environment mismatch).
    Skipped,
}

impl PushDeliveryStatus {
    /// The wire literal (`status` field of the serialized delivery).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Delivered => "delivered",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
        }
    }
}

/// `{ code, message }` carried by a failed/skipped delivery (types.ts:76).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushDeliveryError {
    /// Stable machine code (e.g. `push.unregistered`, `adapter.threw`).
    pub code: String,
    /// Human-readable detail.
    pub message: String,
}

/// `FrickPushDelivery` (types.ts:72-78): the result the router accumulates into
/// the job result so operators can read back exactly what landed where.
#[derive(Debug, Clone, PartialEq)]
pub struct FrickPushDelivery {
    /// The registration this attempt targeted.
    pub registration: PushDeviceRegistration,
    /// ISO-8601 timestamp of the attempt (`attemptedAt`).
    pub attempted_at: String,
    /// Delivery outcome.
    pub status: PushDeliveryStatus,
    /// Populated on `failed`/`skipped` (`error`).
    pub error: Option<PushDeliveryError>,
    /// Platform receipt id when present (`receiptId`).
    pub receipt_id: Option<String>,
}

impl FrickPushDelivery {
    /// A `delivered` outcome with an optional receipt id.
    #[must_use]
    pub fn delivered(
        registration: PushDeviceRegistration,
        attempted_at: String,
        receipt_id: Option<String>,
    ) -> Self {
        Self {
            registration,
            attempted_at,
            status: PushDeliveryStatus::Delivered,
            error: None,
            receipt_id,
        }
    }

    /// A `failed` outcome carrying an error.
    #[must_use]
    pub fn failed(
        registration: PushDeviceRegistration,
        attempted_at: String,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            registration,
            attempted_at,
            status: PushDeliveryStatus::Failed,
            error: Some(PushDeliveryError {
                code: code.into(),
                message: message.into(),
            }),
            receipt_id: None,
        }
    }

    /// A `skipped` outcome carrying an error/reason.
    #[must_use]
    pub fn skipped(
        registration: PushDeviceRegistration,
        attempted_at: String,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            registration,
            attempted_at,
            status: PushDeliveryStatus::Skipped,
            error: Some(PushDeliveryError {
                code: code.into(),
                message: message.into(),
            }),
            receipt_id: None,
        }
    }
}

/// Context handed to a [`PushAdapter::send`](crate::push::registry::PushAdapter::send)
/// call (TS `FrickNotificationContext`, types.ts:55-60). The adapter reads the
/// tenant id (to load per-tenant credentials) and the shared store handle. The
/// TS `logger` child fields are not modelled — adapters log via `tracing`.
pub struct FrickNotificationContext<'a> {
    /// Tenant the intent belongs to (the adapter loads its credentials).
    pub tenant_id: &'a str,
    /// The intent being delivered.
    pub intent: &'a FrickNotificationIntent,
    /// Shared store handle (adapters read `tenant_settings` for credentials).
    pub store: &'a frick_store::FrickStore,
}

/// `PUSH_REVOCATION_ERROR_CODES` (types.ts:108-112): codes that signal a dead
/// device token. The router revokes the registration on a `failed` delivery
/// carrying one of these.
#[must_use]
pub fn push_revocation_error_codes() -> BTreeSet<&'static str> {
    PUSH_REVOCATION_ERROR_CODES.iter().copied().collect()
}

/// The revocation-error-code set, in TS declaration order (types.ts:108-112).
pub const PUSH_REVOCATION_ERROR_CODES: [&str; 3] = [
    "push.badDeviceToken",
    "push.unregistered",
    "push.tokenExpired",
];

/// `isPushRevocationError` (types.ts:114-116): whether `code` is one of the
/// revocation codes (and so should tombstone the registration).
#[must_use]
pub fn is_push_revocation_error(code: Option<&str>) -> bool {
    matches!(code, Some(c) if PUSH_REVOCATION_ERROR_CODES.contains(&c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revocation_codes_match_ts_set() {
        assert!(is_push_revocation_error(Some("push.badDeviceToken")));
        assert!(is_push_revocation_error(Some("push.unregistered")));
        assert!(is_push_revocation_error(Some("push.tokenExpired")));
        assert!(!is_push_revocation_error(Some("push.deliveryFailed")));
        assert!(!is_push_revocation_error(Some("adapter.threw")));
        assert!(!is_push_revocation_error(None));
        // The helper set carries the same three codes.
        assert_eq!(push_revocation_error_codes().len(), 3);
    }

    #[test]
    fn status_wire_literals() {
        assert_eq!(PushDeliveryStatus::Delivered.as_str(), "delivered");
        assert_eq!(PushDeliveryStatus::Failed.as_str(), "failed");
        assert_eq!(PushDeliveryStatus::Skipped.as_str(), "skipped");
    }
}
