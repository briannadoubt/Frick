//! Client/server capability negotiation (`packages/protocol/src/capabilities.ts`).

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::schema::FrickSchema;
use crate::value::string_enum;

string_enum! {
    pub enum FrickClientPlatform {
        Web => "web",
        Node => "node",
        Ios => "ios",
        Macos => "macos",
        Android => "android",
        Test => "test",
        Service => "service",
    }
}

string_enum! {
    pub enum FrickTransportCapability {
        Websocket => "websocket",
        Http => "http",
        Sse => "sse",
    }
}

string_enum! {
    pub enum FrickEncodingCapability {
        Msgpack => "msgpack",
        Json => "json",
    }
}

string_enum! {
    pub enum FrickPrimitiveCapability {
        Objects => "objects",
        Streams => "streams",
        Presence => "presence",
        Signals => "signals",
        Blobs => "blobs",
        Jobs => "jobs",
        Projections => "projections",
    }
}

string_enum! {
    pub enum FrickBlobUploadCapability {
        Direct => "direct",
        Resumable => "resumable",
        SignedUrl => "signedUrl",
        LocalOnly => "localOnly",
    }
}

string_enum! {
    pub enum FrickPushCapability {
        Apns => "apns",
        Fcm => "fcm",
        WebPush => "webPush",
        Test => "test",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrickSchemaCapability {
    pub schema_id: String,
    pub schema_revision: i64,
    pub schema_hash: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrickOfflineCapabilities {
    pub cache: bool,
    pub pending_appends: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrickClientCapabilities {
    pub platform: FrickClientPlatform,
    pub sdk_version: String,
    pub schema: FrickSchemaCapability,
    pub transports: Vec<FrickTransportCapability>,
    pub encodings: Vec<FrickEncodingCapability>,
    pub primitives: Vec<FrickPrimitiveCapability>,
    pub offline: FrickOfflineCapabilities,
    pub blob_uploads: Vec<FrickBlobUploadCapability>,
    pub push: Vec<FrickPushCapability>,
    pub experimental: Vec<String>,
    pub required: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrickServerCapabilities {
    pub schema: FrickSchemaCapability,
    pub transports: Vec<FrickTransportCapability>,
    pub encodings: Vec<FrickEncodingCapability>,
    pub primitives: Vec<FrickPrimitiveCapability>,
    pub blob_uploads: Vec<FrickBlobUploadCapability>,
    pub push: Vec<FrickPushCapability>,
    pub experimental: Vec<String>,
    /// `Record<string, number>` in TS; insertion-ordered, integer-valued in
    /// practice (limits are counts/byte sizes).
    pub limits: IndexMap<String, i64>,
}

/// `schemaCapability` in TS.
#[must_use]
pub fn schema_capability(schema: &FrickSchema) -> FrickSchemaCapability {
    FrickSchemaCapability {
        schema_id: schema.schema_id.clone(),
        schema_revision: schema.schema_revision,
        schema_hash: schema.hash.clone(),
    }
}

/// `defaultClientCapabilities` in TS.
#[must_use]
pub fn default_client_capabilities(
    platform: FrickClientPlatform,
    sdk_version: &str,
    schema: &FrickSchema,
) -> FrickClientCapabilities {
    FrickClientCapabilities {
        platform,
        sdk_version: sdk_version.to_string(),
        schema: schema_capability(schema),
        transports: vec![FrickTransportCapability::Websocket],
        encodings: vec![FrickEncodingCapability::Msgpack],
        primitives: vec![
            FrickPrimitiveCapability::Objects,
            FrickPrimitiveCapability::Streams,
            FrickPrimitiveCapability::Presence,
            FrickPrimitiveCapability::Signals,
        ],
        offline: FrickOfflineCapabilities {
            cache: true,
            pending_appends: true,
        },
        blob_uploads: vec![FrickBlobUploadCapability::Direct],
        push: vec![],
        experimental: vec![],
        required: vec![],
    }
}

/// `defaultServerCapabilities` in TS.
#[must_use]
pub fn default_server_capabilities(schema: &FrickSchema) -> FrickServerCapabilities {
    FrickServerCapabilities {
        schema: schema_capability(schema),
        transports: vec![
            FrickTransportCapability::Websocket,
            FrickTransportCapability::Http,
        ],
        encodings: vec![
            FrickEncodingCapability::Msgpack,
            FrickEncodingCapability::Json,
        ],
        primitives: vec![
            FrickPrimitiveCapability::Objects,
            FrickPrimitiveCapability::Streams,
            FrickPrimitiveCapability::Presence,
            FrickPrimitiveCapability::Signals,
            FrickPrimitiveCapability::Blobs,
            FrickPrimitiveCapability::Jobs,
            FrickPrimitiveCapability::Projections,
        ],
        blob_uploads: vec![FrickBlobUploadCapability::Direct],
        push: vec![],
        experimental: vec![],
        limits: IndexMap::new(),
    }
}

/// `serverCapabilityNames` in TS — dotted names in the same group order.
#[must_use]
pub fn server_capability_names(server: &FrickServerCapabilities) -> Vec<String> {
    let mut names = Vec::new();
    names.extend(
        server
            .transports
            .iter()
            .map(|name| format!("transport.{name}")),
    );
    names.extend(
        server
            .encodings
            .iter()
            .map(|name| format!("encoding.{name}")),
    );
    names.extend(
        server
            .primitives
            .iter()
            .map(|name| format!("primitive.{name}")),
    );
    names.extend(
        server
            .blob_uploads
            .iter()
            .map(|name| format!("blobUpload.{name}")),
    );
    names.extend(server.push.iter().map(|name| format!("push.{name}")));
    names.extend(
        server
            .experimental
            .iter()
            .map(|name| format!("experimental.{name}")),
    );
    names
}

/// `unsupportedRequiredCapabilities` in TS — the client's required
/// capability names the server does not advertise.
#[must_use]
pub fn unsupported_required_capabilities(
    client: &FrickClientCapabilities,
    server: &FrickServerCapabilities,
) -> Vec<String> {
    let supported: std::collections::HashSet<String> =
        server_capability_names(server).into_iter().collect();
    client
        .required
        .iter()
        .filter(|name| !supported.contains(*name))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_schema() -> FrickSchema {
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
    fn capability_names_match_ts_grouping() {
        let server = default_server_capabilities(&test_schema());
        let names = server_capability_names(&server);
        assert_eq!(names[0], "transport.websocket");
        assert_eq!(names[1], "transport.http");
        assert_eq!(names[2], "encoding.msgpack");
        assert!(names.contains(&"primitive.projections".to_string()));
        assert!(names.contains(&"blobUpload.direct".to_string()));
    }

    #[test]
    fn unsupported_required_filters_against_server_names() {
        let schema = test_schema();
        let mut client = default_client_capabilities(FrickClientPlatform::Test, "0.0.0", &schema);
        client.required = vec![
            "transport.websocket".to_string(),
            "push.webPush".to_string(),
        ];
        let server = default_server_capabilities(&schema);
        assert_eq!(
            unsupported_required_capabilities(&client, &server),
            vec!["push.webPush"]
        );
    }
}
