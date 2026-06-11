//! FR-78 / FR-281 — deterministic, no-networking [`MediaPlaneAdapter`] for tests
//! and local development.
//!
//! Sessions and tokens are derived purely from the call id, participant
//! identity, the control plane's injected `now_ms`, and a monotonic counter, so
//! the same sequence of calls always yields identical ids and tokens. That
//! determinism is what lets the call-lifecycle tests (FR-79 / FR-283) assert
//! exact event payloads without mocking a real SFU.

use std::collections::HashMap;
use std::sync::Mutex;

use indexmap::IndexMap;

use super::media_plane::{
    AllocateSessionOptions, IssueJoinTokenOptions, MediaJoinGrant, MediaParticipant,
    MediaPlaneAdapter, MediaPlaneCapabilities, MediaPlaneError, MediaPlaneFuture,
    MediaPlaneTransport, MediaSession,
};

const DEFAULT_TOKEN_TTL_MS: i64 = 5 * 60 * 1000;

/// Construction options for [`FakeMediaPlaneAdapter`].
#[derive(Debug, Clone, Copy)]
pub struct FakeMediaPlaneOptions {
    /// Transport this fake advertises. Defaults to `Sfu` (no participant cap).
    /// Use `P2p` to exercise the 2-participant capability the control plane
    /// branches on.
    pub transport: MediaPlaneTransport,
    /// Default join-token lifetime in ms. Defaults to 5 minutes.
    pub default_token_ttl_ms: i64,
}

impl Default for FakeMediaPlaneOptions {
    fn default() -> Self {
        Self {
            transport: MediaPlaneTransport::Sfu,
            default_token_ttl_ms: DEFAULT_TOKEN_TTL_MS,
        }
    }
}

#[derive(Clone)]
struct AllocatedSession {
    session: MediaSession,
    /// Monotonic ordinal; reserved for ordering/debugging parity with the TS
    /// fake (the public session never exposes it).
    #[allow(dead_code)]
    ordinal: u64,
}

#[derive(Default)]
struct FakeState {
    /// Live sessions keyed by call id. A released call drops out of the map.
    sessions: HashMap<String, AllocatedSession>,
    /// Monotonic counter feeding deterministic session/token ids.
    counter: u64,
    /// Per-(call, participant) token ordinal so re-issued tokens differ.
    token_counts: HashMap<String, u64>,
}

/// Deterministic in-memory media plane. See the module docs.
pub struct FakeMediaPlaneAdapter {
    transport: MediaPlaneTransport,
    default_token_ttl_ms: i64,
    state: Mutex<FakeState>,
}

impl FakeMediaPlaneAdapter {
    #[must_use]
    pub fn new(options: FakeMediaPlaneOptions) -> Self {
        Self {
            transport: options.transport,
            default_token_ttl_ms: options.default_token_ttl_ms,
            state: Mutex::new(FakeState::default()),
        }
    }

    /// An SFU-shaped fake (no participant cap, honors region hints).
    #[must_use]
    pub fn sfu() -> Self {
        Self::new(FakeMediaPlaneOptions::default())
    }

    /// A P2P-shaped fake (2-participant cap, no region hints).
    #[must_use]
    pub fn p2p() -> Self {
        Self::new(FakeMediaPlaneOptions {
            transport: MediaPlaneTransport::P2p,
            ..FakeMediaPlaneOptions::default()
        })
    }

    /// Test/inspection helper: is a session currently allocated for this call?
    #[must_use]
    pub fn has_session(&self, call_id: &str) -> bool {
        self.lock().sessions.contains_key(call_id)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, FakeState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl MediaPlaneAdapter for FakeMediaPlaneAdapter {
    fn describe(&self) -> MediaPlaneCapabilities {
        match self.transport {
            MediaPlaneTransport::P2p => MediaPlaneCapabilities {
                transport: MediaPlaneTransport::P2p,
                max_participants: Some(2),
                supports_region_hint: false,
            },
            MediaPlaneTransport::Sfu => MediaPlaneCapabilities {
                transport: MediaPlaneTransport::Sfu,
                max_participants: None,
                supports_region_hint: true,
            },
        }
    }

    fn allocate_session<'a>(
        &'a self,
        call_id: &'a str,
        options: AllocateSessionOptions,
    ) -> MediaPlaneFuture<'a, Result<MediaSession, MediaPlaneError>> {
        Box::pin(async move {
            let mut state = self.lock();
            // Idempotent per call id: a second allocate for a still-live call
            // returns the existing room rather than spinning up a second one.
            if let Some(existing) = state.sessions.get(call_id) {
                return Ok(existing.session.clone());
            }
            state.counter += 1;
            let ordinal = state.counter;
            let region = self
                .describe()
                .supports_region_hint
                .then(|| options.region_hint.unwrap_or_else(|| "local".to_string()));
            let mut connection = IndexMap::new();
            connection.insert(
                "signalingUrl".to_string(),
                format!("fake://media/{call_id}"),
            );
            let session = MediaSession {
                call_id: call_id.to_string(),
                media_session_id: format!("fake-room-{call_id}-{ordinal}"),
                transport: self.transport,
                region,
                connection: Some(connection),
            };
            state.sessions.insert(
                call_id.to_string(),
                AllocatedSession {
                    session: session.clone(),
                    ordinal,
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
            let mut state = self.lock();
            let Some(allocated) = state.sessions.get(call_id) else {
                return Err(MediaPlaneError(format!(
                    "Cannot issue a join token: no media session allocated for call {call_id}"
                )));
            };
            let media_session_id = allocated.session.media_session_id.clone();
            let participant_key = format!(
                "{call_id}::{}::{}",
                participant.user_id, participant.device_id
            );
            let token_ordinal = state
                .token_counts
                .get(&participant_key)
                .copied()
                .unwrap_or(0)
                + 1;
            state.token_counts.insert(participant_key, token_ordinal);
            let ttl_ms = options.ttl_ms.unwrap_or(self.default_token_ttl_ms);
            let expires_at = crate::boot::iso_from_epoch_ms(now_ms.saturating_add(ttl_ms));
            let token = format!(
                "fake-token.{media_session_id}.{}.{}.{token_ordinal}",
                participant.user_id, participant.device_id
            );
            let mut connection = IndexMap::new();
            connection.insert("iceServers".to_string(), "fake://turn".to_string());
            Ok(MediaJoinGrant {
                call_id: call_id.to_string(),
                media_session_id,
                user_id: participant.user_id,
                device_id: participant.device_id,
                token,
                expires_at,
                connection: Some(connection),
            })
        })
    }

    fn release_session<'a>(&'a self, call_id: &'a str) -> MediaPlaneFuture<'a, ()> {
        Box::pin(async move {
            // Idempotent — releasing an unknown/already-released call is a no-op.
            self.lock().sessions.remove(call_id);
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn describe_reports_transport_specific_caps() {
        assert_eq!(
            FakeMediaPlaneAdapter::sfu().describe(),
            MediaPlaneCapabilities {
                transport: MediaPlaneTransport::Sfu,
                max_participants: None,
                supports_region_hint: true,
            }
        );
        assert_eq!(
            FakeMediaPlaneAdapter::p2p().describe(),
            MediaPlaneCapabilities {
                transport: MediaPlaneTransport::P2p,
                max_participants: Some(2),
                supports_region_hint: false,
            }
        );
    }

    #[tokio::test]
    async fn allocate_session_is_idempotent_per_call() {
        let plane = FakeMediaPlaneAdapter::sfu();
        let first = plane
            .allocate_session("call-1", AllocateSessionOptions::default())
            .await
            .expect("allocate");
        let second = plane
            .allocate_session("call-1", AllocateSessionOptions::default())
            .await
            .expect("allocate again");
        assert_eq!(first, second, "a second allocate returns the same session");
        assert_eq!(first.media_session_id, "fake-room-call-1-1");
        assert_eq!(first.transport, MediaPlaneTransport::Sfu);
        assert!(plane.has_session("call-1"));

        // A distinct call gets a distinct, monotonically-numbered room.
        let other = plane
            .allocate_session("call-2", AllocateSessionOptions::default())
            .await
            .expect("allocate other");
        assert_eq!(other.media_session_id, "fake-room-call-2-2");
    }

    #[tokio::test]
    async fn allocate_session_honors_region_hint_only_for_sfu() {
        let sfu = FakeMediaPlaneAdapter::sfu();
        let opts = AllocateSessionOptions {
            region_hint: Some("eu-west".to_string()),
            ..AllocateSessionOptions::default()
        };
        let session = sfu
            .allocate_session("c", opts.clone())
            .await
            .expect("alloc");
        assert_eq!(session.region.as_deref(), Some("eu-west"));

        let p2p = FakeMediaPlaneAdapter::p2p();
        let session = p2p.allocate_session("c", opts).await.expect("alloc");
        assert_eq!(session.region, None, "p2p ignores the region hint");
    }

    #[tokio::test]
    async fn issue_join_token_requires_an_allocated_session() {
        let plane = FakeMediaPlaneAdapter::sfu();
        let err = plane
            .issue_join_token(
                "missing",
                MediaParticipant {
                    user_id: "u1".into(),
                    device_id: "d1".into(),
                },
                0,
                IssueJoinTokenOptions::default(),
            )
            .await
            .expect_err("no session allocated");
        assert!(err.to_string().contains("no media session allocated"));
    }

    #[tokio::test]
    async fn issue_join_token_is_deterministic_and_ordinal_bumps_per_reissue() {
        let plane = FakeMediaPlaneAdapter::sfu();
        plane
            .allocate_session("call-1", AllocateSessionOptions::default())
            .await
            .expect("allocate");
        let participant = MediaParticipant {
            user_id: "ada".into(),
            device_id: "dev-1".into(),
        };
        let grant = plane
            .issue_join_token(
                "call-1",
                participant.clone(),
                1_000,
                IssueJoinTokenOptions::default(),
            )
            .await
            .expect("token");
        assert_eq!(grant.token, "fake-token.fake-room-call-1-1.ada.dev-1.1");
        assert_eq!(grant.media_session_id, "fake-room-call-1-1");
        // now_ms (1_000) + default ttl (5 min) → deterministic expiry.
        assert_eq!(grant.expires_at, crate::boot::iso_from_epoch_ms(301_000));

        // Re-issuing for the same participant bumps the ordinal.
        let grant2 = plane
            .issue_join_token(
                "call-1",
                participant,
                1_000,
                IssueJoinTokenOptions::default(),
            )
            .await
            .expect("token 2");
        assert_eq!(grant2.token, "fake-token.fake-room-call-1-1.ada.dev-1.2");
    }

    #[tokio::test]
    async fn release_session_is_idempotent() {
        let plane = FakeMediaPlaneAdapter::sfu();
        plane
            .allocate_session("call-1", AllocateSessionOptions::default())
            .await
            .expect("allocate");
        assert!(plane.has_session("call-1"));
        plane.release_session("call-1").await;
        assert!(!plane.has_session("call-1"));
        // Releasing again (or an unknown call) is a no-op, not an error.
        plane.release_session("call-1").await;
        plane.release_session("never-existed").await;
    }
}
