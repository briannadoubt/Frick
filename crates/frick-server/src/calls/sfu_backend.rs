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

use frick_protocol::Value;
use hmac::{Hmac, Mac};
use indexmap::IndexMap;
use sha2::Sha256;

use super::media_plane::MediaParticipant;

/// HMAC-SHA256 over the participant identity + expiry — the coturn-REST-shaped
/// join nonce the SFU media path mints + verifies (parity with the TS
/// `SfuMediaPlaneAdapter` token).
type HmacSha256 = Hmac<Sha256>;

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
// SfuMediaOperations — the produce/consume companion (FR-292)
// ---------------------------------------------------------------------------

/// Media kind a producer/consumer carries (audio / video). The wire enum
/// ([`frick_protocol::calls::CallSfuMediaKind`]) maps onto this; we keep a local
/// copy so the backend stays decoupled from the protocol crate's `Serialize`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Audio,
    Video,
}

impl MediaKind {
    /// The wire spelling (`"audio"` / `"video"`).
    #[must_use]
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Audio => "audio",
            Self::Video => "video",
        }
    }
}

/// A server-side producer minted on a participant's send transport.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProducerHandle {
    pub id: String,
    pub kind: MediaKind,
}

/// A server-side consumer delivering another participant's producer onto this
/// participant's recv transport. `rtp_parameters` is the opaque payload the
/// client needs to wire up the inbound track.
#[derive(Debug, Clone, PartialEq)]
pub struct ConsumerHandle {
    pub id: String,
    pub producer_id: String,
    pub kind: MediaKind,
    pub rtp_parameters: Value,
}

/// The produce/consume companion an SFU media plane exposes alongside the
/// room/token [`SfuBackend`] seam (FR-292 — the Rust port of the TS
/// `SfuMediaOperations`). The control plane forwards a client's media
/// negotiation to these *after* it has confirmed the actor is an active
/// participant of a live, SFU-brokered call.
///
/// Every op is token-gated and ownership-gated: the actor must present a valid
/// join nonce ([`verify_join_token`](Self::verify_join_token)) and may only
/// operate on transports/producers/consumers **it owns** — never another
/// participant's (the FR-170/171 anti-hijack invariant). On `leave`, the control
/// plane calls [`leave_participant`](Self::leave_participant) so the
/// participant's transports/producers/consumers are reclaimed and don't leak
/// (FR-172). Object-safe + async via boxed futures, matching [`SfuBackend`].
pub trait SfuMediaOperations: Send + Sync {
    /// Re-derive the join nonce for `(call_id, actor)` and verify it matches
    /// `token` (constant-time) and has not expired at `now_ms`. Returns
    /// [`SfuBackendError`] on a malformed, forged, or expired token. This is the
    /// credential check the documented contract promised but never enforced
    /// (FR-166 token-1 / FR-170 sfu-media-1): produce/consume/connect require a
    /// valid nonce, so expiry and the `callId:userId:deviceId` binding are
    /// actually enforced.
    fn verify_join_token(
        &self,
        call_id: &str,
        actor: &MediaParticipant,
        token: &str,
        now_ms: i64,
    ) -> Result<(), SfuBackendError>;

    /// Complete a transport's DTLS handshake with the client's `dtls_parameters`.
    /// The actor may only connect a transport **it owns** (its send or recv
    /// transport) — never another participant's (FR-171 sfu-media-2).
    fn connect_transport<'a>(
        &'a self,
        call_id: &'a str,
        actor: &'a MediaParticipant,
        token: &'a str,
        transport_id: &'a str,
        dtls_parameters: Value,
        now_ms: i64,
    ) -> SfuBackendFuture<'a, Result<(), SfuBackendError>>;

    /// Start producing one of the participant's tracks on its **send** transport.
    /// Producing onto another participant's transport — or onto the actor's own
    /// *recv* transport — is rejected (FR-170 sfu-media-1 / FR-171). Returns the
    /// minted producer.
    // The full mediasoup produce signature genuinely needs all of these.
    #[allow(clippy::too_many_arguments)]
    fn produce<'a>(
        &'a self,
        call_id: &'a str,
        actor: &'a MediaParticipant,
        token: &'a str,
        transport_id: &'a str,
        kind: MediaKind,
        rtp_parameters: Value,
        now_ms: i64,
    ) -> SfuBackendFuture<'a, Result<ProducerHandle, SfuBackendError>>;

    /// Consume another participant's `producer_id` onto this participant's
    /// **recv** transport. Steering a consumer onto another participant's recv
    /// transport — or onto the actor's own *send* transport — is rejected
    /// (FR-171 sfu-media-2). Returns the minted consumer.
    // The full mediasoup consume signature genuinely needs all of these.
    #[allow(clippy::too_many_arguments)]
    fn consume<'a>(
        &'a self,
        call_id: &'a str,
        actor: &'a MediaParticipant,
        token: &'a str,
        transport_id: &'a str,
        producer_id: &'a str,
        rtp_capabilities: Value,
        now_ms: i64,
    ) -> SfuBackendFuture<'a, Result<ConsumerHandle, SfuBackendError>>;

    /// Tear down a single participant's media (transports + their producers /
    /// consumers) without ending the whole call — called by the control plane on
    /// `leave` so transports are reclaimed immediately instead of lingering until
    /// the call ends (FR-172 sfu-media-3). **Idempotent**.
    fn leave_participant<'a>(
        &'a self,
        call_id: &'a str,
        participant: &'a MediaParticipant,
    ) -> SfuBackendFuture<'a, ()>;
}

// ---------------------------------------------------------------------------
// FakeSfuBackend
// ---------------------------------------------------------------------------

use std::collections::HashMap;
use std::sync::Mutex;

/// Default per-participant token lifetime, mirroring the TS adapter's 5 minutes.
const DEFAULT_TOKEN_TTL_MS: i64 = 5 * 60 * 1000;

/// The fake's built-in HMAC secret for minting + verifying the join nonce. The
/// fake is not a real credential authority, but the token path is exercised
/// end-to-end (mint → verify, expiry, identity binding) so the security logic is
/// covered. A real backend injects a strong secret.
const DEFAULT_TOKEN_SECRET: &str = "fake-sfu-token-secret-0123456789";

/// Construction options for [`FakeSfuBackend`].
#[derive(Debug, Clone)]
pub struct FakeSfuBackendOptions {
    /// Announced media address advertised in the room's connection bundle
    /// (parity with the TS `announcedIp`). Defaults to `"127.0.0.1"`.
    pub announced_ip: String,
    /// Default token lifetime in ms when a mint call doesn't override it.
    pub default_token_ttl_ms: i64,
    /// HMAC secret backing the join nonce (FR-166). Never sent to clients.
    pub token_secret: String,
}

impl Default for FakeSfuBackendOptions {
    fn default() -> Self {
        Self {
            announced_ip: "127.0.0.1".to_string(),
            default_token_ttl_ms: DEFAULT_TOKEN_TTL_MS,
            token_secret: DEFAULT_TOKEN_SECRET.to_string(),
        }
    }
}

/// The per-participant media resources minted for one `(user_id, device_id)` on
/// a call's room. We bind the send/recv transport ids (and every producer /
/// consumer) to their owner so the control plane can assert a participant only
/// acts on *their own* media (FR-170/171), and so we can reclaim exactly these
/// on leave / re-join without leaking transports (FR-172).
#[derive(Default)]
struct ParticipantMedia {
    send_transport_id: String,
    recv_transport_id: String,
    /// The exact join token issued to this participant at mint time. The
    /// presented token is HMAC-compared (constant-time) against this.
    token: String,
    /// Epoch-ms instant after which the join token is expired.
    expires_at_ms: i64,
    /// Producer ids the participant created on its send transport.
    producer_ids: Vec<String>,
    /// Consumer ids delivered onto the participant's recv transport.
    consumer_ids: Vec<String>,
}

/// Per-call SFU media state: which transports exist (and whether they are DTLS-
/// connected), the producers available to consume, and the per-participant
/// ownership bindings.
#[derive(Default)]
struct RoomMedia {
    /// Transport id -> DTLS-connected flag.
    transports: HashMap<String, bool>,
    /// Producer id -> its kind (so a consumer echoes the producer's kind).
    producers: HashMap<String, MediaKind>,
    /// Consumer ids currently delivered on the room (for leak assertions).
    consumers: std::collections::HashSet<String>,
    /// Per-`"user::device"` media bindings.
    participants: HashMap<String, ParticipantMedia>,
}

#[derive(Default)]
struct FakeState {
    /// Live rooms keyed by call id, mapped to their deterministic room id. A
    /// closed room drops out of the map.
    rooms: HashMap<String, String>,
    /// Per-call media (transports / producers / consumers / ownership). Mirrors
    /// `rooms`: a room's media is created on `ensure_room` and torn down on
    /// `close_room`.
    media: HashMap<String, RoomMedia>,
    /// Monotonic counter feeding deterministic room/transport/producer/consumer
    /// ids.
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

    /// HMAC-SHA256 a token string under the backend's token secret, returning the
    /// raw tag bytes. Used to compare two token strings in constant time: equal
    /// inputs yield equal tags, and the comparison runs over the fixed-width tag
    /// rather than the variable-length token, so it leaks neither length nor a
    /// prefix match (FR-166 — timing-safe verification).
    fn token_tag(&self, token: &str) -> Vec<u8> {
        let mut mac = HmacSha256::new_from_slice(self.options.token_secret.as_bytes())
            .expect("HMAC accepts a key of any length");
        mac.update(token.as_bytes());
        mac.finalize().into_bytes().to_vec()
    }

    /// Test/inspection: how many transports currently exist on a call's room.
    #[must_use]
    pub fn transport_count(&self, call_id: &str) -> usize {
        self.lock()
            .media
            .get(call_id)
            .map_or(0, |m| m.transports.len())
    }

    /// Test/inspection: how many producers currently exist on a call's room.
    #[must_use]
    pub fn producer_count(&self, call_id: &str) -> usize {
        self.lock()
            .media
            .get(call_id)
            .map_or(0, |m| m.producers.len())
    }

    /// Test/inspection: how many consumers currently exist on a call's room.
    #[must_use]
    pub fn consumer_count(&self, call_id: &str) -> usize {
        self.lock()
            .media
            .get(call_id)
            .map_or(0, |m| m.consumers.len())
    }

    /// Test/inspection: is a transport recorded as DTLS-connected?
    #[must_use]
    pub fn is_transport_connected(&self, call_id: &str, transport_id: &str) -> bool {
        self.lock()
            .media
            .get(call_id)
            .and_then(|m| m.transports.get(transport_id).copied())
            .unwrap_or(false)
    }

    /// Test/inspection: a participant's `(send_transport_id, recv_transport_id)`
    /// on a call, or `None` if they hold no media binding.
    #[must_use]
    pub fn participant_transports(
        &self,
        call_id: &str,
        participant: &MediaParticipant,
    ) -> Option<(String, String)> {
        let key = participant_key(participant);
        self.lock()
            .media
            .get(call_id)
            .and_then(|m| m.participants.get(&key))
            .map(|p| (p.send_transport_id.clone(), p.recv_transport_id.clone()))
    }
}

/// Key a participant's media binding by `"user::device"`.
fn participant_key(participant: &MediaParticipant) -> String {
    format!("{}::{}", participant.user_id, participant.device_id)
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
            // Stand up the room's (empty) media state alongside the room handle so
            // produce/consume have somewhere to record transports.
            state.media.entry(call_id.to_string()).or_default();
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
            let token_count_key = format!(
                "{call_id}::{}::{}",
                participant.user_id, participant.device_id
            );
            let token_ordinal = state
                .token_counts
                .get(&token_count_key)
                .copied()
                .unwrap_or(0)
                + 1;
            state.token_counts.insert(token_count_key, token_ordinal);
            let ttl_ms = options.ttl_ms.unwrap_or(self.options.default_token_ttl_ms);
            let expires_at_ms = now_ms.saturating_add(ttl_ms);
            // Deterministic, coturn-REST-shaped nonce: room-scoped, participant-
            // bound, ordinal-stamped. Authenticity is enforced at verify time by
            // an HMAC-keyed, constant-time compare against this stored token.
            let token = format!(
                "fake-sfu-token.{room_id}.{}.{}.{token_ordinal}",
                participant.user_id, participant.device_id
            );

            // Provision the participant's send + recv transports on the room and
            // record the owning identity so connect/produce/consume can assert the
            // actor owns the transport it operates on (FR-171). A re-issue first
            // releases the participant's previous transports/producers/consumers
            // so repeated join/leave can't leak server-side media state (FR-172).
            let key = participant_key(participant);
            let send_transport_id = format!("fake-transport-{}", state.counter + 1);
            let recv_transport_id = format!("fake-transport-{}", state.counter + 2);
            state.counter += 2;
            let media = state.media.entry(call_id.to_string()).or_default();
            release_participant_media(media, &key);
            media.transports.insert(send_transport_id.clone(), false);
            media.transports.insert(recv_transport_id.clone(), false);
            media.participants.insert(
                key,
                ParticipantMedia {
                    send_transport_id,
                    recv_transport_id,
                    token: token.clone(),
                    expires_at_ms,
                    producer_ids: Vec::new(),
                    consumer_ids: Vec::new(),
                },
            );

            Ok(SfuAccessToken {
                token,
                expires_at_ms,
            })
        })
    }

    fn close_room<'a>(&'a self, call_id: &'a str) -> SfuBackendFuture<'a, ()> {
        Box::pin(async move {
            // Idempotent — closing an unknown/already-closed room is a no-op. Its
            // media (transports/producers/consumers/ownership) is torn down too.
            let mut state = self.lock();
            state.rooms.remove(call_id);
            state.media.remove(call_id);
        })
    }
}

/// Detach a participant's media binding from a room and reclaim every transport,
/// producer, and consumer it owned. Idempotent: a no-op when the participant has
/// no live binding (FR-172).
fn release_participant_media(media: &mut RoomMedia, key: &str) {
    let Some(bound) = media.participants.remove(key) else {
        return;
    };
    for consumer_id in &bound.consumer_ids {
        media.consumers.remove(consumer_id);
    }
    for producer_id in &bound.producer_ids {
        media.producers.remove(producer_id);
    }
    media.transports.remove(&bound.send_transport_id);
    media.transports.remove(&bound.recv_transport_id);
}

impl FakeSfuBackend {
    /// Verify the actor's join token (FR-166) against `state` and return its media
    /// binding key. Checks, in order: the room exists, the actor has a live media
    /// binding, the token has not expired at `now_ms`, and the presented token
    /// matches the issued one under an HMAC-keyed **constant-time** compare. Any
    /// failure is an [`SfuBackendError`] (→ the gateway maps it to a Nack).
    fn require_verified_token(
        &self,
        state: &FakeState,
        call_id: &str,
        actor: &MediaParticipant,
        token: &str,
        now_ms: i64,
    ) -> Result<String, SfuBackendError> {
        let key = participant_key(actor);
        let bound = state
            .media
            .get(call_id)
            .and_then(|m| m.participants.get(&key))
            .ok_or_else(|| {
                SfuBackendError(format!(
                    "{}/{} has no media session on call {call_id}",
                    actor.user_id, actor.device_id
                ))
            })?;
        // Expiry first — an expired credential is rejected regardless of value.
        if now_ms >= bound.expires_at_ms {
            return Err(SfuBackendError("SFU join token has expired".to_string()));
        }
        // Constant-time compare: HMAC both tokens under the secret and verify the
        // fixed-width tags match (rejects a forged/mismatched token, FR-166).
        let expected_tag = self.token_tag(&bound.token);
        let mut mac = HmacSha256::new_from_slice(self.options.token_secret.as_bytes())
            .expect("HMAC accepts a key of any length");
        mac.update(token.as_bytes());
        mac.verify_slice(&expected_tag)
            .map_err(|_| SfuBackendError("SFU join token failed verification".to_string()))?;
        Ok(key)
    }
}

impl SfuMediaOperations for FakeSfuBackend {
    fn verify_join_token(
        &self,
        call_id: &str,
        actor: &MediaParticipant,
        token: &str,
        now_ms: i64,
    ) -> Result<(), SfuBackendError> {
        let state = self.lock();
        self.require_verified_token(&state, call_id, actor, token, now_ms)?;
        Ok(())
    }

    fn connect_transport<'a>(
        &'a self,
        call_id: &'a str,
        actor: &'a MediaParticipant,
        token: &'a str,
        transport_id: &'a str,
        _dtls_parameters: Value,
        now_ms: i64,
    ) -> SfuBackendFuture<'a, Result<(), SfuBackendError>> {
        Box::pin(async move {
            let mut state = self.lock();
            let key = self.require_verified_token(&state, call_id, actor, token, now_ms)?;
            let media = state
                .media
                .get_mut(call_id)
                .ok_or_else(|| SfuBackendError(format!("No room allocated for call {call_id}")))?;
            // A participant may only connect a transport it owns — its own send or
            // recv transport, never another participant's (FR-171).
            let bound = media.participants.get(&key).expect("verified binding");
            let owns =
                transport_id == bound.send_transport_id || transport_id == bound.recv_transport_id;
            if !owns {
                return Err(SfuBackendError(format!(
                    "Transport {transport_id} is not owned by {}/{} on call {call_id}",
                    actor.user_id, actor.device_id
                )));
            }
            media.transports.insert(transport_id.to_string(), true);
            Ok(())
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn produce<'a>(
        &'a self,
        call_id: &'a str,
        actor: &'a MediaParticipant,
        token: &'a str,
        transport_id: &'a str,
        kind: MediaKind,
        _rtp_parameters: Value,
        now_ms: i64,
    ) -> SfuBackendFuture<'a, Result<ProducerHandle, SfuBackendError>> {
        Box::pin(async move {
            let mut state = self.lock();
            let key = self.require_verified_token(&state, call_id, actor, token, now_ms)?;
            state.counter += 1;
            let producer_id = format!("fake-producer-{}", state.counter);
            let media = state
                .media
                .get_mut(call_id)
                .ok_or_else(|| SfuBackendError(format!("No room allocated for call {call_id}")))?;
            // Producing is only allowed on the actor's own *send* transport: this
            // stops B from attaching a producer to A's transport (FR-170).
            let bound = media.participants.get(&key).expect("verified binding");
            if transport_id != bound.send_transport_id {
                return Err(SfuBackendError(format!(
                    "Transport {transport_id} is not the actor's send transport on call {call_id}"
                )));
            }
            media.producers.insert(producer_id.clone(), kind);
            media
                .participants
                .get_mut(&key)
                .expect("verified binding")
                .producer_ids
                .push(producer_id.clone());
            Ok(ProducerHandle {
                id: producer_id,
                kind,
            })
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn consume<'a>(
        &'a self,
        call_id: &'a str,
        actor: &'a MediaParticipant,
        token: &'a str,
        transport_id: &'a str,
        producer_id: &'a str,
        _rtp_capabilities: Value,
        now_ms: i64,
    ) -> SfuBackendFuture<'a, Result<ConsumerHandle, SfuBackendError>> {
        Box::pin(async move {
            let mut state = self.lock();
            let key = self.require_verified_token(&state, call_id, actor, token, now_ms)?;
            state.counter += 1;
            let consumer_id = format!("fake-consumer-{}", state.counter);
            let media = state
                .media
                .get_mut(call_id)
                .ok_or_else(|| SfuBackendError(format!("No room allocated for call {call_id}")))?;
            // Consuming is only allowed onto the actor's own *recv* transport: this
            // stops B from steering consumers onto A's recv transport (FR-171).
            let bound = media.participants.get(&key).expect("verified binding");
            if transport_id != bound.recv_transport_id {
                return Err(SfuBackendError(format!(
                    "Transport {transport_id} is not the actor's recv transport on call {call_id}"
                )));
            }
            let producer_kind = media.producers.get(producer_id).copied().ok_or_else(|| {
                SfuBackendError(format!(
                    "Cannot consume: no producer {producer_id} on call {call_id}"
                ))
            })?;
            media.consumers.insert(consumer_id.clone());
            media
                .participants
                .get_mut(&key)
                .expect("verified binding")
                .consumer_ids
                .push(consumer_id.clone());
            Ok(ConsumerHandle {
                id: consumer_id,
                producer_id: producer_id.to_string(),
                kind: producer_kind,
                rtp_parameters: Value::Map(vec![(Value::from("codecs"), Value::Array(Vec::new()))]),
            })
        })
    }

    fn leave_participant<'a>(
        &'a self,
        call_id: &'a str,
        participant: &'a MediaParticipant,
    ) -> SfuBackendFuture<'a, ()> {
        Box::pin(async move {
            let mut state = self.lock();
            let key = participant_key(participant);
            if let Some(media) = state.media.get_mut(call_id) {
                release_participant_media(media, &key);
            }
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
