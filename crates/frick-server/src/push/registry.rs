//! Push-adapter trait + registry (map 06 §3.5; `apps/server/src/push/registry.ts`).
//!
//! Adapters register at boot keyed by [`PushPlatform`]; resolution is by the
//! platform wire literal. Registering a second adapter for a platform is a hard
//! error ([`DuplicatePushAdapterError`]) — silently shadowing an adapter
//! mis-routes real notifications, so a boot crash is preferred. [`list`] returns
//! adapters sorted by platform wire literal.
//!
//! [`list`]: PushRegistry::list

use std::collections::HashMap;
use std::sync::Arc;

use super::types::{
    FrickNotificationContext, FrickNotificationIntent, FrickPushDelivery, PushDeviceRegistration,
    PushPlatform,
};

/// A pluggable platform adapter (TS `FrickPushAdapter`, types.ts:90-97). The
/// router groups registrations by [`PushPlatform`] and dispatches each to the
/// matching adapter.
///
/// `send` MUST be idempotent on `(intent, registration)` — the job framework
/// re-runs failed jobs and a partial delivery must not multiply notifications.
/// It should be defensive: the router converts a returned `Err` into a
/// synthetic `failed` delivery with `error.code = "adapter.threw"`, so an
/// adapter bug can't tear down the worker.
pub trait PushAdapter: Send + Sync {
    /// The platform this adapter serves.
    fn platform(&self) -> PushPlatform;

    /// Deliver one intent to one registration. Returns the per-attempt outcome
    /// on `Ok`, or an error string (→ `adapter.threw`) on `Err`. Boxed future
    /// so the trait is object-safe and dispatchable from a `'static` worker.
    fn send<'a>(
        &'a self,
        intent: &'a FrickNotificationIntent,
        registration: &'a PushDeviceRegistration,
        ctx: &'a FrickNotificationContext<'a>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<FrickPushDelivery, String>> + Send + 'a>,
    >;

    /// Release any adapter-held resources at server shutdown (TS adapters with a
    /// `close()`, e.g. the APNs HTTP/2 sessions). Default no-op.
    fn close<'a>(&'a self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        Box::pin(async {})
    }
}

/// A shareable adapter.
pub type SharedPushAdapter = Arc<dyn PushAdapter>;

/// Raised when a second adapter is registered for a platform (TS
/// `DuplicatePushAdapterError`, registry.ts:18-24). Same message + `reason` so
/// boot diagnostics match.
#[derive(Debug, Clone, thiserror::Error)]
#[error("A push adapter is already registered for platform \"{platform}\"")]
pub struct DuplicatePushAdapterError {
    /// The duplicate platform wire literal.
    pub platform: String,
}

impl DuplicatePushAdapterError {
    /// Stable machine-readable reason (TS `reason = "duplicatePushAdapter"`).
    #[must_use]
    pub const fn reason(&self) -> &'static str {
        "duplicatePushAdapter"
    }
}

/// Adapter registry (TS `FrickPushRegistry`, registry.ts:12-44). Keyed by the
/// platform wire literal.
#[derive(Default)]
pub struct PushRegistry {
    adapters: HashMap<&'static str, SharedPushAdapter>,
}

impl PushRegistry {
    /// An empty registry.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// `registerAdapter` (registry.ts:29-34): register `adapter`, erroring on a
    /// duplicate platform.
    pub fn register_adapter(
        &mut self,
        adapter: SharedPushAdapter,
    ) -> Result<(), DuplicatePushAdapterError> {
        let platform = adapter.platform();
        let key = platform.as_str();
        if self.adapters.contains_key(key) {
            return Err(DuplicatePushAdapterError {
                platform: platform.as_str().to_string(),
            });
        }
        self.adapters.insert(key, adapter);
        Ok(())
    }

    /// `resolveAdapter` (registry.ts:35-37): the adapter for a platform wire
    /// literal, or `None`. The router treats `None` as a `skipped` delivery.
    #[must_use]
    pub fn resolve_adapter(&self, platform: &str) -> Option<SharedPushAdapter> {
        self.adapters.get(platform).map(Arc::clone)
    }

    /// `resolveAdapter` by the typed platform.
    #[must_use]
    pub fn resolve(&self, platform: PushPlatform) -> Option<SharedPushAdapter> {
        self.resolve_adapter(platform.as_str())
    }

    /// `list` (registry.ts:38-42): adapters sorted by platform wire literal
    /// (`localeCompare`; ASCII byte order is identical for the platform set).
    #[must_use]
    pub fn list(&self) -> Vec<SharedPushAdapter> {
        let mut entries: Vec<(&'static str, SharedPushAdapter)> = self
            .adapters
            .iter()
            .map(|(k, v)| (*k, Arc::clone(v)))
            .collect();
        entries.sort_by(|a, b| a.0.cmp(b.0));
        entries.into_iter().map(|(_, v)| v).collect()
    }

    /// Whether an adapter is registered for `platform`.
    #[must_use]
    pub fn contains(&self, platform: PushPlatform) -> bool {
        self.adapters.contains_key(platform.as_str())
    }

    /// Close every adapter at shutdown (TS `server.ts:2840-2848`). Failures in
    /// one adapter's `close` don't stop the rest.
    pub async fn close_all(&self) {
        for adapter in self.list() {
            adapter.close().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::push::test_adapter::TestPushAdapter;

    struct ApnsStub;
    impl PushAdapter for ApnsStub {
        fn platform(&self) -> PushPlatform {
            PushPlatform::Apns
        }
        fn send<'a>(
            &'a self,
            _intent: &'a FrickNotificationIntent,
            _registration: &'a PushDeviceRegistration,
            _ctx: &'a FrickNotificationContext<'a>,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<FrickPushDelivery, String>> + Send + 'a>,
        > {
            Box::pin(async { Err("stub".to_string()) })
        }
    }

    #[test]
    fn register_resolve_and_duplicate() {
        let mut registry = PushRegistry::new();
        registry
            .register_adapter(Arc::new(TestPushAdapter::new()))
            .unwrap();
        registry.register_adapter(Arc::new(ApnsStub)).unwrap();

        assert!(registry.resolve(PushPlatform::Test).is_some());
        assert!(registry.resolve(PushPlatform::Apns).is_some());
        assert!(registry.resolve(PushPlatform::Fcm).is_none());

        // Duplicate platform → error with the TS message + reason.
        let err = registry.register_adapter(Arc::new(ApnsStub)).unwrap_err();
        assert_eq!(err.platform, "apns");
        assert_eq!(err.reason(), "duplicatePushAdapter");
        assert_eq!(
            err.to_string(),
            "A push adapter is already registered for platform \"apns\""
        );
    }

    #[test]
    fn list_is_sorted_by_platform() {
        let mut registry = PushRegistry::new();
        registry.register_adapter(Arc::new(ApnsStub)).unwrap();
        registry
            .register_adapter(Arc::new(TestPushAdapter::new()))
            .unwrap();
        let platforms: Vec<&str> = registry
            .list()
            .iter()
            .map(|a| a.platform().as_str())
            .collect();
        // "apns" < "test" lexicographically.
        assert_eq!(platforms, ["apns", "test"]);
    }
}
