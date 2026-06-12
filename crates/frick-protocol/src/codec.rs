//! Packed-record codec (`packages/protocol/src/codec.ts`).
//!
//! Records cross the wire as positional msgpack arrays with numeric field
//! ids: `PackedRecord = [typeId, recordId, [[fieldId, value], ...]]` and
//! friends. Field order inside the packed array follows the *value map's*
//! insertion order (TS iterates `Object.entries`), and unpacking emits the
//! packed order — both preserved here via [`Value`] maps.

use serde::{Deserialize, Serialize};

use crate::errors::ProtocolError;
use crate::schema::{
    FieldDef, FrickSchema, event_by_id, event_by_name, field_by_id, field_by_name, object_by_id,
    object_by_name, presence_by_id, presence_by_name, signal_by_id, signal_by_name, stream_by_id,
    stream_by_name,
};
use crate::value::Value;

/// `[fieldId, value]`.
pub type PackedField = (i64, Value);

/// `[typeId, recordId, fields]`.
pub type PackedRecord = (i64, String, Vec<PackedField>);

/// `[streamTypeId, streamKey, sequence, eventId, eventTypeId, fields]`.
pub type PackedStreamEvent = (i64, String, i64, String, i64, Vec<PackedField>);

/// `[presenceTypeId, presenceKey, fields]`.
pub type PackedPresenceRecord = (i64, String, Vec<PackedField>);

/// `[signalTypeId, signalKey, fields]`.
pub type PackedSignalEnvelope = (i64, String, Vec<PackedField>);

/// `StreamEventInput` in TS — the unpacked form of a stream event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamEventInput {
    pub stream: String,
    pub stream_id: String,
    pub sequence: i64,
    pub event_id: String,
    pub event: String,
    pub payload: Value,
}

/// An unpacked object record (`{ type, id, value }` in TS).
#[derive(Debug, Clone, PartialEq)]
pub struct UnpackedRecord {
    pub record_type: String,
    pub id: String,
    pub value: Value,
}

/// An unpacked presence record / signal envelope (`{ type, key, value }`).
#[derive(Debug, Clone, PartialEq)]
pub struct UnpackedKeyedRecord {
    pub record_type: String,
    pub key: String,
    pub value: Value,
}

type Result<T> = core::result::Result<T, ProtocolError>;

pub fn pack_object_record(
    schema: &FrickSchema,
    object_name: &str,
    object_id: &str,
    value: &Value,
) -> Result<PackedRecord> {
    let object = object_by_name(schema, object_name)?;
    Ok((
        object.id,
        object_id.to_string(),
        pack_fields(&object.fields, value)?,
    ))
}

/// Unpack an object record. As in TS, the returned value map carries `id`
/// first, then the packed fields in packed order.
pub fn unpack_object_record(schema: &FrickSchema, packed: &PackedRecord) -> Result<UnpackedRecord> {
    let object = object_by_id(schema, packed.0)?;
    let mut entries: Vec<(Value, Value)> =
        vec![("id".into(), Value::String(packed.1.clone().into()))];
    unpack_fields_into(&object.fields, &packed.2, &mut entries)?;
    Ok(UnpackedRecord {
        record_type: object.name.clone(),
        id: packed.1.clone(),
        value: Value::Map(entries),
    })
}

pub fn pack_stream_event(
    schema: &FrickSchema,
    input: &StreamEventInput,
) -> Result<PackedStreamEvent> {
    let stream = stream_by_name(schema, &input.stream)?;
    let event = event_by_name(schema, &input.event)?;
    Ok((
        stream.id,
        input.stream_id.clone(),
        input.sequence,
        input.event_id.clone(),
        event.id,
        pack_fields(&event.fields, &input.payload)?,
    ))
}

pub fn unpack_stream_event(
    schema: &FrickSchema,
    packed: &PackedStreamEvent,
) -> Result<StreamEventInput> {
    let stream = stream_by_id(schema, packed.0)?;
    let event = event_by_id(schema, packed.4)?;
    Ok(StreamEventInput {
        stream: stream.name.clone(),
        stream_id: packed.1.clone(),
        sequence: packed.2,
        event_id: packed.3.clone(),
        event: event.name.clone(),
        payload: unpack_fields(&event.fields, &packed.5)?,
    })
}

pub fn pack_presence_record(
    schema: &FrickSchema,
    presence_name: &str,
    presence_key: &str,
    value: &Value,
) -> Result<PackedPresenceRecord> {
    let presence = presence_by_name(schema, presence_name)?;
    Ok((
        presence.id,
        presence_key.to_string(),
        pack_fields(&presence.fields, value)?,
    ))
}

pub fn unpack_presence_record(
    schema: &FrickSchema,
    packed: &PackedPresenceRecord,
) -> Result<UnpackedKeyedRecord> {
    let presence = presence_by_id(schema, packed.0)?;
    Ok(UnpackedKeyedRecord {
        record_type: presence.name.clone(),
        key: packed.1.clone(),
        value: unpack_fields(&presence.fields, &packed.2)?,
    })
}

pub fn pack_signal_envelope(
    schema: &FrickSchema,
    signal_name: &str,
    signal_key: &str,
    value: &Value,
) -> Result<PackedSignalEnvelope> {
    let signal = signal_by_name(schema, signal_name)?;
    Ok((
        signal.id,
        signal_key.to_string(),
        pack_fields(&signal.fields, value)?,
    ))
}

pub fn unpack_signal_envelope(
    schema: &FrickSchema,
    packed: &PackedSignalEnvelope,
) -> Result<UnpackedKeyedRecord> {
    let signal = signal_by_id(schema, packed.0)?;
    Ok(UnpackedKeyedRecord {
        record_type: signal.name.clone(),
        key: packed.1.clone(),
        value: unpack_fields(&signal.fields, &packed.2)?,
    })
}

/// TS `packFields` iterates `Object.entries(value)`. Two of its quirks carry
/// over: the @msgpack/msgpack decoder stringifies integer map keys (so a
/// foreign frame's integer key `42` packs as the field named `"42"`), and
/// scalar inputs (numbers/booleans) produce zero entries rather than erroring.
/// Accepted deviation: TS turns string inputs into char-index entries and
/// throws a bare `TypeError` for nil; Rust reports "expected an object value"
/// for both (see `internal/rust-rewrite/maps/01-protocol-wire.md`).
fn pack_fields(fields: &[FieldDef], value: &Value) -> Result<Vec<PackedField>> {
    let entries = match value {
        Value::Map(entries) => entries,
        Value::Boolean(_) | Value::Integer(_) | Value::F32(_) | Value::F64(_) => {
            return Ok(Vec::new());
        }
        _ => return Err(ProtocolError::new("expected an object value")),
    };
    entries
        .iter()
        .map(|(key, entry)| {
            let integer_name;
            let name = match key {
                Value::String(text) => text
                    .as_str()
                    .ok_or_else(|| ProtocolError::new("expected string field names"))?,
                Value::Integer(int) => {
                    integer_name = int.to_string();
                    &integer_name
                }
                _ => return Err(ProtocolError::new("expected string field names")),
            };
            let field = field_by_name(fields, name)?;
            Ok((field.id, entry.clone()))
        })
        .collect()
}

fn unpack_fields(fields: &[FieldDef], packed: &[PackedField]) -> Result<Value> {
    let mut entries = Vec::with_capacity(packed.len());
    unpack_fields_into(fields, packed, &mut entries)?;
    Ok(Value::Map(entries))
}

/// Mirrors JS property assignment: one entry per key name — first insertion
/// keeps its position, the last write wins. This matters when a schema
/// declares its own `id` field (the packed value overwrites the injected
/// record id without duplicating the key) and for repeated field ids in
/// foreign input.
fn unpack_fields_into(
    fields: &[FieldDef],
    packed: &[PackedField],
    entries: &mut Vec<(Value, Value)>,
) -> Result<()> {
    for (field_id, value) in packed {
        let field = field_by_id(fields, *field_id)?;
        let existing = entries
            .iter_mut()
            .find(|(key, _)| key.as_str() == Some(field.name.as_str()));
        match existing {
            Some((_, slot)) => *slot = value.clone(),
            None => entries.push((field.name.as_str().into(), value.clone())),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{FieldKind, ObjectDef};

    fn schema_with_user() -> FrickSchema {
        FrickSchema {
            name: "test".into(),
            schema_id: "test".into(),
            schema_version: "0.1.0".into(),
            schema_revision: 1,
            minimum_client_revision: 1,
            minimum_server_revision: 1,
            protocol: "frick.realtime".into(),
            protocol_version: 1,
            compatibility: "greenfield-cutover".into(),
            hash: "test-hash".into(),
            objects: vec![ObjectDef {
                id: 1,
                name: "User".into(),
                fields: vec![
                    FieldDef {
                        id: 1,
                        name: "displayName".into(),
                        kind: FieldKind::String,
                        required: true,
                        ref_: None,
                        enum_values: None,
                        sensitivity: None,
                    },
                    FieldDef {
                        id: 2,
                        name: "age".into(),
                        kind: FieldKind::Int,
                        required: false,
                        ref_: None,
                        enum_values: None,
                        sensitivity: None,
                    },
                ],
                indexes: vec![],
                merge_policy: None,
            }],
            streams: vec![],
            events: vec![],
            presences: vec![],
            signals: vec![],
            blobs: vec![],
            jobs: vec![],
            projections: vec![],
        }
    }

    #[test]
    fn object_record_round_trips_with_id_first() {
        let schema = schema_with_user();
        let value = Value::Map(vec![
            ("displayName".into(), "Ada".into()),
            ("age".into(), Value::from(36)),
        ]);
        let packed = pack_object_record(&schema, "User", "user-1", &value).unwrap();
        assert_eq!(packed.0, 1);
        assert_eq!(packed.2[0].0, 1);

        let unpacked = unpack_object_record(&schema, &packed).unwrap();
        assert_eq!(unpacked.record_type, "User");
        let Value::Map(entries) = &unpacked.value else {
            panic!("expected map")
        };
        assert_eq!(entries[0].0.as_str(), Some("id"));
        assert_eq!(entries[1].0.as_str(), Some("displayName"));
    }

    #[test]
    fn unknown_field_matches_ts_error() {
        let schema = schema_with_user();
        let value = Value::Map(vec![("nope".into(), "x".into())]);
        let error = pack_object_record(&schema, "User", "user-1", &value).unwrap_err();
        assert_eq!(error.message(), "Unknown field nope");
    }
}
