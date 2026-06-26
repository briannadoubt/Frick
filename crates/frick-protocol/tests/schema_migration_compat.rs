//! Schema migration-compatibility harness (AURA-302).
//!
//! Table-driven coverage of [`compare_schema_compatibility`] over the
//! migration scenarios that matter for rolling deploys: an old client talking
//! to a new server (and vice versa). Each row pins a `(client_rev, server_rev,
//! min_client, min_server)` tuple to the expected compatibility verdict and
//! reason, exercising the `minimum_client_revision` enforcement wired at the
//! frick-server gateway (AURA-332).

use frick_protocol::{
    FrickSchema, SchemaCompatibilityReason, compare_schema_compatibility,
    require_schema_compatibility,
};

/// Build a schema for one side of the handshake. `id` and `hash` let a row
/// force the schema-id-mismatch / hash-mismatch branches; the four revision
/// knobs drive the migration cases.
fn schema(id: &str, revision: i64, min_client: i64, min_server: i64, hash: &str) -> FrickSchema {
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

/// `(schema_id, revision, minimum_client_revision, minimum_server_revision, hash)`.
type Side = (&'static str, i64, i64, i64, &'static str);

struct Case {
    name: &'static str,
    client: Side,
    server: Side,
    expect_compatible: bool,
    expect_reason: SchemaCompatibilityReason,
}

fn build(side: Side) -> FrickSchema {
    schema(side.0, side.1, side.2, side.3, side.4)
}

fn cases() -> Vec<Case> {
    vec![
        Case {
            name: "exact: same schema both sides",
            client: ("app", 5, 1, 1, "h"),
            server: ("app", 5, 1, 1, "h"),
            expect_compatible: true,
            expect_reason: SchemaCompatibilityReason::Exact,
        },
        Case {
            name: "newer client vs older server, revisions still compatible",
            client: ("app", 6, 1, 4, "h"),
            server: ("app", 5, 1, 1, "h"),
            expect_compatible: true,
            expect_reason: SchemaCompatibilityReason::Exact,
        },
        Case {
            name: "older client vs newer server, above server minimum",
            client: ("app", 4, 1, 1, "h"),
            server: ("app", 8, 3, 1, "h"),
            expect_compatible: true,
            expect_reason: SchemaCompatibilityReason::Exact,
        },
        Case {
            name: "old client below server minimum_client_revision => clientTooOld",
            client: ("app", 2, 1, 1, "h"),
            server: ("app", 8, 3, 1, "h"),
            expect_compatible: false,
            expect_reason: SchemaCompatibilityReason::ClientTooOld,
        },
        Case {
            name: "client revision equal to server minimum is accepted (boundary)",
            client: ("app", 3, 1, 1, "h"),
            server: ("app", 8, 3, 1, "h"),
            expect_compatible: true,
            expect_reason: SchemaCompatibilityReason::Exact,
        },
        Case {
            name: "server too old for client minimum_server_revision => serverTooOld",
            client: ("app", 5, 1, 9, "h"),
            server: ("app", 5, 1, 1, "h"),
            expect_compatible: false,
            expect_reason: SchemaCompatibilityReason::ServerTooOld,
        },
        Case {
            name: "server revision equal to client minimum is accepted (boundary)",
            client: ("app", 5, 1, 5, "h"),
            server: ("app", 5, 1, 1, "h"),
            expect_compatible: true,
            expect_reason: SchemaCompatibilityReason::Exact,
        },
        Case {
            name: "compatible revisions but differing hashes => revisionCompatibleHashMismatch",
            client: ("app", 5, 1, 1, "client-hash"),
            server: ("app", 5, 1, 1, "server-hash"),
            expect_compatible: true,
            expect_reason: SchemaCompatibilityReason::RevisionCompatibleHashMismatch,
        },
        Case {
            name: "different schema ids never match, even at equal revisions",
            client: ("client-app", 5, 1, 1, "h"),
            server: ("server-app", 5, 1, 1, "h"),
            expect_compatible: false,
            expect_reason: SchemaCompatibilityReason::SchemaIdMismatch,
        },
        Case {
            name: "clientTooOld is checked before serverTooOld (branch precedence)",
            client: ("app", 2, 1, 99, "h"),
            server: ("app", 5, 3, 1, "h"),
            expect_compatible: false,
            expect_reason: SchemaCompatibilityReason::ClientTooOld,
        },
    ]
}

#[test]
fn migration_compat_matrix() {
    for case in &cases() {
        let client = build(case.client);
        let server = build(case.server);
        let result = compare_schema_compatibility(&client, &server);

        assert_eq!(
            result.compatible, case.expect_compatible,
            "case `{}`: compatible mismatch (got {result:?})",
            case.name,
        );
        assert_eq!(
            result.reason, case.expect_reason,
            "case `{}`: reason mismatch (got {result:?})",
            case.name,
        );
        // The reported revisions always echo the inputs regardless of verdict.
        assert_eq!(
            result.client_revision, case.client.1,
            "case `{}`: client_revision echo",
            case.name,
        );
        assert_eq!(
            result.server_revision, case.server.1,
            "case `{}`: server_revision echo",
            case.name,
        );

        // require_* must agree with the verdict: Ok iff compatible, and an
        // incompatible result must carry a non-empty diagnostic message.
        let required = require_schema_compatibility(&client, &server);
        assert_eq!(
            required.is_ok(),
            case.expect_compatible,
            "case `{}`: require_schema_compatibility disagrees with verdict",
            case.name,
        );
        if !case.expect_compatible {
            assert!(
                result.message.is_some_and(|msg| !msg.is_empty()),
                "case `{}`: incompatible result must explain why",
                case.name,
            );
        }
    }
}
