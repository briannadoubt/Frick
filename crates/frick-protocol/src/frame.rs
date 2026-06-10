//! The Frick frame protocol (`packages/protocol/src/frame.ts`).
//!
//! Every frame is the msgpack encoding of a two-element array
//! `[FrameKind, payload]`. Payload maps carry string keys in the order the
//! TS interfaces declare them — mirrored by Rust field order — and absent
//! optional fields omit their keys entirely. Byte-level behavior is pinned
//! by the golden fixtures under `conformance/fixtures/wire/`.

use indexmap::IndexMap;
use serde::de::{self, SeqAccess, Visitor};
use serde::ser::SerializeTuple;
use serde::{Deserialize, Serialize};

use crate::calls::{CallCommandPayload, CallCommandResultPayload};
use crate::capabilities::{FrickClientCapabilities, FrickServerCapabilities};
use crate::codec::{PackedPresenceRecord, PackedRecord, PackedSignalEnvelope, PackedStreamEvent};
use crate::compatibility::SchemaCompatibilityResult;
use crate::errors::FrickErrorCode;
use crate::errors::FrickErrorEnvelope;
use crate::schema::FrickSchema;
use crate::value::{Value, stable_value, string_enum, to_value};

/// `PROTOCOL_VERSION` in TS.
pub const PROTOCOL_VERSION: i64 = 1;

/// Frame discriminants (`FrameKind` in TS). Values are the wire integers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum FrameKind {
    Hello = 0,
    Schema = 1,
    Subscribe = 2,
    Snapshot = 3,
    StreamPage = 4,
    Append = 5,
    Ack = 6,
    Nack = 7,
    Delta = 8,
    PresenceSet = 9,
    PresenceClear = 10,
    PresenceDelta = 11,
    SignalSend = 12,
    SignalDeliver = 13,
    CursorCommit = 14,
    Ping = 15,
    Pong = 16,
    SyncStatus = 17,
    HelloAck = 18,
    ProjectionDelta = 19,
    ObjectUpsert = 20,
    /// FR-15 — client→server call control-plane command.
    CallCommand = 21,
    /// FR-15 — server→client typed reply to a `CallCommand`.
    CallCommandResult = 22,
}

impl TryFrom<u64> for FrameKind {
    type Error = crate::errors::ProtocolError;

    fn try_from(value: u64) -> Result<Self, Self::Error> {
        Ok(match value {
            0 => Self::Hello,
            1 => Self::Schema,
            2 => Self::Subscribe,
            3 => Self::Snapshot,
            4 => Self::StreamPage,
            5 => Self::Append,
            6 => Self::Ack,
            7 => Self::Nack,
            8 => Self::Delta,
            9 => Self::PresenceSet,
            10 => Self::PresenceClear,
            11 => Self::PresenceDelta,
            12 => Self::SignalSend,
            13 => Self::SignalDeliver,
            14 => Self::CursorCommit,
            15 => Self::Ping,
            16 => Self::Pong,
            17 => Self::SyncStatus,
            18 => Self::HelloAck,
            19 => Self::ProjectionDelta,
            20 => Self::ObjectUpsert,
            21 => Self::CallCommand,
            22 => Self::CallCommandResult,
            other => {
                return Err(crate::errors::ProtocolError::new(format!(
                    "Unknown frame kind: {other}"
                )));
            }
        })
    }
}

string_enum! {
    /// `SubscriptionKind` in TS.
    pub enum SubscriptionKind {
        Object => "object",
        Stream => "stream",
        Presence => "presence",
        Signal => "signal",
        Projection => "projection",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloPayload {
    pub replica_id: String,
    pub device_id: String,
    pub schema_hash: String,
    pub known_cursors: IndexMap<String, i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_capabilities: Option<FrickClientCapabilities>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribePayload {
    pub subscription_id: String,
    pub kind: SubscriptionKind,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPayload {
    pub subscription_id: String,
    pub objects: Vec<PackedRecord>,
    pub cursor: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamPagePayload {
    pub subscription_id: String,
    pub events: Vec<PackedStreamEvent>,
    pub cursor: i64,
    pub has_more: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendPayload {
    pub request_id: String,
    pub stream: String,
    pub key: String,
    pub event: String,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AckPayload {
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<i64>,
    /// For object-write acks, the new version written to disk. Omitted for
    /// stream-append, presence, and signal acks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectUpsertPayload {
    /// Client-supplied identifier for ack/nack correlation.
    pub request_id: String,
    pub object_type: String,
    pub object_id: String,
    pub value: Value,
    /// Honored when the schema's `mergePolicy === "versionPrecondition"`;
    /// omit on create-intent. Ignored for `lastWriteWins` schemas.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NackPayload {
    pub request_id: String,
    pub error: FrickErrorEnvelope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<FrickErrorCode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloAckPayload {
    pub schema_hash: String,
    pub schema_id: String,
    pub schema_revision: i64,
    pub schema_compatibility: SchemaCompatibilityResult,
    pub server_capabilities: FrickServerCapabilities,
}

/// Identifies an object removed from a subscribed type (FR-142).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ObjectRemoval {
    #[serde(rename = "type")]
    pub object_type: String,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeltaPayload {
    pub objects: Vec<PackedRecord>,
    pub events: Vec<PackedStreamEvent>,
    pub cursor: i64,
    /// Objects deleted on the server since the last delta (FR-142).
    /// Optional and additive; absent on deltas that carry no deletions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed: Option<Vec<ObjectRemoval>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceSetPayload {
    pub request_id: String,
    pub name: String,
    pub key: String,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceClearPayload {
    pub request_id: String,
    pub name: String,
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceDeltaPayload {
    pub subscription_id: String,
    pub records: Vec<PackedPresenceRecord>,
    pub cleared: Vec<String>,
}

/// Payload for both `SignalSend` (`SignalPayload` in TS).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalPayload {
    pub request_id: String,
    pub name: String,
    pub key: String,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalDeliverPayload {
    pub envelope: PackedSignalEnvelope,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorCommitPayload {
    pub subscription_id: String,
    pub cursor: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingPayload {
    pub sent_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PongPayload {
    pub sent_at: i64,
    pub received_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusPayload {
    pub connected: bool,
    pub cursors: IndexMap<String, i64>,
    pub in_flight: i64,
}

/// One row change in a projection delta. `value` is a map to upsert or
/// [`Value::Nil`] to delete the row — nil crosses the wire as msgpack nil
/// under a present `value` key, exactly like TS `null`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionDeltaChange {
    /// Projection-defined row key, e.g. `"{userId}:{conversationId}"`.
    pub key: String,
    pub value: Value,
}

impl ProjectionDeltaChange {
    /// Whether this change deletes the row (`value === null` in TS).
    #[must_use]
    pub fn is_delete(&self) -> bool {
        self.value.is_nil()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionDeltaPayload {
    /// Registered projection name, e.g. `"activity-feed"`.
    pub projection: String,
    pub changes: Vec<ProjectionDeltaChange>,
}

/// A decoded Frick frame (`FrickFrame` in TS): `[kind, payload]` on the wire.
#[derive(Debug, Clone, PartialEq)]
pub enum FrickFrame {
    Hello(Box<HelloPayload>),
    Schema(Box<FrickSchema>),
    Subscribe(SubscribePayload),
    Snapshot(SnapshotPayload),
    StreamPage(StreamPagePayload),
    Append(AppendPayload),
    Ack(AckPayload),
    Nack(NackPayload),
    Delta(DeltaPayload),
    PresenceSet(PresenceSetPayload),
    PresenceClear(PresenceClearPayload),
    PresenceDelta(PresenceDeltaPayload),
    SignalSend(SignalPayload),
    SignalDeliver(SignalDeliverPayload),
    CursorCommit(CursorCommitPayload),
    Ping(PingPayload),
    Pong(PongPayload),
    SyncStatus(SyncStatusPayload),
    HelloAck(Box<HelloAckPayload>),
    ProjectionDelta(ProjectionDeltaPayload),
    ObjectUpsert(ObjectUpsertPayload),
    CallCommand(CallCommandPayload),
    CallCommandResult(Box<CallCommandResultPayload>),
}

impl FrickFrame {
    /// The frame's wire discriminant.
    #[must_use]
    pub fn kind(&self) -> FrameKind {
        match self {
            Self::Hello(_) => FrameKind::Hello,
            Self::Schema(_) => FrameKind::Schema,
            Self::Subscribe(_) => FrameKind::Subscribe,
            Self::Snapshot(_) => FrameKind::Snapshot,
            Self::StreamPage(_) => FrameKind::StreamPage,
            Self::Append(_) => FrameKind::Append,
            Self::Ack(_) => FrameKind::Ack,
            Self::Nack(_) => FrameKind::Nack,
            Self::Delta(_) => FrameKind::Delta,
            Self::PresenceSet(_) => FrameKind::PresenceSet,
            Self::PresenceClear(_) => FrameKind::PresenceClear,
            Self::PresenceDelta(_) => FrameKind::PresenceDelta,
            Self::SignalSend(_) => FrameKind::SignalSend,
            Self::SignalDeliver(_) => FrameKind::SignalDeliver,
            Self::CursorCommit(_) => FrameKind::CursorCommit,
            Self::Ping(_) => FrameKind::Ping,
            Self::Pong(_) => FrameKind::Pong,
            Self::SyncStatus(_) => FrameKind::SyncStatus,
            Self::HelloAck(_) => FrameKind::HelloAck,
            Self::ProjectionDelta(_) => FrameKind::ProjectionDelta,
            Self::ObjectUpsert(_) => FrameKind::ObjectUpsert,
            Self::CallCommand(_) => FrameKind::CallCommand,
            Self::CallCommandResult(_) => FrameKind::CallCommandResult,
        }
    }
}

impl Serialize for FrickFrame {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut tuple = serializer.serialize_tuple(2)?;
        tuple.serialize_element(&(self.kind() as u8))?;
        match self {
            Self::Hello(payload) => tuple.serialize_element(payload)?,
            // TS servers send validateSchema() output — a stableClone with
            // recursively sorted keys — so schemas serialize canonically.
            Self::Schema(payload) => {
                let dynamic = to_value(payload).map_err(serde::ser::Error::custom)?;
                tuple.serialize_element(&stable_value(&dynamic))?;
            }
            Self::Subscribe(payload) => tuple.serialize_element(payload)?,
            Self::Snapshot(payload) => tuple.serialize_element(payload)?,
            Self::StreamPage(payload) => tuple.serialize_element(payload)?,
            Self::Append(payload) => tuple.serialize_element(payload)?,
            Self::Ack(payload) => tuple.serialize_element(payload)?,
            Self::Nack(payload) => tuple.serialize_element(payload)?,
            Self::Delta(payload) => tuple.serialize_element(payload)?,
            Self::PresenceSet(payload) => tuple.serialize_element(payload)?,
            Self::PresenceClear(payload) => tuple.serialize_element(payload)?,
            Self::PresenceDelta(payload) => tuple.serialize_element(payload)?,
            Self::SignalSend(payload) => tuple.serialize_element(payload)?,
            Self::SignalDeliver(payload) => tuple.serialize_element(payload)?,
            Self::CursorCommit(payload) => tuple.serialize_element(payload)?,
            Self::Ping(payload) => tuple.serialize_element(payload)?,
            Self::Pong(payload) => tuple.serialize_element(payload)?,
            Self::SyncStatus(payload) => tuple.serialize_element(payload)?,
            Self::HelloAck(payload) => tuple.serialize_element(payload)?,
            Self::ProjectionDelta(payload) => tuple.serialize_element(payload)?,
            Self::ObjectUpsert(payload) => tuple.serialize_element(payload)?,
            Self::CallCommand(payload) => tuple.serialize_element(payload)?,
            Self::CallCommandResult(payload) => tuple.serialize_element(payload)?,
        }
        tuple.end()
    }
}

impl<'de> Deserialize<'de> for FrickFrame {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct FrameVisitor;

        impl<'de> Visitor<'de> for FrameVisitor {
            type Value = FrickFrame;

            fn expecting(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
                f.write_str("a [frameKind, payload] msgpack array")
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<FrickFrame, A::Error> {
                fn payload<'de, A: SeqAccess<'de>, T: Deserialize<'de>>(
                    seq: &mut A,
                ) -> Result<T, A::Error> {
                    seq.next_element::<T>()?
                        .ok_or_else(|| de::Error::invalid_length(1, &"a frame payload"))
                }

                let kind_number: u64 = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::invalid_length(0, &"a frame kind integer"))?;
                let kind = FrameKind::try_from(kind_number).map_err(de::Error::custom)?;

                Ok(match kind {
                    FrameKind::Hello => FrickFrame::Hello(Box::new(payload(&mut seq)?)),
                    FrameKind::Schema => FrickFrame::Schema(Box::new(payload(&mut seq)?)),
                    FrameKind::Subscribe => FrickFrame::Subscribe(payload(&mut seq)?),
                    FrameKind::Snapshot => FrickFrame::Snapshot(payload(&mut seq)?),
                    FrameKind::StreamPage => FrickFrame::StreamPage(payload(&mut seq)?),
                    FrameKind::Append => FrickFrame::Append(payload(&mut seq)?),
                    FrameKind::Ack => FrickFrame::Ack(payload(&mut seq)?),
                    FrameKind::Nack => FrickFrame::Nack(payload(&mut seq)?),
                    FrameKind::Delta => FrickFrame::Delta(payload(&mut seq)?),
                    FrameKind::PresenceSet => FrickFrame::PresenceSet(payload(&mut seq)?),
                    FrameKind::PresenceClear => FrickFrame::PresenceClear(payload(&mut seq)?),
                    FrameKind::PresenceDelta => FrickFrame::PresenceDelta(payload(&mut seq)?),
                    FrameKind::SignalSend => FrickFrame::SignalSend(payload(&mut seq)?),
                    FrameKind::SignalDeliver => FrickFrame::SignalDeliver(payload(&mut seq)?),
                    FrameKind::CursorCommit => FrickFrame::CursorCommit(payload(&mut seq)?),
                    FrameKind::Ping => FrickFrame::Ping(payload(&mut seq)?),
                    FrameKind::Pong => FrickFrame::Pong(payload(&mut seq)?),
                    FrameKind::SyncStatus => FrickFrame::SyncStatus(payload(&mut seq)?),
                    FrameKind::HelloAck => FrickFrame::HelloAck(Box::new(payload(&mut seq)?)),
                    FrameKind::ProjectionDelta => FrickFrame::ProjectionDelta(payload(&mut seq)?),
                    FrameKind::ObjectUpsert => FrickFrame::ObjectUpsert(payload(&mut seq)?),
                    FrameKind::CallCommand => FrickFrame::CallCommand(payload(&mut seq)?),
                    FrameKind::CallCommandResult => {
                        FrickFrame::CallCommandResult(Box::new(payload(&mut seq)?))
                    }
                })
            }
        }

        deserializer.deserialize_seq(FrameVisitor)
    }
}

/// Encode a frame to its exact wire bytes (`encodeFrame` in TS): msgpack,
/// structs as named maps, minimal-width integers and strings.
pub fn encode_frame(frame: &FrickFrame) -> Result<Vec<u8>, crate::errors::ProtocolError> {
    let mut buffer = Vec::new();
    let mut serializer = rmp_serde::Serializer::new(&mut buffer).with_struct_map();
    frame
        .serialize(&mut serializer)
        .map_err(|err| crate::errors::ProtocolError::new(format!("encode: {err}")))?;
    Ok(buffer)
}

/// Decode wire bytes into a frame (`decodeFrame` in TS). Tolerant of map key
/// order and unknown keys, exactly like the TS decoder.
pub fn decode_frame(bytes: &[u8]) -> Result<FrickFrame, crate::errors::ProtocolError> {
    rmp_serde::from_slice(bytes)
        .map_err(|err| crate::errors::ProtocolError::new(format!("decode: {err}")))
}

/// `rejectSchemaMismatch` in TS — same error message.
pub fn reject_schema_mismatch(
    client_hash: &str,
    server_hash: &str,
) -> Result<(), crate::errors::ProtocolError> {
    if client_hash != server_hash {
        return Err(crate::errors::ProtocolError::new(format!(
            "Schema mismatch: client={client_hash} server={server_hash}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ack_round_trips_and_omits_absent_optionals() {
        let frame = FrickFrame::Ack(AckPayload {
            request_id: "req-1".into(),
            cursor: None,
            version: None,
        });
        let bytes = encode_frame(&frame).unwrap();
        // fixarray(2), 6, fixmap(1), "requestId", "req-1"
        assert_eq!(bytes[0], 0x92);
        assert_eq!(bytes[1], 0x06);
        assert_eq!(bytes[2], 0x81);
        assert_eq!(decode_frame(&bytes).unwrap(), frame);
    }

    #[test]
    fn decode_accepts_any_map_key_order() {
        // {cursor: 7, requestId: "x"} — reversed key order.
        let bytes: Vec<u8> = vec![
            0x92, 0x06, 0x82, 0xA6, b'c', b'u', b'r', b's', b'o', b'r', 0x07, 0xA9, b'r', b'e',
            b'q', b'u', b'e', b's', b't', b'I', b'd', 0xA1, b'x',
        ];
        let FrickFrame::Ack(ack) = decode_frame(&bytes).unwrap() else {
            panic!("expected ack");
        };
        assert_eq!(ack.request_id, "x");
        assert_eq!(ack.cursor, Some(7));
    }

    #[test]
    fn unknown_frame_kind_errors() {
        let bytes = vec![0x92, 0x63, 0x80];
        assert!(decode_frame(&bytes).is_err());
    }
}
