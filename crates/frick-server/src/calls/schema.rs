//! FR-282 (calls phase B) — the call control-plane schema.
//!
//! Ports the deleted `apps/server/src/calls/call-schema.ts`. The control plane
//! persists `CallRoom` / `CallInvite` / `CallParticipant` as ordinary objects
//! (no new tables), appends durable lifecycle events to the `CallEventStream`,
//! and routes WebRTC SDP/ICE over the `WebRTCSignal` signal. These definitions
//! carry no fixed type-ids of their own: [`call_object_defs`] (and the stream /
//! event / signal counterparts) take an `id_base` so a host can splice the call
//! types into its own schema with whatever ids it has free. [`build_call_schema`]
//! stitches them into a complete, self-contained schema for a call-only
//! deployment or the control-plane tests (FR-283).

use frick_protocol::schema::{
    EventDef, FieldDef, FieldKind, FrickSchema, IndexDef, ObjectDef, SignalDef, StreamDef,
};

/// Object type name for a call room.
pub const CALL_ROOM_TYPE: &str = "CallRoom";
/// Object type name for a call invite.
pub const CALL_INVITE_TYPE: &str = "CallInvite";
/// Object type name for a call participant.
pub const CALL_PARTICIPANT_TYPE: &str = "CallParticipant";
/// Stream name for the durable call event log.
pub const CALL_EVENT_STREAM: &str = "CallEventStream";
/// Signal name for WebRTC SDP/ICE routing during a call.
pub const WEBRTC_SIGNAL: &str = "WebRTCSignal";
/// Signal name for the in-call data-channel relay (AURA-316): reactions,
/// raise-hand, and live captions. A second, distinct signal from
/// [`WEBRTC_SIGNAL`] so a client can subscribe to/rate-limit ephemeral UX
/// chatter independently of SDP/ICE negotiation; gated on the same
/// [`super::control_plane::CallControlPlane::is_signal_member`] check
/// (FR-284) in the gateway.
pub const CALL_DATA_CHANNEL: &str = "CallDataChannel";

/// Lifecycle event names appended to the [`CALL_EVENT_STREAM`].
pub const CALL_CREATED: &str = "CallCreated";
pub const CALL_INVITE_SENT: &str = "CallInviteSent";
pub const CALL_INVITE_ACCEPTED: &str = "CallInviteAccepted";
pub const CALL_PARTICIPANT_JOINED: &str = "CallParticipantJoined";
pub const CALL_PARTICIPANT_MEDIA_CHANGED: &str = "CallParticipantMediaChanged";
pub const CALL_PARTICIPANT_LEFT: &str = "CallParticipantLeft";
pub const CALL_ENDED: &str = "CallEnded";

/// Lifecycle states a `CallRoom` moves through.
pub const CALL_ROOM_STATES: &[&str] = &["ringing", "active", "ended"];
/// Lifecycle states a `CallInvite` moves through.
pub const CALL_INVITE_STATES: &[&str] = &["ringing", "accepted", "declined", "cancelled"];
/// Lifecycle states a `CallParticipant` moves through.
pub const CALL_PARTICIPANT_STATES: &[&str] = &["joined", "left"];

fn field(id: i64, name: &str, kind: FieldKind, required: bool) -> FieldDef {
    FieldDef {
        id,
        name: name.to_string(),
        kind,
        required,
        ref_: None,
        enum_values: None,
        sensitivity: None,
    }
}

fn enum_field(id: i64, name: &str, values: &[&str], required: bool) -> FieldDef {
    FieldDef {
        id,
        name: name.to_string(),
        kind: FieldKind::Enum,
        required,
        ref_: None,
        enum_values: Some(values.iter().map(|v| (*v).to_string()).collect()),
        sensitivity: None,
    }
}

fn index(id: i64, name: &str, fields: &[&str]) -> IndexDef {
    IndexDef {
        id,
        name: name.to_string(),
        fields: fields.iter().map(|f| (*f).to_string()).collect(),
    }
}

/// Object definitions for the call control plane, numbered from `id_base`.
#[must_use]
pub fn call_object_defs(id_base: i64) -> Vec<ObjectDef> {
    vec![
        ObjectDef {
            id: id_base,
            name: CALL_ROOM_TYPE.to_string(),
            fields: vec![
                field(1, "conversationId", FieldKind::String, true),
                enum_field(2, "state", CALL_ROOM_STATES, true),
                field(3, "createdBy", FieldKind::String, true),
                enum_field(4, "kind", &["audio", "video"], true),
                field(5, "createdAt", FieldKind::Timestamp, true),
                field(6, "startedAt", FieldKind::Timestamp, false),
                field(7, "endedAt", FieldKind::Timestamp, false),
                field(8, "mediaSessionId", FieldKind::String, false),
                field(9, "transport", FieldKind::String, false),
            ],
            indexes: vec![index(1, "byConversation", &["conversationId", "state"])],
            merge_policy: None,
        },
        ObjectDef {
            id: id_base + 1,
            name: CALL_INVITE_TYPE.to_string(),
            fields: vec![
                field(1, "callId", FieldKind::String, true),
                field(2, "inviteeUserId", FieldKind::String, true),
                enum_field(3, "status", CALL_INVITE_STATES, true),
                field(4, "invitedBy", FieldKind::String, true),
                field(5, "invitedAt", FieldKind::Timestamp, true),
                field(6, "respondedAt", FieldKind::Timestamp, false),
            ],
            indexes: vec![index(1, "byCall", &["callId", "inviteeUserId"])],
            merge_policy: None,
        },
        ObjectDef {
            id: id_base + 2,
            name: CALL_PARTICIPANT_TYPE.to_string(),
            fields: vec![
                field(1, "callId", FieldKind::String, true),
                field(2, "userId", FieldKind::String, true),
                field(3, "deviceId", FieldKind::String, true),
                enum_field(4, "state", CALL_PARTICIPANT_STATES, true),
                field(5, "joinedAt", FieldKind::Timestamp, true),
                field(6, "leftAt", FieldKind::Timestamp, false),
                field(7, "micEnabled", FieldKind::Bool, true),
                field(8, "cameraEnabled", FieldKind::Bool, true),
                field(9, "screenSharing", FieldKind::Bool, true),
            ],
            indexes: vec![index(1, "byCall", &["callId", "userId"])],
            merge_policy: None,
        },
    ]
}

/// Event definitions emitted on the [`CALL_EVENT_STREAM`], numbered from
/// `id_base`.
#[must_use]
pub fn call_event_defs(id_base: i64) -> Vec<EventDef> {
    vec![
        EventDef {
            id: id_base,
            name: CALL_CREATED.to_string(),
            fields: vec![
                field(1, "callId", FieldKind::String, true),
                field(2, "conversationId", FieldKind::String, true),
                field(3, "createdBy", FieldKind::String, true),
                field(4, "kind", FieldKind::String, true),
                field(5, "createdAt", FieldKind::Timestamp, true),
            ],
        },
        EventDef {
            id: id_base + 1,
            name: CALL_INVITE_SENT.to_string(),
            fields: vec![
                field(1, "callId", FieldKind::String, true),
                field(2, "inviteeUserId", FieldKind::String, true),
                field(3, "invitedBy", FieldKind::String, true),
            ],
        },
        EventDef {
            id: id_base + 2,
            name: CALL_INVITE_ACCEPTED.to_string(),
            fields: vec![
                field(1, "callId", FieldKind::String, true),
                field(2, "inviteeUserId", FieldKind::String, true),
            ],
        },
        EventDef {
            id: id_base + 3,
            name: CALL_PARTICIPANT_JOINED.to_string(),
            fields: vec![
                field(1, "callId", FieldKind::String, true),
                field(2, "userId", FieldKind::String, true),
                field(3, "deviceId", FieldKind::String, true),
                field(4, "joinedAt", FieldKind::Timestamp, true),
            ],
        },
        EventDef {
            id: id_base + 4,
            name: CALL_PARTICIPANT_MEDIA_CHANGED.to_string(),
            fields: vec![
                field(1, "callId", FieldKind::String, true),
                field(2, "userId", FieldKind::String, true),
                field(3, "deviceId", FieldKind::String, true),
                field(4, "micEnabled", FieldKind::Bool, true),
                field(5, "cameraEnabled", FieldKind::Bool, true),
                field(6, "screenSharing", FieldKind::Bool, true),
            ],
        },
        EventDef {
            id: id_base + 5,
            name: CALL_PARTICIPANT_LEFT.to_string(),
            fields: vec![
                field(1, "callId", FieldKind::String, true),
                field(2, "userId", FieldKind::String, true),
                field(3, "deviceId", FieldKind::String, true),
                field(4, "leftAt", FieldKind::Timestamp, true),
            ],
        },
        EventDef {
            id: id_base + 6,
            name: CALL_ENDED.to_string(),
            fields: vec![
                field(1, "callId", FieldKind::String, true),
                field(2, "endedBy", FieldKind::String, true),
                field(3, "endedAt", FieldKind::Timestamp, true),
            ],
        },
    ]
}

/// Stream definition for the call event log, numbered from `id_base`.
#[must_use]
pub fn call_stream_defs(id_base: i64) -> Vec<StreamDef> {
    vec![StreamDef {
        id: id_base,
        name: CALL_EVENT_STREAM.to_string(),
        key_fields: vec![field(1, "callId", FieldKind::String, true)],
        events: vec![
            CALL_CREATED.to_string(),
            CALL_INVITE_SENT.to_string(),
            CALL_INVITE_ACCEPTED.to_string(),
            CALL_PARTICIPANT_JOINED.to_string(),
            CALL_PARTICIPANT_MEDIA_CHANGED.to_string(),
            CALL_PARTICIPANT_LEFT.to_string(),
            CALL_ENDED.to_string(),
        ],
    }]
}

/// Signal definitions for WebRTC SDP/ICE routing and the in-call data-channel
/// relay, numbered from `id_base`. Payloads ride as opaque `bytes`; both
/// relays are gated on call membership (FR-284 / AURA-316) — see
/// `handle_signal` in the gateway.
#[must_use]
pub fn call_signal_defs(id_base: i64) -> Vec<SignalDef> {
    vec![
        SignalDef {
            id: id_base,
            name: WEBRTC_SIGNAL.to_string(),
            ttl_ms: 30_000,
            key_fields: vec![field(1, "callId", FieldKind::String, true)],
            fields: vec![
                field(1, "senderDeviceId", FieldKind::String, true),
                field(2, "recipientDeviceId", FieldKind::String, false),
                enum_field(
                    3,
                    "kind",
                    // Lists every WebRTCSignalKind the wire type carries —
                    // including `keyEpoch` (the E2EE sender-key epoch signal).
                    // Signal `value`s are dynamic msgpack (not
                    // schema-validated), so this is metadata for codegen/docs;
                    // the legacy TS schema omitted `keyEpoch`, this completes
                    // it (deliberately ahead of the old fixture).
                    &[
                        "offer",
                        "answer",
                        "ice",
                        "renegotiate",
                        "sfuToken",
                        "keyEpoch",
                    ],
                    true,
                ),
                field(4, "payload", FieldKind::Bytes, true),
            ],
        },
        call_data_channel_signal_def(id_base + 1),
    ]
}

/// Signal definition for the in-call data-channel relay (AURA-316):
/// reactions / raise-hand / captions. Deliberately separate from
/// [`WEBRTC_SIGNAL`] (a distinct signal name) so a client can subscribe to or
/// throttle ephemeral UX chatter independently of SDP/ICE — the payload is
/// small, unreliable-by-nature (a dropped reaction is fine to lose), and
/// unrelated to media negotiation. Keyed by `callId`, same as `WebRTCSignal`;
/// the gateway applies the identical `is_signal_member` membership gate to
/// both (FR-284).
#[must_use]
pub fn call_data_channel_signal_def(id: i64) -> SignalDef {
    SignalDef {
        id,
        name: CALL_DATA_CHANNEL.to_string(),
        // Short TTL: this is ephemeral live UX signaling, not durable state —
        // an offline recipient does not need a reaction replayed minutes later.
        ttl_ms: 10_000,
        key_fields: vec![field(1, "callId", FieldKind::String, true)],
        fields: vec![
            field(1, "senderUserId", FieldKind::String, true),
            field(2, "senderDeviceId", FieldKind::String, true),
            enum_field(3, "kind", &["reaction", "raiseHand", "caption"], true),
            // Opaque per-kind body: e.g. `{emoji}` for a reaction, `{active}`
            // for raise-hand, `{text, isFinal}` for a caption fragment. Signal
            // `value`s are dynamic msgpack (not schema-validated), so this is
            // metadata for codegen/docs, mirroring `WebRTCSignal.payload`.
            field(4, "payload", FieldKind::Bytes, true),
        ],
    }
}

/// Build a complete, self-contained [`FrickSchema`] carrying only the call
/// control-plane types — suitable as a default for a call-only deployment and
/// used by the FR-283 control-plane tests. Hosts that also run chat splice the
/// `call_*_defs(id_base)` arrays into their own schema instead.
#[must_use]
pub fn build_call_schema() -> FrickSchema {
    FrickSchema {
        name: "frick-calls".to_string(),
        schema_id: "frick-calls".to_string(),
        schema_version: "0.1.0".to_string(),
        schema_revision: 1,
        minimum_client_revision: 1,
        minimum_server_revision: 1,
        protocol: "frick.realtime".to_string(),
        protocol_version: 1,
        compatibility: "greenfield-cutover".to_string(),
        hash: "frick-calls-0.1.0".to_string(),
        objects: call_object_defs(1),
        streams: call_stream_defs(1),
        events: call_event_defs(1),
        presences: vec![],
        signals: call_signal_defs(1),
        blobs: vec![],
        jobs: vec![],
        projections: vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_call_schema_is_structurally_valid() {
        let schema = build_call_schema();
        frick_protocol::schema::validate_schema(&schema).expect("call schema validates");
        assert_eq!(schema.objects.len(), 3);
        assert_eq!(schema.events.len(), 7);
        assert_eq!(schema.streams.len(), 1);
        assert_eq!(schema.signals.len(), 2);
    }

    #[test]
    fn def_ids_are_offset_by_id_base_for_splicing() {
        // A host splicing the call types in at a free id range gets contiguous,
        // offset ids (so they don't collide with the host's own types).
        let objects = call_object_defs(40);
        assert_eq!(objects[0].id, 40);
        assert_eq!(objects[1].id, 41);
        assert_eq!(objects[2].id, 42);
        let events = call_event_defs(50);
        assert_eq!(events.first().map(|e| e.id), Some(50));
        assert_eq!(events.last().map(|e| e.id), Some(56));
        // The data-channel relay signal is spliced in right after WebRTCSignal
        // (AURA-316), so a host reserving `n` ids for `call_signal_defs` keeps
        // both signals contiguous.
        let signals = call_signal_defs(60);
        assert_eq!(signals.len(), 2);
        assert_eq!(signals[0].id, 60);
        assert_eq!(signals[0].name, WEBRTC_SIGNAL);
        assert_eq!(signals[1].id, 61);
        assert_eq!(signals[1].name, CALL_DATA_CHANNEL);
    }

    #[test]
    fn call_data_channel_signal_is_keyed_by_call_id_and_carries_a_kind_enum() {
        // AURA-316: the data-channel relay reuses the same `callId` key shape
        // as `WebRTCSignal` (so `is_signal_member`'s call-id lookup applies
        // unchanged) and enumerates exactly the reactions/raise-hand/captions
        // envelope kinds the ticket asks for.
        let signal = call_data_channel_signal_def(1);
        assert_eq!(signal.name, CALL_DATA_CHANNEL);
        assert_eq!(
            signal
                .key_fields
                .iter()
                .map(|f| f.name.as_str())
                .collect::<Vec<_>>(),
            vec!["callId"]
        );
        let kind = signal
            .fields
            .iter()
            .find(|f| f.name == "kind")
            .expect("kind field");
        assert_eq!(
            kind.enum_values.as_deref(),
            Some(
                vec![
                    "reaction".to_string(),
                    "raiseHand".to_string(),
                    "caption".to_string(),
                ]
                .as_slice()
            )
        );
        // Ephemeral by design: short TTL relative to the durable call-event
        // stream, and strictly shorter than the WebRTCSignal TTL since a stale
        // reaction is worthless.
        let webrtc = call_signal_defs(1)
            .into_iter()
            .find(|s| s.name == WEBRTC_SIGNAL)
            .expect("webrtc signal");
        assert!(signal.ttl_ms < webrtc.ttl_ms);
    }

    #[test]
    fn call_room_omits_an_explicit_id_field_like_the_ts_schema() {
        // The record id rides the packed tuple's id slot, not the field list
        // (the same id-less-object wire case the conformance suite pins).
        let room = &call_object_defs(1)[0];
        assert!(room.fields.iter().all(|f| f.kind != FieldKind::Id));
        assert_eq!(
            room.fields.first().map(|f| f.name.as_str()),
            Some("conversationId")
        );
    }
}
