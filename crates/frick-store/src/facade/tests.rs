//! Facade tests (FR-243), ported from `store.test.ts` + the store-prune /
//! write-notification cases. Everything runs against `:memory:` with a fixed
//! clock and a seeded id generator so results are deterministic and no
//! maintenance timers spin up.

use std::sync::{Arc, Mutex};

use frick_protocol::schema::{
    EventDef, FieldDef, FieldKind, ObjectDef, PresenceDef, SignalDef, StreamDef,
};
use frick_protocol::{FrickSchema, Value};

use super::seam::{FixedClock, SeededIdGen};
use super::{
    Clock, DEFAULT_APP_ID, DEFAULT_TENANT_ID, FrickStore, FrickStoreOptions, FrickStoreWriteEvent,
};

const NOW: i64 = 1_700_000_000_000;

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

/// A schema with one object, one stream + event, one presence and one signal
/// type so every write facade can pack its payload.
fn test_schema() -> FrickSchema {
    FrickSchema {
        name: "facade-test".into(),
        schema_id: "facade-test".into(),
        schema_version: "1.0.0".into(),
        schema_revision: 1,
        minimum_client_revision: 1,
        minimum_server_revision: 1,
        protocol: "frick.realtime".into(),
        protocol_version: 1,
        compatibility: "greenfield-cutover".into(),
        hash: "facade-test-hash".into(),
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

async fn open_store() -> (Arc<FrickStore>, Arc<FixedClock>) {
    open_store_with(test_schema()).await
}

async fn open_store_with(schema: FrickSchema) -> (Arc<FrickStore>, Arc<FixedClock>) {
    let clock = Arc::new(FixedClock::new(NOW));
    let clock_seam: Box<dyn Clock> = Box::new(ClockHandle(Arc::clone(&clock)));
    let options = FrickStoreOptions {
        schema: Some(schema),
        ..FrickStoreOptions::memory()
    };
    let store = FrickStore::open_with_seams(options, clock_seam, Box::new(SeededIdGen::new()))
        .await
        .expect("store opens");
    (Arc::new(store), clock)
}

/// A `Clock` that reads through a shared [`FixedClock`] so a test can advance
/// time after the store is built.
struct ClockHandle(Arc<FixedClock>);
impl Clock for ClockHandle {
    fn now_ms(&self) -> i64 {
        self.0.now_ms()
    }
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

/// Collect every event the write listener observes into a shared vec.
fn recording_listener() -> (
    Arc<Mutex<Vec<FrickStoreWriteEvent>>>,
    super::FrickStoreWriteListener,
) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    let listener: super::FrickStoreWriteListener = Box::new(move |event| {
        sink.lock().unwrap().push(event.clone());
    });
    (events, listener)
}

#[tokio::test]
async fn construction_runs_migrations() {
    let (store, _clock) = open_store().await;
    let applied = store.list_applied_migrations().await.unwrap();
    // The full framework ledger (0001..0024) is applied at construction.
    assert!(
        applied.len() >= 24,
        "expected the framework migrations to be applied, got {}",
        applied.len()
    );
    assert_eq!(
        applied.first().unwrap().id,
        "0001_initial_foundation_tables"
    );
    assert!(store.ping_database().await);
}

#[tokio::test]
async fn records_schema_identity_row() {
    let (store, _clock) = open_store().await;
    let row = store
        .sql_driver()
        .get(
            "SELECT schema_hash, manifest, created_at FROM schema_versions WHERE schema_hash = ?",
            &["facade-test-hash".into()],
        )
        .await
        .unwrap()
        .expect("schema_versions row recorded");
    assert_eq!(row.text("schema_hash"), Some("facade-test-hash"));
    assert!(!row.blob("manifest").unwrap_or_default().is_empty());
    // created_at is the fixed-clock ISO timestamp.
    assert!(row.text("created_at").unwrap().ends_with('Z'));
}

#[tokio::test]
async fn upsert_object_fires_write_listener() {
    let (store, _clock) = open_store().await;
    let (events, listener) = recording_listener();
    store.set_write_listener(listener);

    store
        .upsert_object(
            DEFAULT_TENANT_ID,
            "Conversation",
            "c1",
            &convo("c1", "Hello"),
            0,
            DEFAULT_APP_ID,
        )
        .await
        .unwrap();

    let observed = events.lock().unwrap();
    assert_eq!(observed.len(), 1);
    match &observed[0] {
        FrickStoreWriteEvent::ObjectUpsert {
            tenant_id,
            app_id,
            object_type,
            object_id,
            object,
        } => {
            assert_eq!(tenant_id, DEFAULT_TENANT_ID);
            assert_eq!(app_id, DEFAULT_APP_ID);
            assert_eq!(object_type, "Conversation");
            assert_eq!(object_id, "c1");
            // The stored (re-read) object carries its id back.
            let Value::Map(entries) = object else {
                panic!("expected map object");
            };
            assert!(entries.iter().any(|(k, _)| k.as_str() == Some("id")));
        }
        other => panic!("expected ObjectUpsert, got {other:?}"),
    }
}

#[tokio::test]
async fn delete_object_fires_only_when_row_existed() {
    let (store, _clock) = open_store().await;
    let (events, listener) = recording_listener();
    store.set_write_listener(listener);

    // Delete a non-existent row → no event, returns false.
    let existed = store
        .delete_object(DEFAULT_TENANT_ID, "Conversation", "missing", DEFAULT_APP_ID)
        .await
        .unwrap();
    assert!(!existed);
    assert_eq!(events.lock().unwrap().len(), 0);

    // Write then delete → one delete event, returns true.
    store
        .upsert_object(
            DEFAULT_TENANT_ID,
            "Conversation",
            "c1",
            &convo("c1", "Hi"),
            0,
            DEFAULT_APP_ID,
        )
        .await
        .unwrap();
    events.lock().unwrap().clear();

    let existed = store
        .delete_object(DEFAULT_TENANT_ID, "Conversation", "c1", DEFAULT_APP_ID)
        .await
        .unwrap();
    assert!(existed);
    let observed = events.lock().unwrap();
    assert_eq!(observed.len(), 1);
    assert!(matches!(
        observed[0],
        FrickStoreWriteEvent::ObjectDelete { .. }
    ));
}

#[tokio::test]
async fn stream_append_fires_only_on_created() {
    let (store, _clock) = open_store().await;
    let (events, listener) = recording_listener();
    store.set_write_listener(listener);

    // First append → created == true → one event.
    let first = store
        .append_event(
            DEFAULT_TENANT_ID,
            "chat",
            "room-1",
            "replica-a",
            "req-1",
            "message",
            &message("hi"),
            DEFAULT_APP_ID,
        )
        .await
        .unwrap();
    assert!(first.created);
    assert_eq!(events.lock().unwrap().len(), 1);
    assert!(matches!(
        events.lock().unwrap()[0],
        FrickStoreWriteEvent::StreamAppend { .. }
    ));

    // Replay of the same (replica, request) → created == false → no new event.
    let replay = store
        .append_event(
            DEFAULT_TENANT_ID,
            "chat",
            "room-1",
            "replica-a",
            "req-1",
            "message",
            &message("hi"),
            DEFAULT_APP_ID,
        )
        .await
        .unwrap();
    assert!(!replay.created);
    assert_eq!(events.lock().unwrap().len(), 1, "replay must not re-fire");
    assert_eq!(replay.event.event.sequence, first.event.event.sequence);
}

#[tokio::test]
async fn write_listener_panic_is_swallowed() {
    let (store, _clock) = open_store().await;
    store.set_write_listener(Box::new(|_event| panic!("listener boom")));
    // A panicking listener must not propagate out of the write.
    store
        .upsert_object(
            DEFAULT_TENANT_ID,
            "Conversation",
            "c1",
            &convo("c1", "x"),
            0,
            DEFAULT_APP_ID,
        )
        .await
        .expect("write succeeds despite listener panic");
}

#[tokio::test]
async fn prune_deletes_aged_rows_and_rebuilds_cache() {
    let (store, clock) = open_store().await;

    // Append an event to create an idempotency_keys row at NOW.
    store
        .append_event(
            DEFAULT_TENANT_ID,
            "chat",
            "room-1",
            "replica-a",
            "req-1",
            "message",
            &message("hi"),
            DEFAULT_APP_ID,
        )
        .await
        .unwrap();
    assert_eq!(store.idempotency_key_row_count().await.unwrap(), 1);

    // Advance past the 24h retention window and prune.
    clock.advance(super::DEFAULT_IDEMPOTENCY_KEY_RETENTION_MS + 60_000);
    let result = store.prune().await.unwrap();
    assert_eq!(result.pruned_by_age, 1);
    assert_eq!(result.pruned_by_cap, 0);
    assert_eq!(store.idempotency_key_row_count().await.unwrap(), 0);

    // After the age sweep, the replay cache was rebuilt: the same (replica,
    // request) now mints a FRESH event rather than returning the stale cached
    // one (which would defeat retention).
    let again = store
        .append_event(
            DEFAULT_TENANT_ID,
            "chat",
            "room-1",
            "replica-a",
            "req-1",
            "message",
            &message("hi again"),
            DEFAULT_APP_ID,
        )
        .await
        .unwrap();
    assert!(again.created, "post-prune append must not be a cache hit");
}

#[tokio::test]
async fn prune_honors_per_tenant_retention_override() {
    let (store, clock) = open_store().await;

    // A tenant with a tiny retention override (stored as a JSON number).
    store
        .tenant_settings()
        .set("tenant-x", "retentionMs", &serde_json::json!(1000), NOW)
        .await
        .unwrap();

    // Row for tenant-x at NOW.
    store
        .append_event(
            "tenant-x",
            "chat",
            "room-1",
            "replica-a",
            "req-1",
            "message",
            &message("hi"),
            DEFAULT_APP_ID,
        )
        .await
        .unwrap();
    assert_eq!(store.idempotency_key_row_count().await.unwrap(), 1);

    // Advance only 2s — past the 1s override but far under the 24h global.
    clock.advance(2000);
    let result = store.prune().await.unwrap();
    assert_eq!(result.pruned_by_age, 1, "override cutoff prunes the row");
    assert_eq!(store.idempotency_key_row_count().await.unwrap(), 0);
}

#[tokio::test]
async fn for_app_injects_app_id() {
    let (store, _clock) = open_store().await;
    let scoped = store.for_app(Some("app-b"));
    assert_eq!(scoped.app_id(), "app-b");

    scoped
        .upsert_object(
            DEFAULT_TENANT_ID,
            "Conversation",
            "c1",
            &convo("c1", "y"),
            0,
        )
        .await
        .unwrap();

    // The row landed in app-b's partition.
    let in_b = store
        .objects()
        .read(DEFAULT_TENANT_ID, "Conversation", "c1", "app-b")
        .await
        .unwrap();
    assert!(in_b.is_some());
    // ... and not in the default app.
    let in_default = store
        .objects()
        .read(DEFAULT_TENANT_ID, "Conversation", "c1", DEFAULT_APP_ID)
        .await
        .unwrap();
    assert!(in_default.is_none());

    // for_app(_default) / None short-circuits to the default app id.
    assert_eq!(store.for_app(None).app_id(), DEFAULT_APP_ID);
    assert_eq!(store.for_app(Some(DEFAULT_APP_ID)).app_id(), DEFAULT_APP_ID);
}

#[tokio::test]
async fn postgres_driver_requires_a_database_url() {
    // The Postgres arm is wired (FR-242); construction without a connection
    // string is the one fast, deterministic failure (no DB needed). Live PG
    // behavior is covered by the FRICK_DATABASE_URL-gated `postgres_live` tests.
    let options = FrickStoreOptions {
        db_driver: super::StoreDriverKind::Postgres,
        database_url: None,
        ..FrickStoreOptions::memory()
    };
    let Err(err) = FrickStore::open(options).await else {
        panic!("expected the Postgres driver to require a database url");
    };
    assert!(err.to_string().contains("FRICK_DATABASE_URL"));
}

// ── blob bytes (write_content / read_content, map 05 §3.5/§3.6) ──────────────

#[tokio::test]
async fn write_then_read_content_round_trips_bytes() {
    use crate::stores::blob::BlobMetadataInput;

    let (store, _clock) = open_store().await;

    // The metadata row must exist first (blob_content.blob_id FK). The default
    // sqlite blob driver stores bytes in `blob_content`.
    store
        .blobs()
        .create(
            DEFAULT_TENANT_ID,
            &BlobMetadataInput {
                blob_id: "blob-1".into(),
                owner_id: "user-1".into(),
                content_hash: "sha256-deadbeef".into(),
                byte_length: 5,
                mime_type: "text/plain".into(),
                storage_key: None,
            },
            DEFAULT_APP_ID,
            NOW,
        )
        .await
        .unwrap();

    assert!(
        store
            .read_content(DEFAULT_TENANT_ID, "blob-1", DEFAULT_APP_ID)
            .await
            .unwrap()
            .is_none()
    );

    store
        .write_content(DEFAULT_TENANT_ID, "blob-1", b"hello", DEFAULT_APP_ID, NOW)
        .await
        .unwrap();

    assert_eq!(
        store
            .read_content(DEFAULT_TENANT_ID, "blob-1", DEFAULT_APP_ID)
            .await
            .unwrap(),
        Some(b"hello".to_vec())
    );

    // A different app partition does not see the bytes.
    assert!(
        store
            .read_content(DEFAULT_TENANT_ID, "blob-1", "other-app")
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn filesystem_blob_driver_is_built_from_options() {
    use crate::stores::blob::BlobMetadataInput;
    use crate::stores::blob_bytes::FrickBlobDriver;

    let root = tempfile::tempdir().unwrap();
    let options = FrickStoreOptions {
        schema: Some(test_schema()),
        blob_driver: FrickBlobDriver::Filesystem,
        blob_storage_path: Some(root.path().to_str().unwrap().to_string()),
        ..FrickStoreOptions::memory()
    };
    let store = FrickStore::open(options).await.expect("store opens");

    store
        .blobs()
        .create(
            DEFAULT_TENANT_ID,
            &BlobMetadataInput {
                blob_id: "blob-fs".into(),
                owner_id: "user-1".into(),
                content_hash: "sha256-abc".into(),
                byte_length: 3,
                mime_type: "application/octet-stream".into(),
                storage_key: None,
            },
            DEFAULT_APP_ID,
            NOW,
        )
        .await
        .unwrap();
    store
        .write_content(DEFAULT_TENANT_ID, "blob-fs", b"PNG", DEFAULT_APP_ID, NOW)
        .await
        .unwrap();

    assert_eq!(
        store
            .read_content(DEFAULT_TENANT_ID, "blob-fs", DEFAULT_APP_ID)
            .await
            .unwrap(),
        Some(b"PNG".to_vec())
    );
    // The bytes landed under the filesystem root, not in SQL.
    assert!(matches!(
        store.blob_bytes(),
        crate::stores::blob_bytes::BlobBytesDriver::Filesystem(_)
    ));
}
