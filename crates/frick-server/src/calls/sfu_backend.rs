//! FR-287 — `SfuBackend`: Frick's own abstraction over an SFU's room/token
//! lifecycle.
//!
//! This is the boundary the SFU media-plane adapter ([`super::sfu_media_plane`])
//! drives. It is a *Frick-owned* trait — deliberately **not** any particular
//! SFU's types — so that:
//!
//!  1. Nothing on the typecheck/test path ever imports a native SFU SDK. The
//!     gate stays green without it.
//!  2. The real backend (a follow-up, FR-288) is one swappable impl behind
//!     `Arc<dyn SfuBackend>`; the deterministic [`FakeSfuBackend`] powers all
//!     tests here.
//!
//! The port keeps the surface deliberately minimal — the room/token seam the
//! adapter actually needs — rather than the full mediasoup
//! transport/producer/consumer lifecycle of the original `sfu-backend.ts` (that
//! produce/consume companion lands with the control-plane wiring in FR-288):
//!
//! ```text
//! ensure_room(call_id)            -> SfuRoom (idempotent per call id)
//! mint_access_token(...)          -> SfuAccessToken (token + expiry)
//! close_room(call_id)             -> tear the room down (idempotent)
//! ```
//!
//! All methods are async via boxed futures (the same object-safe convention as
//! [`MediaPlaneAdapter`]) so a real backend can do worker/network I/O while the
//! fake resolves synchronously and deterministically.
//!
//! [`MediaPlaneAdapter`]: super::media_plane::MediaPlaneAdapter

use std::future::Future;
use std::pin::Pin;

use indexmap::IndexMap;

use super::media_plane::MediaParticipant;

/// Boxed future alias keeping [`SfuBackend`] object-safe (mirrors
/// [`MediaPlaneFuture`]).
///
/// [`MediaPlaneFuture`]: super::media_plane::MediaPlaneFuture
pub type SfuBackendFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Raised by a backend when an operation references missing state or can't be
/// honored (parity with the TS `SfuBackendError`).
#[derive(Debug, Clone, thiserror::Error)]
#[error("{0}")]
pub struct SfuBackendError(pub String);

/// Handle to a per-call SFU room, plus the signaling/connection metadata a
/// client needs to reach it *before* it has a per-participant token. `connection`
/// is opaque to the control plane (forwarded into [`MediaSession::connection`]).
///
/// [`MediaSession::connection`]: super::media_plane::MediaSession::connection
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SfuRoom {
    /// Opaque, backend-assigned room id (e.g. an SFU room name / router id).
    pub room_id: String,
    /// Signaling / bootstrap metadata (e.g. a signaling URL, announced media
    /// address). Opaque key/value pairs the adapter folds into the session's
    /// connection bundle.
    pub connection: IndexMap<String, String>,
}

/// A minted per-participant access token plus its expiry. `token` is the bearer
/// credential a participant presents to the SFU; `expires_at_ms` is the epoch-ms
/// instant after which it must be refreshed (the adapter renders it to ISO-8601
/// for the grant).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SfuAccessToken {
    pub token: String,
    pub expires_at_ms: i64,
}

/// Options for [`SfuBackend::mint_access_token`].
#[derive(Debug, Clone, Default)]
pub struct MintAccessTokenOptions {
    /// Requested credential lifetime in ms. The backend may clamp it; `None`
    /// means "use the backend default".
    pub ttl_ms: Option<i64>,
}

/// The SFU room/token lifecycle Frick drives. Object-safe + async via boxed
/// futures so a real (network/worker-backed) backend slots in behind
/// `Arc<dyn SfuBackend>` while [`FakeSfuBackend`] powers tests.
pub trait SfuBackend: Send + Sync {
    /// Create the room for `call_id` if absent; **idempotent** — a second call
    /// for a still-live room returns the same [`SfuRoom`] handle rather than
    /// provisioning a second room.
    fn ensure_room<'a>(
        &'a self,
        call_id: &'a str,
    ) -> SfuBackendFuture<'a, Result<SfuRoom, SfuBackendError>>;

    /// Whether a room currently exists for `call_id`.
    fn has_room(&self, call_id: &str) -> bool;

    /// Mint a per-participant access token on `call_id`'s room. `now_ms` is the
    /// caller's clock (the determinism seam's time boundary), used to stamp the
    /// expiry. Returns [`SfuBackendError`] if no room is allocated for `call_id`.
    fn mint_access_token<'a>(
        &'a self,
        call_id: &'a str,
        participant: &'a MediaParticipant,
        now_ms: i64,
        options: MintAccessTokenOptions,
    ) -> SfuBackendFuture<'a, Result<SfuAccessToken, SfuBackendError>>;

    /// Close `call_id`'s room and everything under it. **Idempotent** — closing
    /// an unknown/already-closed room is a no-op.
    fn close_room<'a>(&'a self, call_id: &'a str) -> SfuBackendFuture<'a, ()>;
}

// ---------------------------------------------------------------------------
// FakeSfuBackend
// ---------------------------------------------------------------------------

use std::collections::HashMap;
use std::sync::Mutex;

/// Default per-participant token lifetime, mirroring the TS adapter's 5 minutes.
const DEFAULT_TOKEN_TTL_MS: i64 = 5 * 60 * 1000;

/// Construction options for [`FakeSfuBackend`].
#[derive(Debug, Clone)]
pub struct FakeSfuBackendOptions {
    /// Announced media address advertised in the room's connection bundle
    /// (parity with the TS `announcedIp`). Defaults to `"127.0.0.1"`.
    pub announced_ip: String,
    /// Default token lifetime in ms when a mint call doesn't override it.
    pub default_token_ttl_ms: i64,
}

impl Default for FakeSfuBackendOptions {
    fn default() -> Self {
        Self {
            announced_ip: "127.0.0.1".to_string(),
            default_token_ttl_ms: DEFAULT_TOKEN_TTL_MS,
        }
    }
}

#[derive(Default)]
struct FakeState {
    /// Live rooms keyed by call id, mapped to their deterministic room id. A
    /// closed room drops out of the map.
    rooms: HashMap<String, String>,
    /// Monotonic counter feeding deterministic room ids.
    counter: u64,
    /// Per-(call, participant) mint count so re-issued tokens differ.
    token_counts: HashMap<String, u64>,
}

/// FR-287 — deterministic, no-networking [`SfuBackend`] for tests and local dev.
///
/// Does **no networking** and never touches a real SFU. Room ids and tokens are
/// derived purely from the call id, participant identity, the injected `now_ms`,
/// and a monotonic counter, so the same sequence of calls always yields
/// identical handles — exactly the determinism the adapter tests rely on without
/// standing up a real SFU. State is tracked so idempotency and the
/// "throw without a room" guards behave like a real backend would.
pub struct FakeSfuBackend {
    options: FakeSfuBackendOptions,
    state: Mutex<FakeState>,
}

impl FakeSfuBackend {
    #[must_use]
    pub fn new(options: FakeSfuBackendOptions) -> Self {
        Self {
            options,
            state: Mutex::new(FakeState::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, FakeState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Build the deterministic connection bundle a room advertises.
    fn room_connection(&self, call_id: &str) -> IndexMap<String, String> {
        let mut connection = IndexMap::new();
        connection.insert(
            "signalingUrl".to_string(),
            format!("fake-sfu://media/{call_id}"),
        );
        connection.insert("announcedIp".to_string(), self.options.announced_ip.clone());
        connection
    }
}

impl Default for FakeSfuBackend {
    fn default() -> Self {
        Self::new(FakeSfuBackendOptions::default())
    }
}

impl SfuBackend for FakeSfuBackend {
    fn ensure_room<'a>(
        &'a self,
        call_id: &'a str,
    ) -> SfuBackendFuture<'a, Result<SfuRoom, SfuBackendError>> {
        Box::pin(async move {
            let mut state = self.lock();
            // Idempotent per call id: a second ensure for a still-live room
            // returns the existing handle rather than minting a second room.
            if let Some(existing) = state.rooms.get(call_id) {
                return Ok(SfuRoom {
                    room_id: existing.clone(),
                    connection: self.room_connection(call_id),
                });
            }
            state.counter += 1;
            let ordinal = state.counter;
            let room_id = format!("fake-sfu-room-{call_id}-{ordinal}");
            state.rooms.insert(call_id.to_string(), room_id.clone());
            Ok(SfuRoom {
                room_id,
                connection: self.room_connection(call_id),
            })
        })
    }

    fn has_room(&self, call_id: &str) -> bool {
        self.lock().rooms.contains_key(call_id)
    }

    fn mint_access_token<'a>(
        &'a self,
        call_id: &'a str,
        participant: &'a MediaParticipant,
        now_ms: i64,
        options: MintAccessTokenOptions,
    ) -> SfuBackendFuture<'a, Result<SfuAccessToken, SfuBackendError>> {
        Box::pin(async move {
            let mut state = self.lock();
            let Some(room_id) = state.rooms.get(call_id).cloned() else {
                return Err(SfuBackendError(format!(
                    "Cannot mint an access token: no room allocated for call {call_id}"
                )));
            };
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
            let ttl_ms = options.ttl_ms.unwrap_or(self.options.default_token_ttl_ms);
            let expires_at_ms = now_ms.saturating_add(ttl_ms);
            // Deterministic, coturn-REST-shaped nonce: room-scoped, participant-
            // bound, ordinal-stamped. No HMAC (the fake is not a real credential).
            let token = format!(
                "fake-sfu-token.{room_id}.{}.{}.{token_ordinal}",
                participant.user_id, participant.device_id
            );
            Ok(SfuAccessToken {
                token,
                expires_at_ms,
            })
        })
    }

    fn close_room<'a>(&'a self, call_id: &'a str) -> SfuBackendFuture<'a, ()> {
        Box::pin(async move {
            // Idempotent — closing an unknown/already-closed room is a no-op.
            self.lock().rooms.remove(call_id);
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
    async fn ensure_room_is_idempotent_and_deterministic() {
        let backend = FakeSfuBackend::default();
        let first = backend.ensure_room("call-1").await.expect("ensure");
        let second = backend.ensure_room("call-1").await.expect("ensure again");
        assert_eq!(first, second, "a second ensure returns the same room");
        assert_eq!(first.room_id, "fake-sfu-room-call-1-1");
        assert_eq!(
            first.connection.get("signalingUrl").map(String::as_str),
            Some("fake-sfu://media/call-1")
        );
        assert!(backend.has_room("call-1"));

        // A distinct call gets a distinct, monotonically-numbered room.
        let other = backend.ensure_room("call-2").await.expect("ensure other");
        assert_eq!(other.room_id, "fake-sfu-room-call-2-2");
    }

    #[tokio::test]
    async fn mint_access_token_requires_a_room() {
        let backend = FakeSfuBackend::default();
        let err = backend
            .mint_access_token(
                "missing",
                &participant(),
                0,
                MintAccessTokenOptions::default(),
            )
            .await
            .expect_err("no room allocated");
        assert!(err.to_string().contains("no room allocated"));
    }

    #[tokio::test]
    async fn mint_access_token_is_deterministic_and_ordinal_bumps_per_reissue() {
        let backend = FakeSfuBackend::default();
        backend.ensure_room("call-1").await.expect("ensure");
        let p = participant();
        let first = backend
            .mint_access_token("call-1", &p, 1_000, MintAccessTokenOptions::default())
            .await
            .expect("token");
        assert_eq!(
            first.token,
            "fake-sfu-token.fake-sfu-room-call-1-1.ada.dev-1.1"
        );
        // now_ms (1_000) + default ttl (5 min) → deterministic expiry.
        assert_eq!(first.expires_at_ms, 301_000);

        // Re-issuing for the same participant bumps the ordinal.
        let second = backend
            .mint_access_token("call-1", &p, 1_000, MintAccessTokenOptions::default())
            .await
            .expect("token 2");
        assert_eq!(
            second.token,
            "fake-sfu-token.fake-sfu-room-call-1-1.ada.dev-1.2"
        );

        // A custom ttl is honored.
        let custom = backend
            .mint_access_token(
                "call-1",
                &p,
                1_000,
                MintAccessTokenOptions { ttl_ms: Some(10) },
            )
            .await
            .expect("token 3");
        assert_eq!(custom.expires_at_ms, 1_010);
    }

    #[tokio::test]
    async fn close_room_is_idempotent() {
        let backend = FakeSfuBackend::default();
        backend.ensure_room("call-1").await.expect("ensure");
        assert!(backend.has_room("call-1"));
        backend.close_room("call-1").await;
        assert!(!backend.has_room("call-1"));
        // Closing again (or an unknown call) is a no-op, not an error.
        backend.close_room("call-1").await;
        backend.close_room("never-existed").await;
    }
}
