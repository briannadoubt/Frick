//! Cross-region federation seam (AURA-323).
//!
//! Frick's cluster bus (FR-114) already replicates writes to peer **nodes**
//! within a deployment for horizontal scale. Cross-**region** federation —
//! routing an object's writes to its home region and replicating to other
//! regions for low-latency reads, with loop-prevention by origin region — is an
//! app-level policy (which region owns which object). This seam hands every
//! locally-originated committed write to app-registered [`FederationHook`]s so
//! the app (e.g. aura-server's `RegionRouter`) can decide whether and where to
//! forward it.
//!
//! Like [`crate::write_side_effects`], hooks run on the **origin path only**
//! (never on writes received from a peer) and must never block or fail the
//! originating write — they observe a borrow of the same event handed to write
//! side-effects. The actual cross-region transport is the app's concern; this
//! is purely the framework hook point. The inbound apply path is deliberately
//! untouched (single emission point, FR-114).

use std::sync::Arc;

use frick_store::FrickStoreWriteEvent;

/// App-registered cross-region federation hook (AURA-323). Invoked once per
/// locally-originated committed write so the app can replicate/forward the
/// event to peer regions per its own routing policy.
pub trait FederationHook: Send + Sync {
    /// Observe a locally-originated committed write. Must not block — spawn any
    /// network forwarding on your own runtime. `event` is the same value handed
    /// to write side-effects.
    fn on_local_write(&self, event: &FrickStoreWriteEvent);
}

/// Shared, ordered set of federation hooks (see [`FederationHook`]).
pub type FederationHooks = Arc<Vec<Arc<dyn FederationHook>>>;

/// A no-op federation hook. Single-region deployments register none; this
/// exists for symmetry and tests.
pub struct NoopFederationHook;

impl FederationHook for NoopFederationHook {
    fn on_local_write(&self, _event: &FrickStoreWriteEvent) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Records the object ids of every event it observes.
    struct RecordingHook {
        seen: Mutex<Vec<String>>,
    }

    fn object_id_of(event: &FrickStoreWriteEvent) -> String {
        match event {
            FrickStoreWriteEvent::ObjectUpsert { object_id, .. }
            | FrickStoreWriteEvent::ObjectDelete { object_id, .. } => object_id.clone(),
            FrickStoreWriteEvent::StreamAppend { event, .. } => event.event.event_id.clone(),
        }
    }

    impl FederationHook for RecordingHook {
        fn on_local_write(&self, event: &FrickStoreWriteEvent) {
            self.seen.lock().unwrap().push(object_id_of(event));
        }
    }

    #[test]
    fn noop_hook_is_inert() {
        let event = FrickStoreWriteEvent::ObjectDelete {
            tenant_id: "t".into(),
            app_id: "_default".into(),
            object_type: "Thing".into(),
            object_id: "obj-1".into(),
        };
        // Must not panic / must accept any event kind.
        NoopFederationHook.on_local_write(&event);
    }

    #[test]
    fn recording_hook_observes_event() {
        let hook = RecordingHook {
            seen: Mutex::new(Vec::new()),
        };
        let event = FrickStoreWriteEvent::ObjectDelete {
            tenant_id: "t".into(),
            app_id: "_default".into(),
            object_type: "Thing".into(),
            object_id: "obj-42".into(),
        };
        hook.on_local_write(&event);
        assert_eq!(hook.seen.lock().unwrap().as_slice(), &["obj-42".to_owned()]);
    }
}
