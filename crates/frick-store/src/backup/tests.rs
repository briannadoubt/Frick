//! Backup (dump) + restore round-trip and refusal tests (FR-262).
//!
//! Everything runs against `:memory:` with a fixed clock and a seeded id
//! generator so dumps are byte-deterministic and no maintenance timers spin up.

use std::sync::Arc;

use frick_protocol::schema::{
    EventDef, FieldDef, FieldKind, ObjectDef, PresenceDef, SignalDef, StreamDef,
};
use frick_protocol::{FrickSchema, Value};

use crate::backup::{RestoreError, RestoreOptions, RestoreRefusal};
use crate::driver::SqlValue;
use crate::facade::seam::{Clock, FixedClock, OsIdGen, SeededIdGen};
use crate::facade::{FrickStore, FrickStoreOptions};

const NOW: i64 = 1_700_000_000_000;
const TENANT_A: &str = "_default";
const TENANT_B: &str = "tenant-b";

fn field(id: i64, name: &str, kind: FieldKind, required: bool) -> FieldDef {
    FieldDef {
        id,
        name: name.into(),
        kind,
        required,
        ref_: None,
        enum_values: None,
        sensitivity: None,
    }
}

fn test_schema(hash: &str) -> FrickSchema {
    FrickSchema {
        name: "backup-test".into(),
        schema_id: "backup-test".into(),
        schema_version: "1.0.0".into(),
        schema_revision: 1,
        minimum_client_revision: 1,
        minimum_server_revision: 1,
        protocol: "frick.realtime".into(),
        protocol_version: 1,
        compatibility: "greenfield-cutover".into(),
        hash: hash.into(),
        objects: vec![ObjectDef {
            id: 2,
            name: "Conversation".into(),
            fields: vec![field(2, "title", FieldKind::String, false)],
            indexes: vec![],
            merge_policy: None,
        }],
        streams: vec![StreamDef {
            id: 3,
            name: "chat".into(),
            key_fields: vec![field(1, "roomId", FieldKind::String, true)],
            events: vec!["message".into()],
        }],
        events: vec![EventDef {
            id: 4,
            name: "message".into(),
            fields: vec![field(1, "text", FieldKind::String, true)],
        }],
        presences: vec![PresenceDef {
            id: 5,
            name: "cursor".into(),
            key_fields: vec![field(1, "userId", FieldKind::String, true)],
            fields: vec![field(2, "x", FieldKind::Int, true)],
            ttl_ms: 30_000,
        }],
        signals: vec![SignalDef {
            id: 6,
            name: "ring".into(),
            key_fields: vec![field(1, "userId", FieldKind::String, true)],
            fields: vec![field(2, "n", FieldKind::Int, true)],
            ttl_ms: 30_000,
        }],
        blobs: vec![],
        jobs: vec![],
        projections: vec![],
    }
}

struct ClockHandle(Arc<FixedClock>);
impl Clock for ClockHandle {
    fn now_ms(&self) -> i64 {
        self.0.now_ms()
    }
}

async fn open_store_with(schema: FrickSchema) -> Arc<FrickStore> {
    let clock = Arc::new(FixedClock::new(NOW));
    let clock_seam: Box<dyn Clock> = Box::new(ClockHandle(clock));
    let options = FrickStoreOptions {
        schema: Some(schema),
        ..FrickStoreOptions::memory()
    };
    let store = FrickStore::open_with_seams(options, clock_seam, Box::new(SeededIdGen::new()))
        .await
        .expect("store opens");
    Arc::new(store)
}

fn convo(id: &str, title: &str) -> Value {
    Value::Map(vec![
        ("id".into(), id.into()),
        ("title".into(), title.into()),
    ])
}

fn message(text: &str) -> Value {
    Value::Map(vec![("text".into(), text.into())])
}

/// Populate a store with a tenant ledger row plus one object and one stream
/// event for the given tenant. Uses unique replica/request ids so appends never
/// dedupe across calls.
async fn seed_tenant(store: &FrickStore, tenant: &str, suffix: &str) {
    if tenant != TENANT_A {
        store
            .tenants()
            .create(tenant, Some("Tenant B"), NOW)
            .await
            .expect("create tenant");
    }
    store
        .upsert_object(
            tenant,
            "Conversation",
            &format!("convo-{suffix}"),
            &convo(&format!("convo-{suffix}"), "Hello"),
            1,
            "_default",
        )
        .await
        .expect("upsert object");
    store
        .append_event(
            tenant,
            "chat",
            &format!("room-{suffix}"),
            &format!("replica-{suffix}"),
            &format!("req-{suffix}"),
            "message",
            &message("hi"),
            "_default",
        )
        .await
        .expect("append event");
}

/// Dump every framework table for a tenant scope and return the rows keyed by
/// `(table, primary-ish ordering)` as the raw dump lines minus the header — a
/// stable comparison key for round-trips.
async fn dump_rows(store: &FrickStore, tenant: Option<&str>) -> Vec<String> {
    let lines = store
        .dump_database(tenant, NOW)
        .await
        .expect("dump succeeds");
    // Drop the header (line 0) and the construction-stamped infra rows: the
    // `frick_migrations` ledger and the `_default` tenant row carry real
    // wall-clock `applied_at`/`created_at`/`duration_ms` from each store's own
    // migration run (not the injected `now_ms`), so they legitimately differ
    // between two independently-migrated stores. The user *data* rows are what a
    // round-trip must preserve byte-for-byte.
    lines
        .into_iter()
        .skip(1)
        .filter(|line| !line.contains("\"type\":\"frick_migrations\""))
        .filter(|line| {
            !(line.contains("\"type\":\"tenants\"") && line.contains("\"tenant_id\":\"_default\""))
        })
        .collect()
}

#[tokio::test]
async fn full_round_trip_whole_database() {
    let source = open_store_with(test_schema("hash-1")).await;
    seed_tenant(&source, TENANT_A, "a").await;
    seed_tenant(&source, TENANT_B, "b").await;

    let lines = source.dump_database(None, NOW).await.expect("dump");
    let source_rows = dump_rows(&source, None).await;

    // Header is the first line and tags the whole-DB scope.
    let header: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
    assert_eq!(header["type"], "header");
    assert_eq!(header["row"]["tenantId"], "all");
    assert_eq!(header["row"]["schemaHash"], "hash-1");
    assert_eq!(header["row"]["frickFormat"], 1);

    // Restore into a fresh store with the SAME schema hash.
    let target = open_store_with(test_schema("hash-1")).await;
    let report = target
        .restore_database(
            &lines,
            RestoreOptions {
                confirm: true,
                ..RestoreOptions::default()
            },
            NOW,
            NOW,
        )
        .await
        .expect("restore succeeds");

    // A freshly-migrated target already has the `_default` tenant ledger row
    // and the full `frick_migrations` ledger (migrations ran at construction),
    // so those rows hit UNIQUE constraints and land in `skipped` — exactly like
    // the TS restore. No *data* row should be skipped.
    assert!(
        report
            .skipped
            .iter()
            .all(|row| row.r#type == "frick_migrations" || row.r#type == "tenants"),
        "only infra rows may be skipped: {:?}",
        report.skipped
    );
    assert!(report.schema_compatibility.matched);
    assert_eq!(report.schema_compatibility.source_hash, "hash-1");
    assert!(
        report
            .row_counts_by_type
            .get("objects")
            .copied()
            .unwrap_or(0)
            >= 2
    );
    assert!(
        report
            .row_counts_by_type
            .get("stream_events")
            .copied()
            .unwrap_or(0)
            >= 2
    );

    // The restored database re-dumps to identical data rows.
    let target_rows = dump_rows(&target, None).await;
    assert_eq!(source_rows, target_rows, "dump after restore is identical");

    // And the objects read back identically.
    let original = source
        .objects()
        .read(TENANT_B, "Conversation", "convo-b", "_default")
        .await
        .unwrap();
    let restored = target
        .objects()
        .read(TENANT_B, "Conversation", "convo-b", "_default")
        .await
        .unwrap();
    assert_eq!(original, restored);
    assert!(restored.is_some());
}

#[tokio::test]
async fn per_tenant_round_trip_isolates_scope() {
    let source = open_store_with(test_schema("hash-1")).await;
    seed_tenant(&source, TENANT_A, "a").await;
    seed_tenant(&source, TENANT_B, "b").await;

    // Dump ONLY tenant B.
    let lines = source
        .dump_database(Some(TENANT_B), NOW)
        .await
        .expect("per-tenant dump");
    let header: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
    assert_eq!(header["row"]["tenantId"], TENANT_B);
    // The per-tenant dump still carries tenant B's ledger row.
    assert!(
        lines
            .iter()
            .any(|line| line.contains("\"type\":\"tenants\"") && line.contains(TENANT_B)),
        "per-tenant dump includes the tenant ledger row"
    );
    // It must NOT carry tenant A's object rows.
    assert!(
        !lines.iter().any(|line| line.contains("convo-a")),
        "per-tenant dump excludes the other tenant's rows"
    );

    // Restore tenant B into a fresh store that ALREADY has tenant A's data —
    // the per-tenant scope means tenant A is left untouched.
    let target = open_store_with(test_schema("hash-1")).await;
    seed_tenant(&target, TENANT_A, "a").await;

    let report = target
        .restore_database(
            &lines,
            RestoreOptions {
                confirm: true,
                ..RestoreOptions::default()
            },
            NOW,
            NOW,
        )
        .await
        .expect("per-tenant restore");
    assert!(report.skipped.is_empty(), "skipped: {:?}", report.skipped);

    // Tenant B's object is now present; tenant A's untouched.
    assert!(
        target
            .objects()
            .read(TENANT_B, "Conversation", "convo-b", "_default")
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        target
            .objects()
            .read(TENANT_A, "Conversation", "convo-a", "_default")
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn refuses_without_confirmation() {
    let target = open_store_with(test_schema("hash-1")).await;
    let lines = vec![header_line("hash-1", "all", &[])];
    let err = target
        .restore_database_checked(&lines, RestoreOptions::default(), NOW, NOW)
        .await
        .expect_err("must refuse");
    match err {
        RestoreError::Refused(RestoreRefusal::MissingConfirmation) => {}
        other => panic!("expected MissingConfirmation, got {other:?}"),
    }
}

#[tokio::test]
async fn refuses_on_schema_hash_drift() {
    let source = open_store_with(test_schema("hash-1")).await;
    seed_tenant(&source, TENANT_A, "a").await;
    let lines = source.dump_database(None, NOW).await.unwrap();

    // Target has a DIFFERENT schema hash.
    let target = open_store_with(test_schema("hash-2")).await;
    let err = target
        .restore_database_checked(
            &lines,
            RestoreOptions {
                confirm: true,
                ..RestoreOptions::default()
            },
            NOW,
            NOW,
        )
        .await
        .expect_err("drift refusal");
    match err {
        RestoreError::Refused(RestoreRefusal::SchemaHashMismatch {
            source_hash,
            target_hash,
        }) => {
            assert_eq!(source_hash, "hash-1");
            assert_eq!(target_hash, "hash-2");
        }
        other => panic!("expected SchemaHashMismatch, got {other:?}"),
    }

    // force_schema_drift lets it through.
    let report = target
        .restore_database(
            &lines,
            RestoreOptions {
                confirm: true,
                force_schema_drift: true,
                ..RestoreOptions::default()
            },
            NOW,
            NOW,
        )
        .await
        .expect("forced restore succeeds");
    assert!(!report.schema_compatibility.matched);
}

#[tokio::test]
async fn refuses_when_target_not_empty_without_overwrite() {
    let source = open_store_with(test_schema("hash-1")).await;
    seed_tenant(&source, TENANT_A, "a").await;
    let lines = source.dump_database(None, NOW).await.unwrap();

    // Target already has data.
    let target = open_store_with(test_schema("hash-1")).await;
    seed_tenant(&target, TENANT_A, "existing").await;

    let err = target
        .restore_database_checked(
            &lines,
            RestoreOptions {
                confirm: true,
                ..RestoreOptions::default()
            },
            NOW,
            NOW,
        )
        .await
        .expect_err("not-empty refusal");
    match err {
        RestoreError::Refused(RestoreRefusal::TargetNotEmpty { .. }) => {}
        other => panic!("expected TargetNotEmpty, got {other:?}"),
    }

    // overwrite replaces the existing data.
    let report = target
        .restore_database(
            &lines,
            RestoreOptions {
                confirm: true,
                overwrite: true,
                ..RestoreOptions::default()
            },
            NOW,
            NOW,
        )
        .await
        .expect("overwrite restore succeeds");
    // `frick_migrations` / the `_default` tenant pre-exist in the migrated
    // target (truncate leaves the ledger + default tenant), so they re-skip;
    // no data row should.
    assert!(
        report
            .skipped
            .iter()
            .all(|row| row.r#type == "frick_migrations" || row.r#type == "tenants"),
        "only infra rows may be skipped: {:?}",
        report.skipped
    );
    // The pre-existing object is gone; only the source's object remains.
    assert!(
        target
            .objects()
            .read(TENANT_A, "Conversation", "convo-existing", "_default")
            .await
            .unwrap()
            .is_none(),
        "overwrite truncated the pre-existing row"
    );
    assert!(
        target
            .objects()
            .read(TENANT_A, "Conversation", "convo-a", "_default")
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn missing_header_is_refused() {
    let target = open_store_with(test_schema("hash-1")).await;
    let empty: Vec<String> = Vec::new();
    let err = target
        .restore_database_checked(
            empty,
            RestoreOptions {
                confirm: true,
                ..RestoreOptions::default()
            },
            NOW,
            NOW,
        )
        .await
        .expect_err("missing header");
    assert!(matches!(
        err,
        RestoreError::Refused(RestoreRefusal::MissingHeader)
    ));

    // A non-header first line is also refused.
    let bad = vec!["{\"type\":\"objects\",\"row\":{}}".to_owned()];
    let err = target
        .restore_database_checked(
            bad,
            RestoreOptions {
                confirm: true,
                ..RestoreOptions::default()
            },
            NOW,
            NOW,
        )
        .await
        .expect_err("non-header first line");
    assert!(matches!(
        err,
        RestoreError::Refused(RestoreRefusal::MissingHeader)
    ));
}

#[tokio::test]
async fn unknown_table_type_is_skipped_not_fatal() {
    let target = open_store_with(test_schema("hash-1")).await;
    let lines = vec![
        header_line("hash-1", "all", &[]),
        "{\"type\":\"made_up_table\",\"row\":{\"x\":1}}".to_owned(),
    ];
    let report = target
        .restore_database(
            &lines,
            RestoreOptions {
                confirm: true,
                ..RestoreOptions::default()
            },
            NOW,
            NOW,
        )
        .await
        .expect("restore tolerates unknown type");
    assert_eq!(report.skipped.len(), 1);
    assert_eq!(report.skipped[0].r#type, "made_up_table");
    assert_eq!(report.skipped[0].reason, "unknownTableType");
}

#[tokio::test]
async fn invalid_column_row_is_skipped() {
    let target = open_store_with(test_schema("hash-1")).await;
    let lines = vec![
        header_line("hash-1", "all", &[]),
        // `objects` has no `bogus_col` column -> the row is skipped, not fatal.
        "{\"type\":\"objects\",\"row\":{\"bogus_col\":\"x\"}}".to_owned(),
    ];
    let report = target
        .restore_database(
            &lines,
            RestoreOptions {
                confirm: true,
                ..RestoreOptions::default()
            },
            NOW,
            NOW,
        )
        .await
        .expect("restore tolerates a bad row");
    assert_eq!(report.skipped.len(), 1);
    assert!(report.skipped[0].reason.contains("invalidColumn"));
}

#[tokio::test]
async fn blob_columns_round_trip_via_base64() {
    // `objects.packed` is a msgpack BLOB; the dump base64-encodes it and the
    // restore decodes it back to identical bytes.
    let source = open_store_with(test_schema("hash-1")).await;
    seed_tenant(&source, TENANT_A, "a").await;

    let lines = source.dump_database(None, NOW).await.unwrap();
    assert!(
        lines.iter().any(|line| line.contains("packed_base64")),
        "blob columns are emitted as <col>_base64"
    );

    let original_packed = source
        .sql_driver()
        .get(
            "SELECT packed FROM objects WHERE tenant_id = ? AND object_type = ? AND object_id = ?",
            &[
                SqlValue::from(TENANT_A),
                SqlValue::from("Conversation"),
                SqlValue::from("convo-a"),
            ],
        )
        .await
        .unwrap()
        .and_then(|row| row.blob("packed").map(<[u8]>::to_vec))
        .expect("source has packed bytes");

    let target = open_store_with(test_schema("hash-1")).await;
    target
        .restore_database(
            &lines,
            RestoreOptions {
                confirm: true,
                ..RestoreOptions::default()
            },
            NOW,
            NOW,
        )
        .await
        .unwrap();

    let restored_packed = target
        .sql_driver()
        .get(
            "SELECT packed FROM objects WHERE tenant_id = ? AND object_type = ? AND object_id = ?",
            &[
                SqlValue::from(TENANT_A),
                SqlValue::from("Conversation"),
                SqlValue::from("convo-a"),
            ],
        )
        .await
        .unwrap()
        .and_then(|row| row.blob("packed").map(<[u8]>::to_vec))
        .expect("restored has packed bytes");

    assert_eq!(
        original_packed, restored_packed,
        "blob bytes survive round-trip"
    );
}

#[tokio::test]
async fn dump_is_deterministic_under_fixed_clock() {
    let store = open_store_with(test_schema("hash-1")).await;
    seed_tenant(&store, TENANT_A, "a").await;
    let first = store.dump_database(None, NOW).await.unwrap();
    let second = store.dump_database(None, NOW).await.unwrap();
    assert_eq!(first, second, "dump is byte-stable at a fixed now_ms");
}

#[tokio::test]
async fn os_seams_do_not_affect_dump_shape() {
    // The store layer never reads the clock/RNG inside dump/restore — the
    // production seams produce the same dump shape (modulo injected now_ms).
    let options = FrickStoreOptions {
        schema: Some(test_schema("hash-1")),
        ..FrickStoreOptions::memory()
    };
    let store =
        FrickStore::open_with_seams(options, Box::new(FixedClock::new(NOW)), Box::new(OsIdGen))
            .await
            .unwrap();
    let lines = store.dump_database(None, NOW).await.unwrap();
    let header: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
    assert!(header["row"]["createdAt"].as_str().unwrap().ends_with('Z'));
}

/// Build a synthetic header line for the refusal tests that don't need a full
/// dump.
fn header_line(schema_hash: &str, tenant_id: &str, applied: &[&str]) -> String {
    serde_json::json!({
        "type": "header",
        "row": {
            "frickFormat": 1,
            "createdAt": "2023-11-14T22:13:20.000Z",
            "schemaId": "backup-test",
            "schemaVersion": "1.0.0",
            "schemaRevision": 1,
            "schemaHash": schema_hash,
            "appliedMigrations": applied,
            "tenantId": tenant_id,
        },
    })
    .to_string()
}
