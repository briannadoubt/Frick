//! Store-level integration tests for server-side at-rest encryption
//! (AURA-328): object values, blob content bytes, and push tokens round-trip
//! through the facade while their stored columns carry sealed envelopes,
//! legacy plaintext rows keep reading after a key is configured, and a wrong
//! key fails reads loudly instead of returning garbage.

use std::sync::Arc;

use frick_protocol::schema::{FieldDef, FieldKind, ObjectDef};
use frick_protocol::{FrickSchema, Value};
use frick_store::stores::blob::BlobMetadataInput;
use frick_store::stores::push_registration::{
    PushEnvironment, PushPlatform, PushRegistrationInput,
};
use frick_store::{
    AtRestEncryption, DEFAULT_APP_ID, DEFAULT_TENANT_ID, EnvKeyProvider, FrickStore,
    FrickStoreOptions,
};

const NOW: i64 = 1_700_000_000_123;

/// The binary envelope magic (kept in sync with `encryption.rs`).
const ENVELOPE_MAGIC: &[u8] = b"FRICKAE1";

/// The TEXT-column envelope prefix (kept in sync with `encryption.rs`).
const TEXT_ENVELOPE_PREFIX: &str = "frickenc:v1:";

fn engine(key: [u8; 32]) -> Arc<AtRestEncryption> {
    Arc::new(AtRestEncryption::new(Arc::new(
        EnvKeyProvider::new("test-key-1", key).expect("valid key id"),
    )))
}

/// A minimal product schema with one `Conversation` object type, so the
/// object codec has fields to pack.
fn test_schema() -> FrickSchema {
    FrickSchema {
        name: "at-rest-test".into(),
        schema_id: "at-rest-test".into(),
        schema_version: "1.0.0".into(),
        schema_revision: 1,
        minimum_client_revision: 1,
        minimum_server_revision: 1,
        protocol: "frick.realtime".into(),
        protocol_version: 1,
        compatibility: "greenfield-cutover".into(),
        hash: "at-rest-test-hash".into(),
        objects: vec![ObjectDef {
            id: 2,
            name: "Conversation".into(),
            fields: vec![FieldDef {
                id: 2,
                name: "title".into(),
                kind: FieldKind::String,
                required: false,
                ref_: None,
                enum_values: None,
                sensitivity: None,
            }],
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

fn options(path: &str, encryption: Option<Arc<AtRestEncryption>>) -> FrickStoreOptions {
    FrickStoreOptions {
        path: path.to_string(),
        encryption,
        schema: Some(test_schema()),
        ..FrickStoreOptions::memory()
    }
}

fn conversation_value(id: &str, title: &str) -> Value {
    Value::Map(vec![
        ("id".into(), id.into()),
        ("title".into(), title.into()),
    ])
}

async fn raw_packed(store: &FrickStore, object_id: &str) -> Vec<u8> {
    store
        .sql_driver()
        .get(
            "SELECT packed FROM objects WHERE object_id = ?",
            &[object_id.into()],
        )
        .await
        .expect("raw packed read")
        .expect("row exists")
        .blob("packed")
        .expect("packed is a blob")
        .to_vec()
}

#[tokio::test]
async fn object_values_seal_at_rest_and_round_trip() {
    let store = FrickStore::open(options(":memory:", Some(engine([7u8; 32]))))
        .await
        .expect("open encrypted store");
    let value = conversation_value("conv-1", "Ada thread");
    store
        .upsert_object(
            DEFAULT_TENANT_ID,
            "Conversation",
            "conv-1",
            &value,
            1,
            DEFAULT_APP_ID,
        )
        .await
        .expect("upsert");

    // The facade read decrypts back to the original value.
    let read = store
        .objects()
        .read(DEFAULT_TENANT_ID, "Conversation", "conv-1", DEFAULT_APP_ID)
        .await
        .expect("read")
        .expect("present");
    assert_eq!(read, value);

    // The stored column is a sealed envelope, not msgpack plaintext.
    let stored = raw_packed(&store, "conv-1").await;
    assert!(
        stored.starts_with(ENVELOPE_MAGIC),
        "packed column must be sealed"
    );
    assert!(
        !stored.windows(10).any(|w| w == b"Ada thread"),
        "plaintext must not appear in the stored bytes"
    );

    // The policy-honoring write path seals too, and list() decrypts.
    store
        .upsert_object_with_policy(
            DEFAULT_TENANT_ID,
            DEFAULT_APP_ID,
            "Conversation",
            "conv-2",
            &conversation_value("conv-2", "Grace thread"),
            None,
            None,
        )
        .await
        .expect("policy upsert");
    assert!(
        raw_packed(&store, "conv-2")
            .await
            .starts_with(ENVELOPE_MAGIC)
    );
    let listed = store
        .objects()
        .list(DEFAULT_TENANT_ID, "Conversation", DEFAULT_APP_ID)
        .await
        .expect("list");
    assert_eq!(listed.len(), 2);
}

#[tokio::test]
async fn legacy_plaintext_object_rows_read_after_key_is_configured() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("legacy.sqlite");
    let path = path.to_str().expect("utf8 path");

    // Yesterday's server: no key configured, rows land plaintext.
    {
        let plain = FrickStore::open(options(path, None))
            .await
            .expect("open plaintext store");
        assert!(plain.at_rest_encryption().is_none());
        plain
            .upsert_object(
                DEFAULT_TENANT_ID,
                "Conversation",
                "legacy-1",
                &conversation_value("legacy-1", "Marge thread"),
                1,
                DEFAULT_APP_ID,
            )
            .await
            .expect("plaintext upsert");
        assert!(
            !raw_packed(&plain, "legacy-1")
                .await
                .starts_with(ENVELOPE_MAGIC)
        );
    }

    // Today's server: key configured. The legacy row still reads, and new
    // writes seal — encrypt-on-write, no migration of existing rows.
    let sealed = FrickStore::open(options(path, Some(engine([7u8; 32]))))
        .await
        .expect("reopen with key");
    let legacy = sealed
        .objects()
        .read(
            DEFAULT_TENANT_ID,
            "Conversation",
            "legacy-1",
            DEFAULT_APP_ID,
        )
        .await
        .expect("legacy read")
        .expect("legacy row present");
    assert_eq!(legacy, conversation_value("legacy-1", "Marge thread"));
    sealed
        .upsert_object(
            DEFAULT_TENANT_ID,
            "Conversation",
            "fresh-1",
            &conversation_value("fresh-1", "Turing thread"),
            1,
            DEFAULT_APP_ID,
        )
        .await
        .expect("sealed upsert");
    assert!(
        raw_packed(&sealed, "fresh-1")
            .await
            .starts_with(ENVELOPE_MAGIC)
    );
}

#[tokio::test]
async fn blob_content_seals_at_rest_and_round_trips() {
    let store = FrickStore::open(options(":memory:", Some(engine([7u8; 32]))))
        .await
        .expect("open encrypted store");
    let content = b"attachment bytes that deserve at-rest protection".to_vec();
    store
        .blobs()
        .create(
            DEFAULT_TENANT_ID,
            &BlobMetadataInput {
                blob_id: "blob-1".to_string(),
                owner_id: "user-1".to_string(),
                content_hash: "sha256-test".to_string(),
                byte_length: i64::try_from(content.len()).expect("length fits"),
                mime_type: "application/octet-stream".to_string(),
                storage_key: None,
            },
            DEFAULT_APP_ID,
            NOW,
        )
        .await
        .expect("blob metadata");
    store
        .write_content(DEFAULT_TENANT_ID, "blob-1", &content, DEFAULT_APP_ID, NOW)
        .await
        .expect("write content");

    // Facade read round-trips.
    let read = store
        .read_content(DEFAULT_TENANT_ID, "blob-1", DEFAULT_APP_ID)
        .await
        .expect("read content")
        .expect("bytes present");
    assert_eq!(read, content);

    // The raw blob_content row is sealed.
    let raw = store
        .sql_driver()
        .get(
            "SELECT content FROM blob_content WHERE blob_id = ?",
            &["blob-1".into()],
        )
        .await
        .expect("raw content read")
        .expect("row exists")
        .blob("content")
        .expect("content is a blob")
        .to_vec();
    assert!(
        raw.starts_with(ENVELOPE_MAGIC),
        "blob content must be sealed"
    );
    assert_ne!(raw, content);
}

#[tokio::test]
async fn push_tokens_seal_at_rest_and_round_trip() {
    let store = FrickStore::open(options(":memory:", Some(engine([7u8; 32]))))
        .await
        .expect("open encrypted store");
    let input = PushRegistrationInput {
        tenant_id: DEFAULT_TENANT_ID.to_string(),
        user_id: "user-1".to_string(),
        device_id: "device-1".to_string(),
        platform: PushPlatform::Apns,
        token: "apns-device-token-secret".to_string(),
        environment: PushEnvironment::Production,
    };
    let registered = store
        .push_registrations()
        .register(&input, "push-1", NOW)
        .await
        .expect("register");
    assert_eq!(registered.token, "apns-device-token-secret");

    // The stored token column carries the text envelope, not the token.
    let raw_token = store
        .sql_driver()
        .get(
            "SELECT token FROM push_device_registrations WHERE registration_id = ?",
            &["push-1".into()],
        )
        .await
        .expect("raw token read")
        .expect("row exists")
        .text("token")
        .expect("token is text")
        .to_string();
    assert!(raw_token.starts_with(TEXT_ENVELOPE_PREFIX));
    assert!(!raw_token.contains("apns-device-token-secret"));

    // Every read path decrypts: get_by_id, list_by_user, and the
    // register-refresh path (which routes through find_active).
    let fetched = store
        .push_registrations()
        .get_by_id("push-1", DEFAULT_TENANT_ID)
        .await
        .expect("get_by_id")
        .expect("present");
    assert_eq!(fetched.token, "apns-device-token-secret");
    let listed = store
        .push_registrations()
        .list_by_user(DEFAULT_TENANT_ID, "user-1")
        .await
        .expect("list_by_user");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].token, "apns-device-token-secret");
    let refreshed = store
        .push_registrations()
        .register(
            &PushRegistrationInput {
                token: "apns-device-token-rotated".to_string(),
                ..input
            },
            "push-ignored",
            NOW + 1_000,
        )
        .await
        .expect("refresh register");
    assert_eq!(refreshed.registration_id, "push-1");
    assert_eq!(refreshed.token, "apns-device-token-rotated");
}

#[tokio::test]
async fn legacy_plaintext_push_tokens_read_after_key_is_configured() {
    let store = FrickStore::open(options(":memory:", Some(engine([7u8; 32]))))
        .await
        .expect("open encrypted store");
    // A row written by yesterday's plaintext server.
    store
        .sql_driver()
        .run(
            "INSERT INTO push_device_registrations
                (registration_id, tenant_id, user_id, device_id, platform, token,
                 environment, created_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            &[
                "push-legacy".into(),
                DEFAULT_TENANT_ID.into(),
                "user-1".into(),
                "device-legacy".into(),
                "apns".into(),
                "legacy-plaintext-token".into(),
                "production".into(),
                "2026-01-01T00:00:00.000Z".into(),
                "2026-01-01T00:00:00.000Z".into(),
            ],
        )
        .await
        .expect("seed legacy row");
    let fetched = store
        .push_registrations()
        .get_by_id("push-legacy", DEFAULT_TENANT_ID)
        .await
        .expect("get_by_id")
        .expect("present");
    assert_eq!(fetched.token, "legacy-plaintext-token");
}

#[tokio::test]
async fn wrong_key_fails_reads_across_reopen() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("rotated.sqlite");
    let path = path.to_str().expect("utf8 path");

    {
        let store = FrickStore::open(options(path, Some(engine([7u8; 32]))))
            .await
            .expect("open with key A");
        store
            .upsert_object(
                DEFAULT_TENANT_ID,
                "Conversation",
                "conv-1",
                &conversation_value("conv-1", "Ada thread"),
                1,
                DEFAULT_APP_ID,
            )
            .await
            .expect("upsert under key A");
    }

    // Same key id, different key material: reads must fail loudly.
    let wrong = FrickStore::open(options(path, Some(engine([9u8; 32]))))
        .await
        .expect("open with key B");
    let error = wrong
        .objects()
        .read(DEFAULT_TENANT_ID, "Conversation", "conv-1", DEFAULT_APP_ID)
        .await
        .expect_err("wrong key must fail the read");
    assert!(error.to_string().contains("at-rest decryption failed"));
}
