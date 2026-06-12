//! FR-288 — `LiveKitSfuBackend`: a production [`SfuBackend`] that mints
//! LiveKit-compatible join tokens, entirely in pure Rust.
//!
//! This is the real, deployment-ready sibling of the deterministic
//! [`FakeSfuBackend`] (FR-287). It slots in behind the same object-safe
//! [`SfuBackend`] seam — `Arc<dyn SfuBackend>` — so the SFU media-plane adapter
//! ([`super::sfu_media_plane`]) drives it identically.
//!
//! ## What it does (and, deliberately, what it does **not**)
//!
//! A LiveKit access token is just a signed JWT: a participant presents it to the
//! LiveKit server (at `ws_url`) to authorize a room join. Minting one is **pure,
//! offline crypto** — an HS256 signature over a JSON claim set keyed by the
//! project's `api_secret`. **No running LiveKit server is required to mint a
//! token**; standing up / scaling the LiveKit SFU is *deployment infrastructure*,
//! orthogonal to this backend. That keeps the typecheck/test gate hermetic: no
//! native SDK, no network, no server — exactly like the fake.
//!
//! Concretely:
//!  - [`ensure_room`](LiveKitSfuBackend::ensure_room) does **no** I/O. The room is
//!    named deterministically from the call id and the connection bundle carries
//!    the LiveKit `ws_url` the client dials plus the room name. LiveKit creates
//!    the room lazily on first join, so there is nothing to provision here.
//!  - [`mint_access_token`](LiveKitSfuBackend::mint_access_token) builds the
//!    LiveKit JWT (see [`LiveKitSfuBackend::mint_access_token`] for the exact
//!    claim shape) signed with `api_secret`.
//!  - [`close_room`](LiveKitSfuBackend::close_room) is a **no-op**: a LiveKit room
//!    auto-closes once the last participant leaves. An explicit `DeleteRoom` REST
//!    call is a deployment-time concern (and would require the running server),
//!    so it is intentionally out of scope for this offline backend.
//!
//! ## The token format
//!
//! A standard JWT: `base64url(header) . base64url(claims) . base64url(sig)` with
//! URL-safe, no-padding base64 segments, signed HS256 (`HMAC-SHA256`) over
//! `header.claims` with the `api_secret`. Per LiveKit's access-token spec the
//! video grant lives under a `video` claim. We build it with pure RustCrypto
//! (`hmac` + `sha2`), `base64` for the segments, and `serde_json` for the claims —
//! no `livekit` SDK, no native deps.
//!
//! [`FakeSfuBackend`]: super::sfu_backend::FakeSfuBackend
//! [`SfuBackend`]: super::sfu_backend::SfuBackend

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64_URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use indexmap::IndexMap;
use serde_json::json;
use sha2::Sha256;

use super::media_plane::MediaParticipant;
use super::sfu_backend::{
    MintAccessTokenOptions, SfuAccessToken, SfuBackend, SfuBackendError, SfuBackendFuture, SfuRoom,
};

/// HS256 = HMAC over SHA-256, the LiveKit access-token signing algorithm.
type HmacSha256 = Hmac<Sha256>;

/// Default per-participant token lifetime, mirroring the fake backend and the TS
/// adapter's 5 minutes. The backend uses it whenever a mint call doesn't override
/// the TTL.
const DEFAULT_TOKEN_TTL_MS: i64 = 5 * 60 * 1000;

/// Construction options for [`LiveKitSfuBackend`].
#[derive(Debug, Clone)]
pub struct LiveKitSfuBackendOptions {
    /// Default token lifetime in ms when a mint call doesn't override it.
    pub default_token_ttl_ms: i64,
}

impl Default for LiveKitSfuBackendOptions {
    fn default() -> Self {
        Self {
            default_token_ttl_ms: DEFAULT_TOKEN_TTL_MS,
        }
    }
}

/// FR-288 — a production [`SfuBackend`] minting LiveKit-compatible join tokens.
///
/// Holds the LiveKit project credentials (`api_key` / `api_secret`) and the
/// signaling `ws_url` clients dial. Token minting is **offline crypto** (see the
/// module docs): no running LiveKit server is required to mint a token.
pub struct LiveKitSfuBackend {
    /// LiveKit project API key — the JWT `iss` (issuer) claim.
    api_key: String,
    /// LiveKit project API secret — the HS256 signing key. Never serialized.
    api_secret: String,
    /// LiveKit signaling URL clients connect to (e.g.
    /// `wss://my-project.livekit.cloud`). Advertised in the room's connection
    /// bundle so the client knows where to dial.
    ws_url: String,
    options: LiveKitSfuBackendOptions,
}

impl std::fmt::Debug for LiveKitSfuBackend {
    /// Redacts `api_secret` so the HS256 signing key never leaks into logs.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveKitSfuBackend")
            .field("api_key", &self.api_key)
            .field("api_secret", &"<redacted>")
            .field("ws_url", &self.ws_url)
            .field("options", &self.options)
            .finish()
    }
}

impl LiveKitSfuBackend {
    /// Build a backend for a LiveKit project with the default token TTL.
    ///
    /// `api_key` / `api_secret` are the LiveKit project credentials; `ws_url` is
    /// the signaling URL clients dial (e.g. `wss://my-project.livekit.cloud`).
    #[must_use]
    pub fn new(
        api_key: impl Into<String>,
        api_secret: impl Into<String>,
        ws_url: impl Into<String>,
    ) -> Self {
        Self::with_options(
            api_key,
            api_secret,
            ws_url,
            LiveKitSfuBackendOptions::default(),
        )
    }

    /// Build a backend with explicit [`LiveKitSfuBackendOptions`].
    #[must_use]
    pub fn with_options(
        api_key: impl Into<String>,
        api_secret: impl Into<String>,
        ws_url: impl Into<String>,
        options: LiveKitSfuBackendOptions,
    ) -> Self {
        Self {
            api_key: api_key.into(),
            api_secret: api_secret.into(),
            ws_url: ws_url.into(),
            options,
        }
    }

    /// Deterministic LiveKit room name for a call. LiveKit creates the room
    /// lazily on first join, so this is purely a stable identifier — no
    /// provisioning happens.
    fn room_name(call_id: &str) -> String {
        format!("frick-call-{call_id}")
    }

    /// Build the connection bundle a room advertises: the LiveKit signaling URL
    /// the client dials plus the room name it joins.
    fn room_connection(&self, room: &str) -> IndexMap<String, String> {
        let mut connection = IndexMap::new();
        connection.insert("wsUrl".to_string(), self.ws_url.clone());
        connection.insert("room".to_string(), room.to_string());
        connection
    }

    /// Mint a LiveKit access-token JWT for `participant` on `room`, valid from
    /// `now_ms` for `ttl_ms`.
    ///
    /// The result is a standard JWT — `base64url(header).base64url(claims).
    /// base64url(sig)` — with HS256 signed over `header.claims` using
    /// `api_secret`:
    ///
    /// ```text
    /// header: { "alg": "HS256", "typ": "JWT" }
    /// claims: {
    ///   "iss": <api_key>,
    ///   "sub": <participant identity>,
    ///   "nbf": <now seconds>,
    ///   "exp": <now + ttl seconds>,
    ///   "video": {
    ///     "room": <room>,
    ///     "roomJoin": true,
    ///     "canPublish": true,
    ///     "canSubscribe": true
    ///   }
    /// }
    /// ```
    fn mint_jwt(&self, room: &str, identity: &str, now_ms: i64, ttl_ms: i64) -> String {
        // LiveKit (like JWT generally) stamps `nbf`/`exp` in whole seconds.
        let nbf = now_ms.div_euclid(1_000);
        let exp = now_ms.saturating_add(ttl_ms).div_euclid(1_000);

        let header = json!({ "alg": "HS256", "typ": "JWT" });
        let claims = json!({
            "iss": self.api_key,
            "sub": identity,
            "nbf": nbf,
            "exp": exp,
            "video": {
                "room": room,
                "roomJoin": true,
                "canPublish": true,
                "canSubscribe": true,
            },
        });

        // `serde_json::to_vec` on these owned `Value`s cannot fail.
        let header_b64 = BASE64_URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&header).expect("serializing a JWT header to JSON cannot fail"),
        );
        let claims_b64 = BASE64_URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&claims).expect("serializing JWT claims to JSON cannot fail"),
        );

        let signing_input = format!("{header_b64}.{claims_b64}");
        let signature_b64 = self.sign_hs256(signing_input.as_bytes());

        format!("{signing_input}.{signature_b64}")
    }

    /// HS256-sign `bytes` with `api_secret`, returning the URL-safe-no-pad
    /// base64 signature segment.
    fn sign_hs256(&self, bytes: &[u8]) -> String {
        let mut mac = HmacSha256::new_from_slice(self.api_secret.as_bytes())
            .expect("HMAC accepts a key of any length");
        mac.update(bytes);
        BASE64_URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    }
}

impl SfuBackend for LiveKitSfuBackend {
    /// Returns the [`SfuRoom`] handle for `call_id`. Does **no** I/O: LiveKit
    /// creates the room lazily on the first join, so this only assigns the
    /// deterministic room name and the connection bundle (`ws_url` + room).
    fn ensure_room<'a>(
        &'a self,
        call_id: &'a str,
    ) -> SfuBackendFuture<'a, Result<SfuRoom, SfuBackendError>> {
        Box::pin(async move {
            let room = Self::room_name(call_id);
            let connection = self.room_connection(&room);
            Ok(SfuRoom {
                room_id: room,
                connection,
            })
        })
    }

    /// Every call has a (lazily-created) LiveKit room, so this is always `true`.
    fn has_room(&self, _call_id: &str) -> bool {
        true
    }

    /// Mint a LiveKit access token — an HS256 JWT — for `participant` on
    /// `call_id`'s room. Pure offline crypto: no running LiveKit server is
    /// required. `now_ms` stamps `nbf`/`exp`; `options.ttl_ms` overrides the
    /// default lifetime. See [`mint_jwt`](LiveKitSfuBackend::mint_jwt) for the
    /// exact claim shape.
    fn mint_access_token<'a>(
        &'a self,
        call_id: &'a str,
        participant: &'a MediaParticipant,
        now_ms: i64,
        options: MintAccessTokenOptions,
    ) -> SfuBackendFuture<'a, Result<SfuAccessToken, SfuBackendError>> {
        Box::pin(async move {
            let room = Self::room_name(call_id);
            // A LiveKit participant identity must be unique within a room; key it
            // on user + device so the same user on two devices gets two identities.
            let identity = format!("{}::{}", participant.user_id, participant.device_id);
            let ttl_ms = options.ttl_ms.unwrap_or(self.options.default_token_ttl_ms);
            let expires_at_ms = now_ms.saturating_add(ttl_ms);
            let token = self.mint_jwt(&room, &identity, now_ms, ttl_ms);
            Ok(SfuAccessToken {
                token,
                expires_at_ms,
            })
        })
    }

    /// No-op: a LiveKit room auto-closes once its last participant leaves. An
    /// explicit `DeleteRoom` REST call would require the running LiveKit server
    /// and is a deployment-time concern, so it is intentionally out of scope for
    /// this offline backend.
    fn close_room<'a>(&'a self, _call_id: &'a str) -> SfuBackendFuture<'a, ()> {
        Box::pin(async move {})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const API_KEY: &str = "APIabc123";
    const API_SECRET: &str = "a-sufficiently-long-livekit-secret";
    const WS_URL: &str = "wss://frick-test.livekit.cloud";

    fn backend() -> LiveKitSfuBackend {
        LiveKitSfuBackend::new(API_KEY, API_SECRET, WS_URL)
    }

    fn participant() -> MediaParticipant {
        MediaParticipant {
            user_id: "ada".into(),
            device_id: "dev-1".into(),
        }
    }

    /// Decode a URL-safe-no-pad base64 JWT segment into a UTF-8 string.
    fn decode_segment(segment: &str) -> String {
        let bytes = BASE64_URL_SAFE_NO_PAD
            .decode(segment)
            .expect("JWT segment is valid url-safe base64");
        String::from_utf8(bytes).expect("JWT segment is valid UTF-8")
    }

    /// Recompute the HS256 signature segment over `header.claims` with the secret.
    fn expected_signature(signing_input: &str, secret: &str) -> String {
        let mut mac =
            HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
        mac.update(signing_input.as_bytes());
        BASE64_URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    }

    #[tokio::test]
    async fn mint_access_token_produces_a_verifiable_livekit_jwt() {
        let backend = backend();
        let now_ms = 1_700_000_000_000;
        let minted = backend
            .mint_access_token(
                "call-1",
                &participant(),
                now_ms,
                MintAccessTokenOptions::default(),
            )
            .await
            .expect("mint token");

        // now_ms + default ttl (5 min) → deterministic expiry.
        assert_eq!(minted.expires_at_ms, now_ms + DEFAULT_TOKEN_TTL_MS);

        // The token is a three-segment JWT.
        let parts: Vec<&str> = minted.token.split('.').collect();
        assert_eq!(parts.len(), 3, "a JWT has header.claims.signature");
        let (header_b64, claims_b64, signature_b64) = (parts[0], parts[1], parts[2]);

        // Header is exactly the HS256 JWT header.
        let header: serde_json::Value =
            serde_json::from_str(&decode_segment(header_b64)).expect("header is JSON");
        assert_eq!(header["alg"], "HS256");
        assert_eq!(header["typ"], "JWT");

        // The signature re-computes from the secret over `header.claims`.
        let signing_input = format!("{header_b64}.{claims_b64}");
        assert_eq!(
            signature_b64,
            expected_signature(&signing_input, API_SECRET),
            "HS256 signature must verify against the api_secret"
        );
        // ...and a wrong secret must NOT verify (the signature is actually keyed).
        assert_ne!(
            signature_b64,
            expected_signature(&signing_input, "the-wrong-secret"),
            "signature must depend on the secret"
        );

        // Claims match the LiveKit access-token spec.
        let claims: serde_json::Value =
            serde_json::from_str(&decode_segment(claims_b64)).expect("claims are JSON");
        assert_eq!(claims["iss"], API_KEY, "iss is the api_key");
        assert_eq!(
            claims["sub"], "ada::dev-1",
            "sub is the participant identity"
        );

        let nbf = claims["nbf"].as_i64().expect("nbf is an integer");
        let exp = claims["exp"].as_i64().expect("exp is an integer");
        assert_eq!(nbf, now_ms / 1_000, "nbf is now in seconds");
        assert_eq!(exp, (now_ms + DEFAULT_TOKEN_TTL_MS) / 1_000);
        assert!(exp > nbf, "exp must be after nbf");

        let video = &claims["video"];
        assert_eq!(video["room"], "frick-call-call-1");
        assert_eq!(video["roomJoin"], true);
        assert_eq!(video["canPublish"], true);
        assert_eq!(video["canSubscribe"], true);
    }

    #[tokio::test]
    async fn mint_access_token_honors_a_custom_ttl() {
        let backend = backend();
        let minted = backend
            .mint_access_token(
                "call-1",
                &participant(),
                10_000,
                MintAccessTokenOptions {
                    ttl_ms: Some(2_000),
                },
            )
            .await
            .expect("mint token");
        assert_eq!(minted.expires_at_ms, 12_000);

        let claims_b64 = minted.token.split('.').nth(1).expect("claims segment");
        let claims: serde_json::Value =
            serde_json::from_str(&decode_segment(claims_b64)).expect("claims are JSON");
        assert_eq!(claims["nbf"], 10);
        assert_eq!(claims["exp"], 12);
    }

    #[tokio::test]
    async fn ensure_room_carries_the_ws_url_and_room_name() {
        let backend = backend();
        let room = backend.ensure_room("call-42").await.expect("ensure room");
        assert_eq!(room.room_id, "frick-call-call-42");
        assert_eq!(
            room.connection.get("wsUrl").map(String::as_str),
            Some(WS_URL),
            "the connection bundle advertises the LiveKit signaling URL"
        );
        assert_eq!(
            room.connection.get("room").map(String::as_str),
            Some("frick-call-call-42")
        );
        // Always reports a room (LiveKit creates it lazily on join).
        assert!(backend.has_room("call-42"));
    }

    #[tokio::test]
    async fn close_room_is_a_noop() {
        let backend = backend();
        // No state to mutate; closing any call id is harmless and a room still
        // "exists" afterward (LiveKit auto-closes empty rooms server-side).
        backend.close_room("call-1").await;
        backend.close_room("never-existed").await;
        assert!(backend.has_room("call-1"));
    }

    #[test]
    fn debug_redacts_the_api_secret() {
        let rendered = format!("{:?}", backend());
        assert!(rendered.contains("<redacted>"), "secret must be redacted");
        assert!(
            !rendered.contains(API_SECRET),
            "the raw api_secret must never appear in Debug output"
        );
    }
}
