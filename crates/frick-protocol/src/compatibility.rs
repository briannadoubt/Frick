//! Schema compatibility comparison (`packages/protocol/src/compatibility.ts`).
//!
//! TS models the result as a discriminated union; here one struct carries
//! both arms (`message` is `None` only for the `exact` reason). Field order
//! matches the TS object literals.

use serde::{Deserialize, Serialize};

use crate::errors::ProtocolError;
use crate::schema::FrickSchema;
use crate::value::string_enum;

string_enum! {
    /// Why a schema pair is or isn't compatible (`SchemaCompatibilityReason`).
    pub enum SchemaCompatibilityReason {
        Exact => "exact",
        RevisionCompatibleHashMismatch => "revisionCompatibleHashMismatch",
        SchemaIdMismatch => "schemaIdMismatch",
        ClientTooOld => "clientTooOld",
        ServerTooOld => "serverTooOld",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaCompatibilityResult {
    pub compatible: bool,
    pub reason: SchemaCompatibilityReason,
    pub client_revision: i64,
    pub server_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Port of `compareSchemaCompatibility` — identical branch order and
/// message strings.
#[must_use]
pub fn compare_schema_compatibility(
    client: &FrickSchema,
    server: &FrickSchema,
) -> SchemaCompatibilityResult {
    let client_revision = client.schema_revision;
    let server_revision = server.schema_revision;

    if client.schema_id != server.schema_id {
        return SchemaCompatibilityResult {
            compatible: false,
            reason: SchemaCompatibilityReason::SchemaIdMismatch,
            client_revision,
            server_revision,
            message: Some(format!(
                "Schema id mismatch: client={} server={}",
                client.schema_id, server.schema_id
            )),
        };
    }

    if client.schema_revision < server.minimum_client_revision {
        return SchemaCompatibilityResult {
            compatible: false,
            reason: SchemaCompatibilityReason::ClientTooOld,
            client_revision,
            server_revision,
            message: Some(format!(
                "Client schema revision {} is below server minimum {}",
                client.schema_revision, server.minimum_client_revision
            )),
        };
    }

    if server.schema_revision < client.minimum_server_revision {
        return SchemaCompatibilityResult {
            compatible: false,
            reason: SchemaCompatibilityReason::ServerTooOld,
            client_revision,
            server_revision,
            message: Some(format!(
                "Server schema revision {} is below client minimum {}",
                server.schema_revision, client.minimum_server_revision
            )),
        };
    }

    if client.hash != server.hash {
        return SchemaCompatibilityResult {
            compatible: true,
            reason: SchemaCompatibilityReason::RevisionCompatibleHashMismatch,
            client_revision,
            server_revision,
            message: Some("Schema revisions are compatible but hashes differ".to_string()),
        };
    }

    SchemaCompatibilityResult {
        compatible: true,
        reason: SchemaCompatibilityReason::Exact,
        client_revision,
        server_revision,
        message: None,
    }
}

/// Port of `requireSchemaCompatibility` — errors with the result's message
/// when incompatible.
pub fn require_schema_compatibility(
    client: &FrickSchema,
    server: &FrickSchema,
) -> Result<SchemaCompatibilityResult, ProtocolError> {
    let result = compare_schema_compatibility(client, server);
    if !result.compatible {
        return Err(ProtocolError::new(
            result.message.clone().unwrap_or_default(),
        ));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema(
        id: &str,
        revision: i64,
        min_client: i64,
        min_server: i64,
        hash: &str,
    ) -> FrickSchema {
        FrickSchema {
            name: "test".into(),
            schema_id: id.into(),
            schema_version: "0.1.0".into(),
            schema_revision: revision,
            minimum_client_revision: min_client,
            minimum_server_revision: min_server,
            protocol: "frick.realtime".into(),
            protocol_version: 1,
            compatibility: "greenfield-cutover".into(),
            hash: hash.into(),
            objects: vec![],
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
    fn exact_match_has_no_message() {
        let a = schema("app", 3, 1, 1, "h1");
        let result = compare_schema_compatibility(&a, &a);
        assert!(result.compatible);
        assert_eq!(result.reason, SchemaCompatibilityReason::Exact);
        assert_eq!(result.message, None);
    }

    #[test]
    fn branch_order_and_messages_match_ts() {
        let client = schema("other", 1, 1, 1, "h1");
        let server = schema("app", 5, 3, 1, "h2");
        let result = compare_schema_compatibility(&client, &server);
        assert_eq!(result.reason, SchemaCompatibilityReason::SchemaIdMismatch);
        assert_eq!(
            result.message.as_deref(),
            Some("Schema id mismatch: client=other server=app")
        );

        let client = schema("app", 2, 1, 1, "h1");
        let result = compare_schema_compatibility(&client, &server);
        assert_eq!(result.reason, SchemaCompatibilityReason::ClientTooOld);
        assert_eq!(
            result.message.as_deref(),
            Some("Client schema revision 2 is below server minimum 3"),
        );

        let client = schema("app", 5, 1, 9, "h1");
        let result = compare_schema_compatibility(&client, &server);
        assert_eq!(result.reason, SchemaCompatibilityReason::ServerTooOld);
        assert_eq!(
            result.message.as_deref(),
            Some("Server schema revision 5 is below client minimum 9"),
        );

        let client = schema("app", 5, 3, 1, "h1");
        let result = compare_schema_compatibility(&client, &server);
        assert!(result.compatible);
        assert_eq!(
            result.reason,
            SchemaCompatibilityReason::RevisionCompatibleHashMismatch
        );
        assert_eq!(
            result.message.as_deref(),
            Some("Schema revisions are compatible but hashes differ"),
        );
    }
}
