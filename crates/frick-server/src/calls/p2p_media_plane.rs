//! FR-81 / FR-286 — self-built one-to-one P2P WebRTC [`MediaPlaneAdapter`].
//!
//! Media flows *directly* peer↔peer over WebRTC/SRTP — there is no media server.
//! The Frick server stays control-plane only: SDP/ICE ride the existing
//! `WebRTCSignal` relay, and this adapter's sole networking-adjacent job is to
//! hand each joining participant a set of ICE servers (STUN for reflexive
//! candidates, optional TURN for relayed candidates when a direct path can't be
//! established through NAT).
//!
//! TURN credentials are minted with the standard **coturn REST convention**
//! (a.k.a. the "TURN REST API" / `use-auth-secret` mode): a TURN server
//! configured with a shared secret accepts any
//! `username = "<unixExpirySeconds>:<userId>"` whose `credential` is
//! `base64(HMAC-SHA1(sharedSecret, username))`. This lets us issue *ephemeral*,
//! per-participant TURN credentials with zero round-trips to the TURN server and
//! no per-user provisioning — the TURN server validates them statelessly. See
//! the coturn docs for `static-auth-secret` / `--use-auth-secret`.
//!
//! Like [`FakeMediaPlaneAdapter`], this adapter does **no networking** of its
//! own and is fully deterministic under the control plane's injected `now_ms`:
//! `allocate_session` is a cheap idempotent in-memory handle, `issue_join_token`
//! derives credentials purely from the configured secret + clock + ttl, and
//! `release_session` drops the handle. That determinism is what lets the
//! call-lifecycle tests assert exact ICE payloads without standing up coturn.
//!
//! [`FakeMediaPlaneAdapter`]: super::FakeMediaPlaneAdapter

use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use hmac::{Hmac, Mac};
use indexmap::IndexMap;
use sha1::Sha1;

use super::media_plane::{
    AllocateSessionOptions, IssueJoinTokenOptions, MediaJoinGrant, MediaParticipant,
    MediaPlaneAdapter, MediaPlaneCapabilities, MediaPlaneError, MediaPlaneFuture,
    MediaPlaneTransport, MediaSession,
};

const DEFAULT_TOKEN_TTL_MS: i64 = 5 * 60 * 1000;

/// Default STUN server exposed when the host configures no ICE servers, so a
/// fresh install still negotiates direct paths through common NATs.
const DEFAULT_STUN_URL: &str = "stun:stun.l.google.com:19302";

/// Minimum acceptable byte-length for the TURN shared secret. An empty/short
/// secret makes the coturn-REST HMAC-SHA1 credential trivially forgeable (an
/// attacker can reproduce the MAC and mint long-lived relay creds), so the
/// adapter fails closed at construction.
const MIN_TURN_SECRET_BYTES: usize = 16;

type HmacSha1 = Hmac<Sha1>;

/// A STUN/TURN/TURNS server entry, mirroring the WebRTC `RTCIceServer` shape.
/// Serializes to the JSON the client hands straight to `RTCPeerConnection`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P2pIceServer {
    /// One or more urls (e.g. `stun:stun.example.org:3478`).
    pub urls: Vec<String>,
    /// Long-term username (minted for TURN; absent for STUN).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// Long-term credential (minted for TURN; absent for STUN).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

impl P2pIceServer {
    /// A creds-free STUN entry for a single url.
    #[must_use]
    pub fn stun(url: impl Into<String>) -> Self {
        Self {
            urls: vec![url.into()],
            username: None,
            credential: None,
        }
    }
}

/// TURN configuration enabling ephemeral coturn-REST credential minting.
#[derive(Debug, Clone)]
pub struct P2pTurnConfig {
    /// TURN/TURNS url(s) clients should use, e.g.
    /// `["turn:turn.example.org:3478", "turns:turn.example.org:5349"]`.
    pub urls: Vec<String>,
    /// Shared secret the TURN server is configured with (`static-auth-secret` /
    /// `--use-auth-secret`). Used as the HMAC-SHA1 key — never sent to clients.
    pub shared_secret: String,
    /// Optional TURN realm, echoed onto the grant connection metadata.
    pub realm: Option<String>,
}

/// Construction options for [`P2pMediaPlaneAdapter`].
#[derive(Debug, Clone)]
pub struct P2pMediaPlaneOptions {
    /// Base STUN ICE servers exposed to every participant verbatim (no creds).
    /// Defaults to a single Google public STUN server so a fresh install still
    /// negotiates. Pass an empty `Vec` to expose no STUN.
    pub ice_servers: Vec<P2pIceServer>,
    /// TURN config. When omitted the adapter returns STUN-only ICE servers —
    /// still a valid configuration (many P2P connections succeed STUN-only).
    pub turn: Option<P2pTurnConfig>,
    /// Default join-token / TURN-credential lifetime in ms. Defaults to 5 min.
    pub default_token_ttl_ms: i64,
}

impl Default for P2pMediaPlaneOptions {
    fn default() -> Self {
        Self {
            ice_servers: vec![P2pIceServer::stun(DEFAULT_STUN_URL)],
            turn: None,
            default_token_ttl_ms: DEFAULT_TOKEN_TTL_MS,
        }
    }
}

#[derive(Clone)]
struct AllocatedSession {
    session: MediaSession,
    /// Monotonic ordinal; reserved for ordering/debugging parity with the fake
    /// (the public session never exposes it).
    #[allow(dead_code)]
    ordinal: u64,
}

#[derive(Default)]
struct P2pState {
    /// Live sessions keyed by call id. A released call drops out of the map.
    sessions: HashMap<String, AllocatedSession>,
    /// Monotonic counter feeding deterministic session ids.
    counter: u64,
}

/// Self-built one-to-one P2P WebRTC media plane. See the module docs.
pub struct P2pMediaPlaneAdapter {
    ice_servers: Vec<P2pIceServer>,
    turn: Option<P2pTurnConfig>,
    default_token_ttl_ms: i64,
    state: Mutex<P2pState>,
}

impl P2pMediaPlaneAdapter {
    /// Build an adapter from `options`. Fails closed with [`MediaPlaneError`]
    /// when TURN is configured with an empty/weak shared secret (under
    /// [`MIN_TURN_SECRET_BYTES`]) rather than silently issuing forgeable
    /// coturn-REST credentials.
    pub fn new(options: P2pMediaPlaneOptions) -> Result<Self, MediaPlaneError> {
        if let Some(turn) = &options.turn
            && turn.shared_secret.len() < MIN_TURN_SECRET_BYTES
        {
            return Err(MediaPlaneError(format!(
                "P2pMediaPlaneAdapter requires a TURN shared_secret of at least \
                 {MIN_TURN_SECRET_BYTES} bytes"
            )));
        }
        Ok(Self::from_validated(options))
    }

    /// Build from options whose TURN config (if any) is already validated —
    /// the infallible path the in-crate constructors take.
    fn from_validated(options: P2pMediaPlaneOptions) -> Self {
        Self {
            ice_servers: options.ice_servers,
            turn: options.turn,
            default_token_ttl_ms: options.default_token_ttl_ms,
            state: Mutex::new(P2pState::default()),
        }
    }

    /// A STUN-only adapter with the default public STUN server — the simplest
    /// usable P2P plane (no TURN relay, so it fails through symmetric NATs).
    /// The default options carry no TURN, so this is infallible.
    #[must_use]
    pub fn stun_only() -> Self {
        Self::from_validated(P2pMediaPlaneOptions::default())
    }

    /// Test/inspection helper: is a session currently allocated for this call?
    #[must_use]
    pub fn has_session(&self, call_id: &str) -> bool {
        self.lock().sessions.contains_key(call_id)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, P2pState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Compose the participant's ICE servers: the configured STUN entries
    /// verbatim (no creds), plus — when TURN is configured — a TURN/TURNS entry
    /// carrying a freshly minted ephemeral coturn-REST credential pair.
    fn build_ice_servers(&self, user_id: &str, expiry_ms: i64) -> Vec<P2pIceServer> {
        let mut servers = self.ice_servers.clone();
        if let Some(turn) = &self.turn {
            let expiry_seconds = expiry_ms.div_euclid(1_000);
            let username = format!("{expiry_seconds}:{user_id}");
            let mut mac = HmacSha1::new_from_slice(turn.shared_secret.as_bytes())
                .expect("HMAC accepts a key of any length");
            mac.update(username.as_bytes());
            let credential = BASE64_STANDARD.encode(mac.finalize().into_bytes());
            servers.push(P2pIceServer {
                urls: turn.urls.clone(),
                username: Some(username),
                credential: Some(credential),
            });
        }
        servers
    }
}

impl MediaPlaneAdapter for P2pMediaPlaneAdapter {
    fn describe(&self) -> MediaPlaneCapabilities {
        MediaPlaneCapabilities {
            transport: MediaPlaneTransport::P2p,
            max_participants: Some(2),
            supports_region_hint: false,
        }
    }

    fn allocate_session<'a>(
        &'a self,
        call_id: &'a str,
        _options: AllocateSessionOptions,
    ) -> MediaPlaneFuture<'a, Result<MediaSession, MediaPlaneError>> {
        Box::pin(async move {
            let mut state = self.lock();
            // Idempotent per call id: a second allocate for a still-live call
            // returns the existing handle rather than minting a second one. No
            // networking — a P2P "session" is just a logical id the two peers
            // correlate signaling on.
            if let Some(existing) = state.sessions.get(call_id) {
                return Ok(existing.session.clone());
            }
            state.counter += 1;
            let ordinal = state.counter;
            // P2P carries no media-server signaling URL: the only
            // per-participant connection info (ICE servers) is minted at join
            // time. The `transport` marker tells clients to negotiate directly.
            let mut connection = IndexMap::new();
            connection.insert("transport".to_string(), "p2p".to_string());
            let session = MediaSession {
                call_id: call_id.to_string(),
                media_session_id: format!("p2p-{call_id}-{ordinal}"),
                transport: MediaPlaneTransport::P2p,
                region: None,
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
            let media_session_id = {
                let state = self.lock();
                let Some(allocated) = state.sessions.get(call_id) else {
                    return Err(MediaPlaneError(format!(
                        "Cannot issue a join token: no media session allocated for call {call_id}"
                    )));
                };
                allocated.session.media_session_id.clone()
            };
            let ttl_ms = options.ttl_ms.unwrap_or(self.default_token_ttl_ms);
            let expiry_ms = now_ms.saturating_add(ttl_ms);
            let ice_servers = self.build_ice_servers(&participant.user_id, expiry_ms);
            // For P2P the "token" *is* the ICE configuration (there is no bearer
            // token to present to a media server). Serialize once and mirror it
            // into `connection.iceServers` so clients have one canonical place
            // to parse.
            let serialized = serde_json::to_string(&ice_servers).map_err(|err| {
                MediaPlaneError(format!("failed to serialize ICE servers: {err}"))
            })?;
            let mut connection = IndexMap::new();
            connection.insert("iceServers".to_string(), serialized.clone());
            if let Some(realm) = self.turn.as_ref().and_then(|turn| turn.realm.as_ref()) {
                connection.insert("turnRealm".to_string(), realm.clone());
            }
            Ok(MediaJoinGrant {
                call_id: call_id.to_string(),
                media_session_id,
                user_id: participant.user_id,
                device_id: participant.device_id,
                token: serialized,
                expires_at: crate::boot::iso_from_epoch_ms(expiry_ms),
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

    fn turn_options() -> P2pMediaPlaneOptions {
        P2pMediaPlaneOptions {
            ice_servers: vec![P2pIceServer::stun("stun:stun.example.org:3478")],
            turn: Some(P2pTurnConfig {
                urls: vec!["turn:turn.example.org:3478".to_string()],
                shared_secret: "a-sufficiently-long-shared-secret".to_string(),
                realm: Some("frick.example".to_string()),
            }),
            default_token_ttl_ms: DEFAULT_TOKEN_TTL_MS,
        }
    }

    #[tokio::test]
    async fn describe_reports_p2p_caps() {
        let plane = P2pMediaPlaneAdapter::stun_only();
        assert_eq!(
            plane.describe(),
            MediaPlaneCapabilities {
                transport: MediaPlaneTransport::P2p,
                max_participants: Some(2),
                supports_region_hint: false,
            }
        );
    }

    #[tokio::test]
    async fn new_fails_closed_on_weak_turn_secret() {
        // The adapter is not `Debug`, so match rather than `expect_err`.
        let result = P2pMediaPlaneAdapter::new(P2pMediaPlaneOptions {
            turn: Some(P2pTurnConfig {
                urls: vec!["turn:turn.example.org:3478".to_string()],
                shared_secret: "too-short".to_string(),
                realm: None,
            }),
            ..P2pMediaPlaneOptions::default()
        });
        match result {
            Ok(_) => panic!("weak TURN secret must be rejected"),
            Err(err) => assert!(err.to_string().contains("shared_secret")),
        }
    }

    #[tokio::test]
    async fn allocate_session_is_idempotent_per_call() {
        let plane = P2pMediaPlaneAdapter::stun_only();
        let first = plane
            .allocate_session("call-1", AllocateSessionOptions::default())
            .await
            .expect("allocate");
        let second = plane
            .allocate_session("call-1", AllocateSessionOptions::default())
            .await
            .expect("allocate again");
        assert_eq!(first, second, "a second allocate returns the same session");
        assert_eq!(first.media_session_id, "p2p-call-1-1");
        assert_eq!(first.transport, MediaPlaneTransport::P2p);
        assert_eq!(first.region, None, "p2p never places a region");
        assert!(plane.has_session("call-1"));

        // A distinct call gets a distinct, monotonically-numbered handle.
        let other = plane
            .allocate_session("call-2", AllocateSessionOptions::default())
            .await
            .expect("allocate other");
        assert_eq!(other.media_session_id, "p2p-call-2-2");
    }

    #[tokio::test]
    async fn allocate_session_ignores_region_hint() {
        let plane = P2pMediaPlaneAdapter::stun_only();
        let session = plane
            .allocate_session(
                "call-1",
                AllocateSessionOptions {
                    region_hint: Some("eu-west".to_string()),
                    ..AllocateSessionOptions::default()
                },
            )
            .await
            .expect("allocate");
        assert_eq!(session.region, None);
    }

    #[tokio::test]
    async fn issue_join_token_requires_an_allocated_session() {
        let plane = P2pMediaPlaneAdapter::stun_only();
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
    async fn issue_join_token_stun_only_carries_configured_stun() {
        let plane = P2pMediaPlaneAdapter::stun_only();
        plane
            .allocate_session("call-1", AllocateSessionOptions::default())
            .await
            .expect("allocate");
        let grant = plane
            .issue_join_token(
                "call-1",
                MediaParticipant {
                    user_id: "ada".into(),
                    device_id: "dev-1".into(),
                },
                1_000,
                IssueJoinTokenOptions::default(),
            )
            .await
            .expect("token");
        assert_eq!(grant.media_session_id, "p2p-call-1-1");
        // now_ms (1_000) + default ttl (5 min) → deterministic expiry.
        assert_eq!(grant.expires_at, crate::boot::iso_from_epoch_ms(301_000));
        // The token *is* the serialized ICE config, mirrored into connection.
        let connection = grant.connection.expect("connection");
        assert_eq!(connection.get("iceServers"), Some(&grant.token));
        assert_eq!(connection.get("turnRealm"), None, "no TURN configured");
        let servers: Vec<P2pIceServer> =
            serde_json::from_str(&grant.token).expect("parse ICE servers");
        assert_eq!(servers, vec![P2pIceServer::stun(DEFAULT_STUN_URL)]);
    }

    #[tokio::test]
    async fn issue_join_token_grant_carries_minted_turn_credentials() {
        let plane = P2pMediaPlaneAdapter::new(turn_options()).expect("valid turn options");
        plane
            .allocate_session("call-1", AllocateSessionOptions::default())
            .await
            .expect("allocate");
        let grant = plane
            .issue_join_token(
                "call-1",
                MediaParticipant {
                    user_id: "ada".into(),
                    device_id: "dev-1".into(),
                },
                1_000,
                IssueJoinTokenOptions::default(),
            )
            .await
            .expect("token");

        let connection = grant.connection.expect("connection");
        assert_eq!(
            connection.get("turnRealm").map(String::as_str),
            Some("frick.example")
        );

        let servers: Vec<P2pIceServer> =
            serde_json::from_str(&grant.token).expect("parse ICE servers");
        // The configured STUN entry is exposed verbatim, then a minted TURN one.
        assert_eq!(servers[0], P2pIceServer::stun("stun:stun.example.org:3478"));
        let turn = &servers[1];
        assert_eq!(turn.urls, vec!["turn:turn.example.org:3478".to_string()]);

        // username = "<unixExpirySeconds>:<userId>"; expiry = 1_000 + 300_000ms
        // = 301_000ms → 301s.
        assert_eq!(turn.username.as_deref(), Some("301:ada"));

        // credential = base64(HMAC-SHA1(sharedSecret, username)) — recompute it
        // independently to pin the exact coturn-REST shape.
        let mut mac =
            HmacSha1::new_from_slice(b"a-sufficiently-long-shared-secret").expect("hmac key");
        mac.update(b"301:ada");
        let expected = BASE64_STANDARD.encode(mac.finalize().into_bytes());
        assert_eq!(turn.credential.as_deref(), Some(expected.as_str()));
    }

    #[tokio::test]
    async fn issue_join_token_turn_username_tracks_user_and_ttl() {
        let plane = P2pMediaPlaneAdapter::new(turn_options()).expect("valid turn options");
        plane
            .allocate_session("call-1", AllocateSessionOptions::default())
            .await
            .expect("allocate");
        let grant = plane
            .issue_join_token(
                "call-1",
                MediaParticipant {
                    user_id: "bob".into(),
                    device_id: "dev-9".into(),
                },
                5_000,
                IssueJoinTokenOptions {
                    ttl_ms: Some(60_000),
                },
            )
            .await
            .expect("token");
        let servers: Vec<P2pIceServer> =
            serde_json::from_str(&grant.token).expect("parse ICE servers");
        // expiry = 5_000 + 60_000 = 65_000ms → 65s; user is echoed in.
        assert_eq!(servers[1].username.as_deref(), Some("65:bob"));
        assert_eq!(grant.expires_at, crate::boot::iso_from_epoch_ms(65_000));
    }

    #[tokio::test]
    async fn release_session_is_idempotent() {
        let plane = P2pMediaPlaneAdapter::stun_only();
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
