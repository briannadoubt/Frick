//! The structured error envelope and the canonical error-code list.
//!
//! Mirrors `packages/protocol/src/errors.ts`. Codes are dotted-namespace
//! strings; the first segment is the subsystem and the second the specific
//! failure. The envelope's msgpack field order is pinned by the golden
//! fixtures.

use serde::{Deserialize, Serialize};

use crate::value::{Value, string_enum};

string_enum! {
    /// Canonical Frick error codes (`FRICK_ERROR_CODES` in TS).
    pub enum FrickErrorCode {
        AuthUnauthenticated => "auth.unauthenticated",
        AuthForbidden => "auth.forbidden",
        AuthSessionExpired => "auth.sessionExpired",
        SchemaIncompatible => "schema.incompatible",
        SchemaMigrationRequired => "schema.migrationRequired",
        StorageConflict => "storage.conflict",
        StorageNotFound => "storage.notFound",
        StreamAppendRejected => "stream.appendRejected",
        StreamInvalidCursor => "stream.invalidCursor",
        SyncProtocolError => "sync.protocolError",
        SyncReconnectExhausted => "sync.reconnectExhausted",
        BlobTooLarge => "blob.tooLarge",
        BlobUnsupportedContentType => "blob.unsupportedContentType",
        BlobQuotaExceeded => "blob.quotaExceeded",
        RateLimitExceeded => "rateLimit.exceeded",
        ServerInternal => "server.internal",
    }
}

/// The structured error envelope every Frick failure surfaces as
/// (`FrickErrorEnvelope` in TS). Field order matters on the wire.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrickErrorEnvelope {
    pub code: FrickErrorCode,
    pub message: String,
    pub request_id: String,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_revision: Option<i64>,
}

impl FrickErrorEnvelope {
    /// Shape-check a dynamic value, mirroring `isFrickErrorEnvelope`:
    /// required `code` (a known code) / `message` / `requestId` /
    /// `retryable`, with `details`, `schemaHash` (string), and
    /// `schemaRevision` optional.
    ///
    /// Two TS quirks are mirrored deliberately: the `details` guard is
    /// `typeof === "object" && !null && !Array.isArray`, which also accepts
    /// msgpack-decoded `Uint8Array`/`Date` (Binary/Ext here); and the
    /// `schemaRevision` guard is `Number.isInteger`, which accepts integral
    /// float64-encoded values. Duplicate map keys resolve last-wins, like JS
    /// object materialization.
    #[must_use]
    pub fn is_envelope_value(value: &Value) -> bool {
        let Value::Map(entries) = value else {
            return false;
        };
        let get = |name: &str| {
            entries
                .iter()
                .rev()
                .find(|(key, _)| key.as_str() == Some(name))
                .map(|(_, entry)| entry)
        };

        let code_is_known = get("code")
            .and_then(Value::as_str)
            .is_some_and(|code| code.parse::<FrickErrorCode>().is_ok());
        if !code_is_known
            || !get("message").is_some_and(rmpv::Value::is_str)
            || !get("requestId").is_some_and(rmpv::Value::is_str)
            || !get("retryable").is_some_and(rmpv::Value::is_bool)
        {
            return false;
        }
        if get("details")
            .is_some_and(|v| !(v.is_map() || matches!(v, Value::Binary(_) | Value::Ext(..))))
        {
            return false;
        }
        if get("schemaHash").is_some_and(|v| !v.is_str()) {
            return false;
        }
        let is_integer = |v: &Value| {
            v.as_i64().is_some()
                || v.as_u64().is_some()
                || v.as_f64()
                    .is_some_and(|f| f.is_finite() && f.fract() == 0.0)
        };
        if get("schemaRevision").is_some_and(|v| !is_integer(v)) {
            return false;
        }
        true
    }
}

/// Errors raised by protocol-layer operations (schema validation, codec
/// lookups, compatibility requirements). The TS implementation throws plain
/// `Error`s; the `Display` text here matches those messages exactly so
/// parity tests can compare them.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct ProtocolError {
    message: String,
}

impl ProtocolError {
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes_round_trip_their_wire_strings() {
        for code in FrickErrorCode::ALL {
            assert_eq!(code.as_str().parse::<FrickErrorCode>().unwrap(), *code);
        }
        assert_eq!(FrickErrorCode::ALL.len(), 16);
    }

    #[test]
    fn envelope_shape_check_matches_ts_semantics() {
        let valid = Value::Map(vec![
            ("code".into(), "storage.notFound".into()),
            ("message".into(), "missing".into()),
            ("requestId".into(), "req-1".into()),
            ("retryable".into(), Value::from(false)),
        ]);
        assert!(FrickErrorEnvelope::is_envelope_value(&valid));

        let unknown_code = Value::Map(vec![
            ("code".into(), "nope.nope".into()),
            ("message".into(), "missing".into()),
            ("requestId".into(), "req-1".into()),
            ("retryable".into(), Value::from(false)),
        ]);
        assert!(!FrickErrorEnvelope::is_envelope_value(&unknown_code));

        let bad_details = Value::Map(vec![
            ("code".into(), "storage.notFound".into()),
            ("message".into(), "missing".into()),
            ("requestId".into(), "req-1".into()),
            ("retryable".into(), Value::from(false)),
            ("details".into(), Value::Array(vec![])),
        ]);
        assert!(!FrickErrorEnvelope::is_envelope_value(&bad_details));
    }
}
