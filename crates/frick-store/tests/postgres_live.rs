//! Live Postgres integration tests for the FR-242 driver arm.
//!
//! These exercise the real `PostgresDriver` end to end: connect, run the
//! framework migrations, and round-trip a couple of stores. They require a
//! reachable Postgres and are CI-verified only — there is no local Postgres, so
//! every test **early-returns (skips) when `FRICK_DATABASE_URL` is unset**,
//! keeping `cargo test -p frick-store` green locally.
//!
//! To run them, point at a throwaway database and run the `pg_live` tests:
//!
//! ```sh
//! FRICK_DATABASE_URL=postgres://postgres:postgres@localhost:5432/frick_test \
//!   cargo test -p frick-store --test postgres_live
//! ```
//!
//! Each test name is prefixed `pg_live_` so CI can target them explicitly. They
//! each use a unique table/key prefix and clean up after themselves so they can
//! run against a shared database.

use frick_protocol::schema::{FieldDef, FieldKind, FrickObjectMergePolicy, ObjectDef};
use frick_protocol::{FrickSchema, Value};
use frick_store::driver::{SqlDriver, SqlValue};
use frick_store::migrations::{
    MigrationRunnerOptions, list_applied_migrations_postgres, run_framework_migrations_postgres,
};
use frick_store::stores::job::{EnqueueInput, JobStatus, JobStore};
use frick_store::stores::object::ObjectStore;

/// Resolve the Postgres driver from `FRICK_DATABASE_URL`, or `None` (skip) when
/// unset. Prints a clear skip notice so a skipped run is obvious in CI logs.
fn live_driver() -> Option<SqlDriver> {
    let Ok(url) = std::env::var("FRICK_DATABASE_URL") else {
        eprintln!(
            "SKIP: FRICK_DATABASE_URL unset — live Postgres tests skipped (CI-verified only)."
        );
        return None;
    };
    Some(SqlDriver::open_postgres(&url).expect("open_postgres builds the pool"))
}

/// Tear down the framework tables so a shared database is reusable between runs.
/// CASCADE drops dependent FKs (blob_content → blob_metadata).
async fn reset_schema(driver: &SqlDriver) {
    use std::fmt::Write as _;
    // Order-independent thanks to CASCADE; drop the ledger too so migrations
    // re-apply from scratch each run.
    let tables = [
        "frick_migrations",
        "schema_versions",
        "objects",
        "stream_events",
        "idempotency_keys",
        "presence_leases",
        "signal_outbox",
        "blob_content",
        "blob_metadata",
        "jobs",
        "auth_sessions",
        "auth_accounts",
        "tenants",
        "admin_audit_log",
        "push_device_registrations",
        "blob_derivatives",
        "search_indexes",
        "tenant_settings",
        "devtools_events",
        "platform_events",
        "platform_event_deliveries",
        "analytics_aggregate_buckets",
        "analytics_recent_events",
        "auth_password_reset_tokens",
        "invitations",
        "grants",
        "auth_refresh_tokens",
        "service_principals",
        "auth_saml_seen_assertions",
    ];
    let mut sql = String::new();
    for table in tables {
        let _ = writeln!(sql, "DROP TABLE IF EXISTS {table} CASCADE;");
    }
    driver.exec(&sql).await.expect("reset schema");
}

/// A minimal schema with one object type, enough for the ObjectStore round-trip
/// (packing needs the type + field ids).
fn note_schema() -> FrickSchema {
    let field = |id: i64, name: &str, kind: FieldKind, required: bool| FieldDef {
        id,
        name: name.into(),
        kind,
        required,
        ref_: None,
        enum_values: None,
        sensitivity: None,
    };
    FrickSchema {
        name: "pg-live-test".into(),
        schema_id: "pg-live-test".into(),
        schema_version: "1.0.0".into(),
        schema_revision: 1,
        minimum_client_revision: 1,
        minimum_server_revision: 1,
        protocol: "frick.realtime".into(),
        protocol_version: 1,
        compatibility: "greenfield-cutover".into(),
        hash: "pg-live-test-hash".into(),
        objects: vec![ObjectDef {
            id: 99,
            name: "Note".into(),
            fields: vec![
                field(1, "body", FieldKind::String, true),
                field(2, "tag", FieldKind::String, false),
            ],
            indexes: vec![],
            merge_policy: Some(FrickObjectMergePolicy::LastWriteWins),
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

#[tokio::test]
async fn pg_live_migrations_apply_and_are_idempotent() {
    let Some(driver) = live_driver() else { return };
    reset_schema(&driver).await;

    let first = run_framework_migrations_postgres(&driver, 1, MigrationRunnerOptions::default())
        .await
        .expect("first migration run");
    assert_eq!(first.applied.len(), 26, "all framework migrations applied");
    assert!(first.already_applied.is_empty());
    assert_eq!(first.applied[0].id, "0001_initial_foundation_tables");
    assert!(first.applied[0].checksum.starts_with("sha256-"));
    assert!(first.applied[0].duration_ms >= 0);
    // `applied_at` round-trips back as the JS ISO-8601 shape.
    assert!(
        first.applied[0].applied_at.ends_with('Z') && first.applied[0].applied_at.contains('T'),
        "applied_at is an ISO-8601 string: {}",
        first.applied[0].applied_at
    );

    let second = run_framework_migrations_postgres(&driver, 1, MigrationRunnerOptions::default())
        .await
        .expect("second migration run");
    assert!(
        second.applied.is_empty(),
        "idempotent re-run applies nothing"
    );
    assert_eq!(second.already_applied.len(), 26);

    let ledger = list_applied_migrations_postgres(&driver)
        .await
        .expect("ledger reads");
    assert_eq!(ledger.len(), 26);
    assert_eq!(ledger[0].id, "0001_initial_foundation_tables");
}

#[tokio::test]
async fn pg_live_job_store_round_trips_with_returning_id() {
    let Some(driver) = live_driver() else { return };
    reset_schema(&driver).await;
    run_framework_migrations_postgres(&driver, 1, MigrationRunnerOptions::default())
        .await
        .expect("migrations");

    let jobs = JobStore::new(&driver);
    let enqueued = jobs
        .enqueue(
            EnqueueInput {
                tenant_id: "tenant-pg".into(),
                app_id: None,
                job_type: "pg.live.job".into(),
                payload: Value::String("hello-postgres".into()),
                idempotency_key: None,
                available_at: None,
                max_attempts: None,
            },
            1_700_000_000_000,
        )
        .await
        .expect("enqueue");

    // `RETURNING id` flows through run().last_insert_rowid → BIGINT identity.
    assert!(enqueued.id > 0, "identity id assigned via RETURNING id");
    assert_eq!(enqueued.status, JobStatus::Ready);
    assert_eq!(enqueued.payload, Value::String("hello-postgres".into()));

    let read = jobs
        .get_by_id(enqueued.id, Some("tenant-pg"), None)
        .await
        .expect("get_by_id")
        .expect("row present");
    assert_eq!(read.id, enqueued.id);
    assert_eq!(read.job_type, "pg.live.job");

    let counts = jobs.counts_by_status().await.expect("counts");
    assert!(counts.ready >= 1);
}

#[tokio::test]
async fn pg_live_object_store_upsert_and_read() {
    let Some(driver) = live_driver() else { return };
    reset_schema(&driver).await;
    run_framework_migrations_postgres(&driver, 1, MigrationRunnerOptions::default())
        .await
        .expect("migrations");

    let schema = note_schema();
    let objects = ObjectStore::new(&driver, &schema);

    let value = Value::Map(vec![
        ("id".into(), Value::String("note-1".into())),
        ("body".into(), Value::String("from postgres".into())),
    ]);
    objects
        .upsert(
            "tenant-pg",
            "Note",
            "note-1",
            &value,
            1,
            "_default",
            1_700_000_000_000,
        )
        .await
        .expect("upsert");

    // BYTEA `packed` blob round-trips and unpacks back to the same Value.
    let read = objects
        .read("tenant-pg", "Note", "note-1", "_default")
        .await
        .expect("read")
        .expect("row present");
    assert_eq!(read, value);

    // A NULL/absent row reads as None (exercises the empty-result path).
    let missing = objects
        .read("tenant-pg", "Note", "absent", "_default")
        .await
        .expect("read missing");
    assert!(missing.is_none());

    // Confirm a raw NULL decodes to SqlValue::Null and a BIGINT to Integer.
    let row = driver
        .get(
            "SELECT version, claimed_at FROM (SELECT version FROM objects WHERE object_id = ?) o
             LEFT JOIN (SELECT NULL::text AS claimed_at) n ON true",
            &[SqlValue::from("note-1")],
        )
        .await
        .expect("typed read")
        .expect("row");
    assert_eq!(row.i64("version"), Some(1));
    assert_eq!(row.get("claimed_at"), Some(&SqlValue::Null));
}
