//! Packed BLOB encoding for `packed` columns (map 03 §6).
//!
//! Every packed column is the msgpack encoding of a positional tuple from
//! `frick_protocol::codec` (`PackedRecord`, `PackedStreamEvent`, ...), using
//! the same encoder settings as the wire layer (structs as named maps,
//! minimal widths) so stored bytes match what `@msgpack/msgpack` produces.
//! `jobs.packed` is different: the raw encoding of an arbitrary payload
//! value, no schema field-id packing.

use serde::Serialize;
use serde::de::DeserializeOwned;

use frick_protocol::Value;

use crate::error::StoreError;

/// Encode a packed tuple (or any payload value) to its BLOB bytes.
pub fn encode_packed<T: Serialize>(value: &T) -> Result<Vec<u8>, StoreError> {
    let mut bytes = Vec::new();
    let mut serializer = rmp_serde::Serializer::new(&mut bytes).with_struct_map();
    value
        .serialize(&mut serializer)
        .map_err(|err| StoreError::driver(format!("packed encode: {err}")))?;
    Ok(bytes)
}

/// Decode BLOB bytes back into a packed tuple (or payload value).
pub fn decode_packed<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, StoreError> {
    rmp_serde::from_slice(bytes).map_err(|err| StoreError::driver(format!("packed decode: {err}")))
}

/// TS `withoutRecordId` (`object-store.ts:266-269`): strip the `id` key from
/// an object value before packing — unpack re-injects it first.
#[must_use]
pub fn without_record_id(value: &Value) -> Value {
    match value {
        Value::Map(entries) => Value::Map(
            entries
                .iter()
                .filter(|(key, _)| key.as_str() != Some("id"))
                .cloned()
                .collect(),
        ),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use frick_protocol::codec::PackedRecord;

    #[test]
    fn packed_record_round_trips() {
        let record: PackedRecord = (
            1,
            "user-1".to_string(),
            vec![(1, Value::from("Ada")), (2, Value::from(36))],
        );
        let bytes = encode_packed(&record).unwrap();
        // fixarray(3): typeId, recordId, fields
        assert_eq!(bytes[0], 0x93);
        let decoded: PackedRecord = decode_packed(&bytes).unwrap();
        assert_eq!(decoded, record);
    }

    #[test]
    fn without_record_id_strips_only_id() {
        let value = Value::Map(vec![
            ("id".into(), "user-1".into()),
            ("displayName".into(), "Ada".into()),
        ]);
        let stripped = without_record_id(&value);
        let Value::Map(entries) = &stripped else {
            panic!("expected map")
        };
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].0.as_str(), Some("displayName"));
    }
}
