//! FR-287 — the SFU [`MediaPlaneAdapter`].
//!
//! A sibling of [`FakeMediaPlaneAdapter`]: the call control plane (FR-283)
//! drives it through the exact same four-method seam. Unlike a P2P adapter,
//! media is forwarded by a server-side SFU, so this adapter provisions
//! server-side room/token state through an injected [`SfuBackend`].
//!
//! It is **opt-in** and isolates the concrete SFU behind `Arc<dyn SfuBackend>`,
//! so this adapter and its tests run against the deterministic
//! [`FakeSfuBackend`] without standing up a real SFU. The production backend and
//! the control-plane wiring of SFU media negotiation are a follow-up (FR-288).
//!
//! Capability surface: transport [`Sfu`], `max_participants: None` (an SFU is
//! bounded only by capacity), `supports_region_hint: true`. The four seam
//! methods delegate to the backend (and, for placement, to an injected
//! [`MediaPlacement`], FR-293):
//!  - `allocate_session` ensures the room (idempotent), resolves the call's home
//!    node / region / announced media address via the placement, and caches the
//!    public session so the bootstrap connection metadata is stable;
//!  - `issue_join_token` mints a backend access token for the participant;
//!  - `release_session` closes the room and frees the placement (idempotent).
//!
//! The injected [`MediaPlacement`] is the FR-293 seam that lets the SFU adapter
//! stay single-box ([`LocalMediaPlacement`]) or grow into a bus-coordinated
//! multi-box deployment ([`ClusterMediaPlacement`]) without the adapter changing
//! shape.
//!
//! [`FakeMediaPlaneAdapter`]: super::fake_media_plane::FakeMediaPlaneAdapter
//! [`Sfu`]: super::media_plane::MediaPlaneTransport::Sfu
//! [`MediaPlacement`]: super::media_placement::MediaPlacement
//! [`LocalMediaPlacement`]: super::media_placement::LocalMediaPlacement
//! [`ClusterMediaPlacement`]: super::media_placement::ClusterMediaPlacement

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::media_placement::{LocalMediaPlacement, MediaPlacement};
use super::media_plane::{
    AllocateSessionOptions, IssueJoinTokenOptions, MediaJoinGrant, MediaParticipant,
    MediaPlaneAdapter, MediaPlaneCapabilities, MediaPlaneError, MediaPlaneFuture,
    MediaPlaneTransport, MediaSession,
};
use super::sfu_backend::{FakeSfuBackend, MintAccessTokenOptions, SfuBackend};

/// Cached, allocated session for a call. We keep the public [`MediaSession`] so
/// repeated `allocate_session` calls return byte-stable bootstrap metadata.
#[derive(Clone)]
struct AllocatedSession {
    session: MediaSession,
}

#[derive(Default)]
struct AdapterState {
    /// Live sessions keyed by call id. A released call drops out of the map.
    sessions: HashMap<String, AllocatedSession>,
}

/// FR-287 / FR-293 — the SFU [`MediaPlaneAdapter`]. Holds an `Arc<dyn SfuBackend>`
/// for the room/token lifecycle and an injected `Arc<dyn MediaPlacement>` (FR-293)
/// that resolves each call's home node / region / announced media address. See
/// the module docs.
pub struct SfuMediaPlaneAdapter {
    backend: Arc<dyn SfuBackend>,
    placement: Arc<dyn MediaPlacement>,
    state: Mutex<AdapterState>,
}

impl SfuMediaPlaneAdapter {
    /// Build an adapter over an arbitrary [`SfuBackend`] + media [`MediaPlacement`].
    /// The placement resolves where each call's media lives; pass a
    /// [`LocalMediaPlacement`] for single-box, a [`ClusterMediaPlacement`] for
    /// the bus-coordinated multi-box registry.
    ///
    /// [`ClusterMediaPlacement`]: super::media_placement::ClusterMediaPlacement
    #[must_use]
    pub fn new(backend: Arc<dyn SfuBackend>, placement: Arc<dyn MediaPlacement>) -> Self {
        Self {
            backend,
            placement,
            state: Mutex::new(AdapterState::default()),
        }
    }

    /// Convenience constructor wiring a fresh deterministic [`FakeSfuBackend`]
    /// and a single-box loopback [`LocalMediaPlacement`] (`node "local"`, region
    /// `"local"`, announced IP `127.0.0.1`).
    #[must_use]
    pub fn with_fake_backend() -> Self {
        Self::new(
            Arc::new(FakeSfuBackend::default()),
            Arc::new(LocalMediaPlacement::loopback()),
        )
    }

    /// Test/inspection helper: is a session currently allocated for this call?
    #[must_use]
    pub fn has_session(&self, call_id: &str) -> bool {
        self.lock().sessions.contains_key(call_id)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, AdapterState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl MediaPlaneAdapter for SfuMediaPlaneAdapter {
    fn describe(&self) -> MediaPlaneCapabilities {
        MediaPlaneCapabilities {
            transport: MediaPlaneTransport::Sfu,
            max_participants: None,
            supports_region_hint: true,
        }
    }

    fn allocate_session<'a>(
        &'a self,
        call_id: &'a str,
        options: AllocateSessionOptions,
    ) -> MediaPlaneFuture<'a, Result<MediaSession, MediaPlaneError>> {
        Box::pin(async move {
            // Idempotent per call id: a cached session returns stable bootstrap
            // metadata. We check the cache before touching the backend so a
            // second allocate can't perturb the room handle or region.
            if let Some(existing) = self.lock().sessions.get(call_id) {
                return Ok(existing.session.clone());
            }
            // ensure_room is itself idempotent; this is the first allocate, so it
            // provisions the room.
            let room = self
                .backend
                .ensure_room(call_id)
                .await
                .map_err(|e| MediaPlaneError(e.0))?;
            // FR-293: resolve where this call's media lives (home node / region /
            // announced media address) via the injected placement instead of
            // hardcoding "local". A caller-supplied `region_hint` still takes
            // precedence over the home's region when present (the adapter
            // advertises `supports_region_hint`).
            let home = self.placement.place_for(call_id).await;
            let region = options.region_hint.unwrap_or(home.region);
            let mut connection = room.connection;
            connection.insert("region".to_string(), region.clone());
            connection.insert("homeNodeId".to_string(), home.node_id);
            connection.insert("announcedIp".to_string(), home.announced_ip);
            let session = MediaSession {
                call_id: call_id.to_string(),
                media_session_id: room.room_id,
                transport: MediaPlaneTransport::Sfu,
                region: Some(region),
                connection: Some(connection),
            };
            self.lock().sessions.insert(
                call_id.to_string(),
                AllocatedSession {
                    session: session.clone(),
                },
            );
            Ok(session)
        })
    }

    fn issue_join_token<'a>(
        &'a self,
        call_id: &'a str,
        participant: MediaParticipant,
        now_ms: i64,
        options: IssueJoinTokenOptions,
    ) -> MediaPlaneFuture<'a, Result<MediaJoinGrant, MediaPlaneError>> {
        Box::pin(async move {
            let media_session_id = {
                let state = self.lock();
                let Some(allocated) = state.sessions.get(call_id) else {
                    return Err(MediaPlaneError(format!(
                        "Cannot issue a join token: no media session allocated for call {call_id}"
                    )));
                };
                allocated.session.media_session_id.clone()
            };
            let minted = self
                .backend
                .mint_access_token(
                    call_id,
                    &participant,
                    now_ms,
                    MintAccessTokenOptions {
                        ttl_ms: options.ttl_ms,
                    },
                )
                .await
                .map_err(|e| MediaPlaneError(e.0))?;
            Ok(MediaJoinGrant {
                call_id: call_id.to_string(),
                media_session_id,
                user_id: participant.user_id,
                device_id: participant.device_id,
                token: minted.token,
                expires_at: crate::boot::iso_from_epoch_ms(minted.expires_at_ms),
                connection: None,
            })
        })
    }

    fn release_session<'a>(&'a self, call_id: &'a str) -> MediaPlaneFuture<'a, ()> {
        Box::pin(async move {
            // Idempotent — close_room is a no-op for an unknown call, and
            // dropping the cache entry twice is harmless.
            self.backend.close_room(call_id).await;
            self.lock().sessions.remove(call_id);
            // FR-293: free the call's media placement so a bus-coordinated
            // registry releases the home (and peers evict it). A no-op on a
            // single-box LocalMediaPlacement.
            self.placement.release(call_id).await;
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn participant() -> MediaParticipant {
        MediaParticipant {
            user_id: "ada".into(),
            device_id: "dev-1".into(),
        }
    }

    #[tokio::test]
    async fn describe_reports_sfu_caps() {
        let adapter = SfuMediaPlaneAdapter::with_fake_backend();
        assert_eq!(
            adapter.describe(),
            MediaPlaneCapabilities {
                transport: MediaPlaneTransport::Sfu,
                max_participants: None,
                supports_region_hint: true,
            }
        );
    }

    #[tokio::test]
    async fn allocate_session_ensures_a_room_idempotently() {
        let adapter = SfuMediaPlaneAdapter::with_fake_backend();
        let first = adapter
            .allocate_session("call-1", AllocateSessionOptions::default())
            .await
            .expect("allocate");
        let second = adapter
            .allocate_session("call-1", AllocateSessionOptions::default())
            .await
            .expect("allocate again");
        assert_eq!(first, second, "a second allocate returns the same session");
        assert_eq!(first.media_session_id, "fake-sfu-room-call-1-1");
        assert_eq!(first.transport, MediaPlaneTransport::Sfu);
        assert!(adapter.has_session("call-1"));
        // The room's signaling bootstrap is forwarded into the session.
        assert_eq!(
            first
                .connection
                .as_ref()
                .and_then(|c| c.get("signalingUrl"))
                .map(String::as_str),
            Some("fake-sfu://media/call-1")
        );

        // A distinct call gets a distinct, monotonically-numbered room.
        let other = adapter
            .allocate_session("call-2", AllocateSessionOptions::default())
            .await
            .expect("allocate other");
        assert_eq!(other.media_session_id, "fake-sfu-room-call-2-2");
    }

    #[tokio::test]
    async fn allocate_session_honors_region_hint() {
        let adapter = SfuMediaPlaneAdapter::with_fake_backend();
        let session = adapter
            .allocate_session(
                "call-1",
                AllocateSessionOptions {
                    region_hint: Some("eu-west".to_string()),
                    ..AllocateSessionOptions::default()
                },
            )
            .await
            .expect("allocate");
        assert_eq!(session.region.as_deref(), Some("eu-west"));
        assert_eq!(
            session
                .connection
                .as_ref()
                .and_then(|c| c.get("region"))
                .map(String::as_str),
            Some("eu-west")
        );

        // Absent a hint, the default region is used.
        let default = adapter
            .allocate_session("call-2", AllocateSessionOptions::default())
            .await
            .expect("allocate default");
        assert_eq!(default.region.as_deref(), Some("local"));
    }

    #[tokio::test]
    async fn allocate_session_resolves_region_and_announced_ip_via_placement() {
        // FR-293: with no region hint, the session's region + announced IP come
        // from the injected placement, not the hardcoded "local".
        let placement = Arc::new(LocalMediaPlacement::new(
            Some("node-east".into()),
            Some("us-east".into()),
            "203.0.113.7",
        ));
        let adapter = SfuMediaPlaneAdapter::new(
            Arc::new(FakeSfuBackend::default()),
            placement as Arc<dyn MediaPlacement>,
        );
        let session = adapter
            .allocate_session("call-1", AllocateSessionOptions::default())
            .await
            .expect("allocate");
        assert_eq!(session.region.as_deref(), Some("us-east"));
        let connection = session.connection.as_ref().expect("connection");
        assert_eq!(
            connection.get("region").map(String::as_str),
            Some("us-east")
        );
        assert_eq!(
            connection.get("homeNodeId").map(String::as_str),
            Some("node-east")
        );
        assert_eq!(
            connection.get("announcedIp").map(String::as_str),
            Some("203.0.113.7")
        );

        // A region hint still wins over the placement's home region.
        let hinted = adapter
            .allocate_session(
                "call-2",
                AllocateSessionOptions {
                    region_hint: Some("eu-west".into()),
                    ..AllocateSessionOptions::default()
                },
            )
            .await
            .expect("allocate hinted");
        assert_eq!(hinted.region.as_deref(), Some("eu-west"));
        // The announced IP is still the placement's (the hint only steers region).
        assert_eq!(
            hinted
                .connection
                .as_ref()
                .and_then(|c| c.get("announcedIp"))
                .map(String::as_str),
            Some("203.0.113.7")
        );
    }

    #[tokio::test]
    async fn issue_join_token_requires_an_allocated_session() {
        let adapter = SfuMediaPlaneAdapter::with_fake_backend();
        let err = adapter
            .issue_join_token(
                "missing",
                participant(),
                0,
                IssueJoinTokenOptions::default(),
            )
            .await
            .expect_err("no session allocated");
        assert!(err.to_string().contains("no media session allocated"));
    }

    #[tokio::test]
    async fn issue_join_token_mints_a_deterministic_backend_token() {
        let adapter = SfuMediaPlaneAdapter::with_fake_backend();
        adapter
            .allocate_session("call-1", AllocateSessionOptions::default())
            .await
            .expect("allocate");
        let grant = adapter
            .issue_join_token(
                "call-1",
                participant(),
                1_000,
                IssueJoinTokenOptions::default(),
            )
            .await
            .expect("token");
        assert_eq!(
            grant.token,
            "fake-sfu-token.fake-sfu-room-call-1-1.ada.dev-1.1"
        );
        assert_eq!(grant.media_session_id, "fake-sfu-room-call-1-1");
        assert_eq!(grant.user_id, "ada");
        assert_eq!(grant.device_id, "dev-1");
        // now_ms (1_000) + default ttl (5 min) → deterministic ISO expiry.
        assert_eq!(grant.expires_at, crate::boot::iso_from_epoch_ms(301_000));

        // Re-issuing for the same participant bumps the backend token ordinal.
        let grant2 = adapter
            .issue_join_token(
                "call-1",
                participant(),
                1_000,
                IssueJoinTokenOptions::default(),
            )
            .await
            .expect("token 2");
        assert_eq!(
            grant2.token,
            "fake-sfu-token.fake-sfu-room-call-1-1.ada.dev-1.2"
        );
    }

    #[tokio::test]
    async fn release_session_closes_the_room_idempotently() {
        let adapter = SfuMediaPlaneAdapter::with_fake_backend();
        adapter
            .allocate_session("call-1", AllocateSessionOptions::default())
            .await
            .expect("allocate");
        assert!(adapter.has_session("call-1"));
        adapter.release_session("call-1").await;
        assert!(!adapter.has_session("call-1"));
        // Issuing a token after release fails (the room is gone).
        let err = adapter
            .issue_join_token("call-1", participant(), 0, IssueJoinTokenOptions::default())
            .await
            .expect_err("released");
        assert!(err.to_string().contains("no media session allocated"));
        // Releasing again (or an unknown call) is a no-op, not a panic.
        adapter.release_session("call-1").await;
        adapter.release_session("never-existed").await;
    }
}
