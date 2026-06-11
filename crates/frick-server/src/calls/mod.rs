//! Realtime calls control plane (FR-276) — the Rust port of the deleted
//! TypeScript `apps/server/src/calls/`.
//!
//! Frick owns call **state + signaling**; the media plane brokers the **media**.
//! The module is built up in dependency order per
//! `internal/plans/2026-06-11-calls-epic-rust-port.md`: the [`media_plane`]
//! boundary + the deterministic [`fake_media_plane`] (FR-281) first, then the
//! call schema + `CallCommand` routing (FR-282) and the `CallControlPlane` state
//! machine (FR-283).

mod control_plane;
mod fake_media_plane;
mod media_plane;
mod p2p_media_plane;
pub mod schema;
mod sfu_backend;
mod sfu_media_plane;

pub use control_plane::{
    CallActor, CallAuthzReason, CallClock, CallControlPlane, CallError, CallStateReason,
    CreateCallInput, CreateCallResult, JoinCallResult, SystemCallClock, call_actor,
};
pub use fake_media_plane::{FakeMediaPlaneAdapter, FakeMediaPlaneOptions};
pub use media_plane::{
    AllocateSessionOptions, IssueJoinTokenOptions, MediaJoinGrant, MediaParticipant,
    MediaPlaneAdapter, MediaPlaneCapabilities, MediaPlaneError, MediaPlaneFuture,
    MediaPlaneTransport, MediaSession,
};
pub use p2p_media_plane::{P2pIceServer, P2pMediaPlaneAdapter, P2pMediaPlaneOptions, P2pTurnConfig};
pub use sfu_backend::{
    FakeSfuBackend, FakeSfuBackendOptions, MintAccessTokenOptions, SfuAccessToken, SfuBackend,
    SfuBackendError, SfuBackendFuture, SfuRoom,
};
pub use sfu_media_plane::SfuMediaPlaneAdapter;
