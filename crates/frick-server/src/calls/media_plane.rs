//! FR-78 / FR-281 — the media-plane boundary.
//!
//! Frick owns call **state + signaling**; the media plane brokers the actual
//! **media** (peer-to-peer, or a server-side SFU). The call control plane
//! (FR-79 / FR-283) only ever calls the methods on [`MediaPlaneAdapter`], so the
//! same interface fits both the deterministic [`FakeMediaPlaneAdapter`] used by
//! tests and a real SFU backend (FR-287/FR-288) without the control plane caring
//! which topology is underneath.
//!
//! The realized boundary is intentionally slightly broader than a four-method
//! sketch so it spans both P2P and SFU futures: `describe()` returns static
//! [`MediaPlaneCapabilities`]; `allocate_session` is idempotent per call id;
//! `issue_join_token` mints a per-participant short-lived [`MediaJoinGrant`];
//! `release_session` is idempotent. The methods are object-safe + async via
//! boxed futures (the push-adapter convention), so a real async-I/O backend
//! slots in behind the same `Arc<dyn MediaPlaneAdapter>`.

use std::future::Future;
use std::pin::Pin;

use indexmap::IndexMap;

/// Which transport an adapter brokers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaPlaneTransport {
    P2p,
    Sfu,
}

impl MediaPlaneTransport {
    /// The wire spelling (`"p2p"` / `"sfu"`) the control plane stamps onto a
    /// `CallRoomRecord.transport`.
    #[must_use]
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::P2p => "p2p",
            Self::Sfu => "sfu",
        }
    }
}

/// Static description of an adapter's capabilities.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaPlaneCapabilities {
    /// Which transport this adapter brokers.
    pub transport: MediaPlaneTransport,
    /// Hard cap on participants a single session supports, or `None` for no
    /// fixed cap (an SFU bounded only by capacity). A P2P adapter reports `2`.
    pub max_participants: Option<u32>,
    /// True when the adapter can place rooms in a caller-hinted region.
    pub supports_region_hint: bool,
}

/// A participant the media plane issues credentials for.
#[derive(Debug, Clone)]
pub struct MediaParticipant {
    pub user_id: String,
    pub device_id: String,
}

/// Handle to a media room/session allocated for a call. `transport` lets the
/// control plane (and clients, indirectly) know which concrete topology owns it;
/// `region` echoes back where it was placed when a hint was honored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaSession {
    pub call_id: String,
    /// Opaque, adapter-assigned room/session id (e.g. an SFU room name).
    pub media_session_id: String,
    pub transport: MediaPlaneTransport,
    pub region: Option<String>,
    /// Adapter-specific connection metadata a client needs *before* it has a
    /// per-participant token (e.g. an SFU's signaling URL). Kept opaque so the
    /// control plane forwards it without interpreting it.
    pub connection: Option<IndexMap<String, String>>,
}

/// A short-lived credential a participant presents to the media plane to join.
/// `token` is the bearer credential (SFU access token, or a serialized TURN
/// credential set for P2P); `expires_at` is an ISO-8601 instant after which it
/// must be refreshed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaJoinGrant {
    pub call_id: String,
    pub media_session_id: String,
    pub user_id: String,
    pub device_id: String,
    pub token: String,
    pub expires_at: String,
    /// Optional connection metadata scoped to this grant (e.g. ICE servers /
    /// TURN URLs for a P2P adapter). Opaque to the control plane.
    pub connection: Option<IndexMap<String, String>>,
}

/// Options for [`MediaPlaneAdapter::allocate_session`].
#[derive(Debug, Clone, Default)]
pub struct AllocateSessionOptions {
    /// Preferred region for the media room; honored only if supported.
    pub region_hint: Option<String>,
    /// Upper bound on expected participants, for capacity planning.
    pub expected_participants: Option<u32>,
}

/// Options for [`MediaPlaneAdapter::issue_join_token`].
#[derive(Debug, Clone, Default)]
pub struct IssueJoinTokenOptions {
    /// Requested credential lifetime in ms. The adapter may clamp it.
    pub ttl_ms: Option<i64>,
}

/// Raised by an adapter when an operation can't be honored.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{0}")]
pub struct MediaPlaneError(pub String);

/// Boxed future alias keeping the trait object-safe (cf. `PushAdapter`).
pub type MediaPlaneFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The media-plane boundary (FR-78). Implementations broker real media; the
/// control plane only ever calls these methods plus [`describe`].
///
/// [`describe`]: MediaPlaneAdapter::describe
pub trait MediaPlaneAdapter: Send + Sync {
    /// Static capabilities; safe to call without allocating anything.
    fn describe(&self) -> MediaPlaneCapabilities;

    /// Reserve a media room/session for `call_id`. Idempotent per call id:
    /// calling twice for the same live call returns the same [`MediaSession`]
    /// rather than provisioning a second room.
    fn allocate_session<'a>(
        &'a self,
        call_id: &'a str,
        options: AllocateSessionOptions,
    ) -> MediaPlaneFuture<'a, Result<MediaSession, MediaPlaneError>>;

    /// Mint a participant-scoped join credential for an already-allocated
    /// session. `now_ms` is the control plane's clock (the determinism seam's
    /// time boundary), used to stamp `expires_at`. Returns [`MediaPlaneError`]
    /// if no session is allocated for `call_id` (the control plane always
    /// allocates before inviting/joining).
    fn issue_join_token<'a>(
        &'a self,
        call_id: &'a str,
        participant: MediaParticipant,
        now_ms: i64,
        options: IssueJoinTokenOptions,
    ) -> MediaPlaneFuture<'a, Result<MediaJoinGrant, MediaPlaneError>>;

    /// Tear down the media room for `call_id`. Idempotent: releasing an unknown
    /// or already-released call is a no-op (so a duplicated `end` is safe).
    fn release_session<'a>(&'a self, call_id: &'a str) -> MediaPlaneFuture<'a, ()>;
}
