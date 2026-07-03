//! FR-15 call control-plane wire contract (`packages/protocol/src/calls.ts`).
//!
//! Call records sync as ordinary objects and WebRTC signaling rides
//! `SignalSend`/`SignalDeliver`; this module is the request/response RPC
//! pair for server-authoritative lifecycle commands. Opaque mediasoup
//! parameter bags stay dynamic [`Value`] maps, forwarded byte-for-byte.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::value::{Value, string_enum};

string_enum! {
    /// Media topology a call's media session is brokered over (FR-78).
    pub enum CallTransport {
        P2p => "p2p",
        Sfu => "sfu",
    }
}

string_enum! {
    /// Audio-only vs audio+video call (FR-79).
    pub enum CallKind {
        Audio => "audio",
        Video => "video",
    }
}

string_enum! {
    pub enum CallRoomState {
        Ringing => "ringing",
        Active => "active",
        Ended => "ended",
    }
}

string_enum! {
    pub enum CallInviteState {
        Ringing => "ringing",
        Accepted => "accepted",
        Declined => "declined",
        Cancelled => "cancelled",
    }
}

string_enum! {
    pub enum CallParticipantState {
        Joined => "joined",
        Left => "left",
    }
}

string_enum! {
    /// Coarse network-quality bucket (FR-82).
    pub enum CallNetworkQuality {
        Unknown => "unknown",
        Poor => "poor",
        Fair => "fair",
        Good => "good",
        Excellent => "excellent",
    }
}

string_enum! {
    /// Kinds of WebRTC signal relayed via the `WebRTCSignal` type.
    pub enum WebRTCSignalKind {
        Offer => "offer",
        Answer => "answer",
        Ice => "ice",
        Renegotiate => "renegotiate",
        SfuToken => "sfuToken",
        KeyEpoch => "keyEpoch",
    }
}

string_enum! {
    /// Media kind a producer/consumer carries.
    pub enum CallSfuMediaKind {
        Audio => "audio",
        Video => "video",
    }
}

string_enum! {
    /// Kinds of lightweight in-call data-channel envelope relayed via the
    /// `CallDataChannel` signal (AURA-316): ephemeral UX signaling that rides
    /// alongside the media plane rather than a `CallCommand` or a durable
    /// `CallEventStream` event.
    pub enum CallDataChannelKind {
        /// A transient emoji/reaction burst.
        Reaction => "reaction",
        /// A participant raising/lowering their hand.
        RaiseHand => "raiseHand",
        /// A live caption/transcription fragment.
        Caption => "caption",
    }
}

/// Canonical signal type name for WebRTC relay (`WEBRTC_SIGNAL_TYPE`).
pub const WEBRTC_SIGNAL_TYPE: &str = "WebRTCSignal";

/// Canonical signal type name for the in-call data-channel relay (AURA-316):
/// reactions / raise-hand / captions. Gated on the same call-membership check
/// as [`WEBRTC_SIGNAL_TYPE`] (FR-284), but kept as a distinct signal name so a
/// client can subscribe to/rate-limit UX chatter independently of SDP/ICE.
pub const CALL_DATA_CHANNEL_TYPE: &str = "CallDataChannel";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallRoomRecord {
    pub id: String,
    pub conversation_id: String,
    pub state: CallRoomState,
    pub created_by: String,
    pub kind: CallKind,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_session_id: Option<String>,
    /// Plain `string` in TS (not `CallTransport`) — kept that way.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallInviteRecord {
    pub id: String,
    pub call_id: String,
    pub invitee_user_id: String,
    pub status: CallInviteState,
    pub invited_by: String,
    pub invited_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub responded_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallParticipantRecord {
    pub id: String,
    pub call_id: String,
    pub user_id: String,
    pub device_id: String,
    pub state: CallParticipantState,
    pub joined_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left_at: Option<String>,
    pub mic_enabled: bool,
    pub camera_enabled: bool,
    pub screen_sharing: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaking: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network_quality: Option<CallNetworkQuality>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallMediaGrant {
    pub call_id: String,
    pub media_session_id: String,
    pub user_id: String,
    pub device_id: String,
    pub token: String,
    pub expires_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<IndexMap<String, String>>,
}

/// Partial media-state mutation for `setMediaState` (FR-82).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallMediaStatePatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mic_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_sharing: Option<bool>,
}

/// Discriminated union of every call control-plane command
/// (`CallCommandOp`). On the wire each command is a map whose first key is
/// the `op` discriminator string.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum CallCommandOp {
    #[serde(rename_all = "camelCase")]
    Create {
        conversation_id: String,
        /// Users to invite. Must be non-empty and must exclude the caller.
        invitee_user_ids: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kind: Option<CallKind>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        region_hint: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Join { call_id: String },
    #[serde(rename_all = "camelCase")]
    Accept { call_id: String },
    #[serde(rename_all = "camelCase")]
    Leave { call_id: String },
    #[serde(rename_all = "camelCase")]
    End { call_id: String },
    #[serde(rename_all = "camelCase")]
    SetMediaState {
        call_id: String,
        media: CallMediaStatePatch,
    },
    #[serde(rename_all = "camelCase")]
    SfuConnectTransport {
        call_id: String,
        token: String,
        transport_id: String,
        /// Opaque mediasoup DTLS parameters, forwarded uninterpreted.
        dtls_parameters: Value,
    },
    #[serde(rename_all = "camelCase")]
    SfuProduce {
        call_id: String,
        token: String,
        transport_id: String,
        kind: CallSfuMediaKind,
        /// Opaque mediasoup RTP parameters, forwarded uninterpreted.
        rtp_parameters: Value,
    },
    #[serde(rename_all = "camelCase")]
    SfuConsume {
        call_id: String,
        token: String,
        transport_id: String,
        producer_id: String,
        /// Opaque mediasoup RTP capabilities, forwarded uninterpreted.
        rtp_capabilities: Value,
    },
}

string_enum! {
    /// Names of the supported command operations (`CallCommandName`).
    pub enum CallCommandName {
        Create => "create",
        Join => "join",
        Accept => "accept",
        Leave => "leave",
        End => "end",
        SetMediaState => "setMediaState",
        SfuConnectTransport => "sfuConnectTransport",
        SfuProduce => "sfuProduce",
        SfuConsume => "sfuConsume",
    }
}

impl CallCommandOp {
    /// The discriminator string this command serializes under.
    #[must_use]
    pub fn name(&self) -> CallCommandName {
        match self {
            Self::Create { .. } => CallCommandName::Create,
            Self::Join { .. } => CallCommandName::Join,
            Self::Accept { .. } => CallCommandName::Accept,
            Self::Leave { .. } => CallCommandName::Leave,
            Self::End { .. } => CallCommandName::End,
            Self::SetMediaState { .. } => CallCommandName::SetMediaState,
            Self::SfuConnectTransport { .. } => CallCommandName::SfuConnectTransport,
            Self::SfuProduce { .. } => CallCommandName::SfuProduce,
            Self::SfuConsume { .. } => CallCommandName::SfuConsume,
        }
    }
}

/// A call command frame body (`CallCommandPayload`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallCommandPayload {
    pub request_id: String,
    pub command: CallCommandOp,
}

/// Result of `sfuProduce` (`CallSfuProduceResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallSfuProduceResult {
    pub producer_id: String,
    pub kind: CallSfuMediaKind,
}

/// Result of `sfuConsume` (`CallSfuConsumeResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallSfuConsumeResult {
    pub consumer_id: String,
    pub producer_id: String,
    pub kind: CallSfuMediaKind,
    pub rtp_parameters: Value,
}

/// The server's reply to a [`CallCommandPayload`] — fields populated per
/// command, failures ride the ordinary `Nack` frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallCommandResultPayload {
    pub request_id: String,
    pub op: CallCommandName,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room: Option<CallRoomRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invites: Option<Vec<CallInviteRecord>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub participant: Option<CallParticipantRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_grant: Option<CallMediaGrant>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invite: Option<CallInviteRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub producer: Option<CallSfuProduceResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consumer: Option<CallSfuConsumeResult>,
}
