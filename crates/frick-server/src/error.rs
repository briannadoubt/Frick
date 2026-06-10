//! Server errors and their mapping to HTTP status + the structured error
//! envelope (`sendError` / `httpErrorCode`, `src/server.ts:3266-3402`).
//!
//! The envelope's `schemaHash`/`schemaRevision` are intentionally stamped
//! from the foundation schema, not the active app schema, matching the TS
//! gotcha at `src/server.ts:3341-3342`.

use frick_protocol::{FrickErrorCode, FrickErrorEnvelope, Value, foundation_schema};

/// A limit that was exceeded — selects both the HTTP status and the error
/// code (`FrickLimitError` in TS).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitKind {
    MaxBlobBytes,
    MaxBlobBytesPerPrincipal,
    MaxStreamAppendPayloadBytes,
    MaxSseConnections,
    MaxAuthAttemptsPerWindow,
    Other,
}

/// The server-level error taxonomy. Each variant maps to a fixed HTTP status
/// and `FrickErrorCode` per the TS `sendError`/`httpErrorCode` tables.
#[derive(Debug, Clone, thiserror::Error)]
pub enum ServerError {
    #[error("{message}")]
    Authentication { message: String },
    #[error("session expired")]
    SessionExpired,
    #[error("{message}")]
    Authorization {
        message: String,
        reason: Option<String>,
    },
    #[error("origin not allowed")]
    CorsOriginRejected,
    #[error("unknown tenant: {tenant_id}")]
    UnknownTenant { tenant_id: String },
    #[error("limit exceeded")]
    Limit { kind: LimitKind, detail: Value },
    #[error("unsupported content type")]
    BlobValidationRejected,
    #[error("invalid stream cursor")]
    InvalidStreamCursor,
    #[error("projection not found: {projection}")]
    ProjectionNotFound { projection: String },
    #[error("search index not found: {index}")]
    SearchIndexNotFound { index: String },
    #[error("admin audit write failed")]
    AdminAuditWrite,
    #[error("storage conflict")]
    StorageConflict { detail: Value },
    /// Catch-all → HTTP 400, `sync.protocolError`.
    #[error("{message}")]
    BadRequest { message: String },
    #[error("internal error")]
    Internal,
}

impl ServerError {
    /// HTTP status (`src/server.ts:3267-3284`).
    #[must_use]
    pub fn http_status(&self) -> u16 {
        match self {
            Self::Authentication { .. } | Self::SessionExpired => 401,
            Self::Authorization { .. } | Self::CorsOriginRejected | Self::UnknownTenant { .. } => {
                403
            }
            Self::Limit { kind, .. } => match kind {
                LimitKind::MaxSseConnections | LimitKind::MaxAuthAttemptsPerWindow => 429,
                _ => 413,
            },
            Self::BlobValidationRejected => 415,
            Self::ProjectionNotFound { .. } | Self::SearchIndexNotFound { .. } => 404,
            Self::AdminAuditWrite | Self::Internal => 500,
            Self::InvalidStreamCursor | Self::StorageConflict { .. } | Self::BadRequest { .. } => {
                // storage.conflict is 409 in the inline per-route handlers.
                if matches!(self, Self::StorageConflict { .. }) {
                    409
                } else {
                    400
                }
            }
        }
    }

    /// Error code (`httpErrorCode`, `src/server.ts:3364-3402`).
    #[must_use]
    pub fn error_code(&self) -> FrickErrorCode {
        match self {
            Self::SessionExpired => FrickErrorCode::AuthSessionExpired,
            Self::Authentication { .. } => FrickErrorCode::AuthUnauthenticated,
            Self::Authorization { .. } | Self::CorsOriginRejected | Self::UnknownTenant { .. } => {
                FrickErrorCode::AuthForbidden
            }
            Self::BlobValidationRejected => FrickErrorCode::BlobUnsupportedContentType,
            Self::InvalidStreamCursor => FrickErrorCode::StreamInvalidCursor,
            Self::StorageConflict { .. } => FrickErrorCode::StorageConflict,
            Self::ProjectionNotFound { .. } | Self::SearchIndexNotFound { .. } => {
                FrickErrorCode::StorageNotFound
            }
            Self::AdminAuditWrite | Self::Internal => FrickErrorCode::ServerInternal,
            Self::Limit { kind, .. } => match kind {
                LimitKind::MaxBlobBytes => FrickErrorCode::BlobTooLarge,
                LimitKind::MaxBlobBytesPerPrincipal => FrickErrorCode::BlobQuotaExceeded,
                LimitKind::MaxStreamAppendPayloadBytes => FrickErrorCode::StreamAppendRejected,
                _ => FrickErrorCode::RateLimitExceeded,
            },
            Self::BadRequest { .. } => FrickErrorCode::SyncProtocolError,
        }
    }

    /// Build the wire envelope (`sendError`). `details.routeCode` carries the
    /// request id; `schemaHash`/`schemaRevision` come from the foundation
    /// schema (the documented TS gotcha).
    #[must_use]
    pub fn to_envelope(&self, request_id: &str) -> FrickErrorEnvelope {
        let foundation = foundation_schema();
        let mut details = vec![("routeCode".to_string(), Value::from(request_id))];

        match self {
            Self::Authorization {
                reason: Some(reason),
                ..
            } => {
                details.push(("reason".to_string(), Value::from(reason.as_str())));
            }
            Self::UnknownTenant { tenant_id } => {
                details.push(("reason".to_string(), Value::from("unknownTenant")));
                details.push(("tenantId".to_string(), Value::from(tenant_id.as_str())));
            }
            Self::ProjectionNotFound { projection } => {
                details.push(("projection".to_string(), Value::from(projection.as_str())));
            }
            Self::SearchIndexNotFound { index } => {
                details.push(("index".to_string(), Value::from(index.as_str())));
            }
            Self::Limit { detail, .. } | Self::StorageConflict { detail } => {
                if let Value::Map(entries) = detail {
                    details.extend(
                        entries
                            .iter()
                            .map(|(k, v)| (k.as_str().unwrap_or_default().to_string(), v.clone())),
                    );
                }
            }
            _ => {}
        }

        FrickErrorEnvelope {
            code: self.error_code(),
            message: self.to_string(),
            request_id: request_id.to_string(),
            retryable: matches!(
                self,
                Self::Limit {
                    kind: LimitKind::MaxAuthAttemptsPerWindow,
                    ..
                }
            ),
            details: Some(Value::Map(
                details
                    .into_iter()
                    .map(|(k, v)| (Value::from(k), v))
                    .collect(),
            )),
            schema_hash: Some(foundation.hash.clone()),
            schema_revision: Some(foundation.schema_revision),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_and_code_mapping_matches_ts() {
        assert_eq!(ServerError::SessionExpired.http_status(), 401);
        assert_eq!(
            ServerError::SessionExpired.error_code(),
            FrickErrorCode::AuthSessionExpired
        );

        let forbidden = ServerError::Authorization {
            message: "no".into(),
            reason: None,
        };
        assert_eq!(forbidden.http_status(), 403);
        assert_eq!(forbidden.error_code(), FrickErrorCode::AuthForbidden);

        let blob = ServerError::Limit {
            kind: LimitKind::MaxBlobBytes,
            detail: Value::Nil,
        };
        assert_eq!(blob.http_status(), 413);
        assert_eq!(blob.error_code(), FrickErrorCode::BlobTooLarge);

        let rate = ServerError::Limit {
            kind: LimitKind::MaxAuthAttemptsPerWindow,
            detail: Value::Nil,
        };
        assert_eq!(rate.http_status(), 429);
        assert_eq!(rate.error_code(), FrickErrorCode::RateLimitExceeded);

        let conflict = ServerError::StorageConflict { detail: Value::Nil };
        assert_eq!(conflict.http_status(), 409);
        assert_eq!(conflict.error_code(), FrickErrorCode::StorageConflict);
    }

    #[test]
    fn envelope_stamps_foundation_schema_and_route_code() {
        let envelope = ServerError::BadRequest {
            message: "bad".into(),
        }
        .to_envelope("req-1");
        assert_eq!(envelope.code, FrickErrorCode::SyncProtocolError);
        assert_eq!(envelope.request_id, "req-1");
        assert_eq!(
            envelope.schema_hash.as_deref(),
            Some("frick-foundation-empty-0.1.0")
        );
        let Some(Value::Map(details)) = &envelope.details else {
            panic!("details map")
        };
        assert!(
            details
                .iter()
                .any(|(k, v)| k.as_str() == Some("routeCode") && v.as_str() == Some("req-1"))
        );
    }

    #[test]
    fn unknown_tenant_carries_reason_and_id() {
        let envelope = ServerError::UnknownTenant {
            tenant_id: "t-9".into(),
        }
        .to_envelope("req-2");
        let Some(Value::Map(details)) = &envelope.details else {
            panic!("details map")
        };
        assert!(
            details
                .iter()
                .any(|(k, v)| k.as_str() == Some("reason") && v.as_str() == Some("unknownTenant"))
        );
        assert!(
            details
                .iter()
                .any(|(k, v)| k.as_str() == Some("tenantId") && v.as_str() == Some("t-9"))
        );
    }
}
