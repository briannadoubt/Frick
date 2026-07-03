//! Frick wire protocol: the MessagePack frame codec, schema identity, and the
//! structured error envelope.
//!
//! This crate is the Rust counterpart of `packages/protocol` and must stay
//! byte-compatible with it: every frame the TypeScript implementation encodes
//! must decode here, and frames encoded here must match the TS encoder
//! byte-for-byte. Compatibility is pinned by the golden fixtures under
//! `conformance/fixtures/wire/` (regenerate with `pnpm fixtures:wire`).
//!
//! Encoding ground rules inherited from `@msgpack/msgpack` defaults:
//!
//! - A frame is a two-element msgpack array `[FrameKind, payload]`.
//! - Payload maps carry string keys in TS-interface declaration order;
//!   absent optional fields omit their keys.
//! - Integers use the smallest msgpack width; non-integral numbers are
//!   float64; `Uint8Array` values are `bin` format.
//! - Schemas serialize in `validateSchema`'s normalized form: recursively
//!   key-sorted maps.

pub mod calls;
pub mod capabilities;
pub mod codec;
pub mod compatibility;
pub mod errors;
pub mod foundation;
pub mod frame;
pub mod schema;
pub mod value;

pub use calls::{
    CALL_DATA_CHANNEL_TYPE, CallCommandName, CallCommandOp, CallCommandPayload,
    CallCommandResultPayload, CallDataChannelKind, CallInviteRecord, CallKind, CallMediaGrant,
    CallMediaStatePatch, CallParticipantRecord, CallRoomRecord, CallSfuConsumeResult,
    CallSfuProduceResult, WEBRTC_SIGNAL_TYPE,
};
pub use capabilities::{
    FrickClientCapabilities, FrickClientPlatform, FrickSchemaCapability, FrickServerCapabilities,
    default_client_capabilities, default_server_capabilities, schema_capability,
    server_capability_names, unsupported_required_capabilities,
};
pub use codec::{
    PackedField, PackedPresenceRecord, PackedRecord, PackedSignalEnvelope, PackedStreamEvent,
    StreamEventInput, pack_object_record, pack_presence_record, pack_signal_envelope,
    pack_stream_event, unpack_object_record, unpack_presence_record, unpack_signal_envelope,
    unpack_stream_event,
};
pub use compatibility::{
    SchemaCompatibilityReason, SchemaCompatibilityResult, compare_schema_compatibility,
    require_schema_compatibility,
};
pub use errors::{FrickErrorCode, FrickErrorEnvelope, ProtocolError};
pub use foundation::foundation_schema;
pub use frame::{
    FrameKind, FrickFrame, PROTOCOL_VERSION, decode_frame, encode_frame, reject_schema_mismatch,
};
pub use schema::{FrickSchema, PlainObject, validate_schema};
pub use value::Value;
