//! Tests for the blob processor/validator pipeline (FR-272): the registry, the
//! stock validators, the moderation hook, the `blob.process` payload codec, and
//! the `blob.process` job handler driven against an in-memory store.

use std::sync::Arc;

use frick_protocol::Value;
use frick_store::facade::seam::{FixedClock, SeededIdGen};
use frick_store::stores::blob::BlobMetadataInput;
use frick_store::{DEFAULT_APP_ID, FrickStore, FrickStoreOptions};

use super::*;
use crate::jobs::{JobContext, JobHandler, JobHandlerRegistry};

const NOW_MS: i64 = 1_000_000_000_000; // 2001-09-09T01:46:40.000Z
const TENANT: &str = "tenant-1";

async fn memory_store() -> Arc<FrickStore> {
    Arc::new(
        FrickStore::open_with_seams(
            FrickStoreOptions::memory(),
            Box::new(FixedClock::new(NOW_MS)),
            Box::new(SeededIdGen::new()),
        )
        .await
        .expect("open in-memory store"),
    )
}

/// Create blob metadata + content for a blob the `blob.process` handler reads.
async fn seed_blob(store: &FrickStore, blob_id: &str, mime: &str, content: &[u8]) {
    let byte_length = i64::try_from(content.len()).unwrap();
    store
        .blobs()
        .create(
            TENANT,
            &BlobMetadataInput {
                blob_id: blob_id.to_string(),
                owner_id: "owner-1".to_string(),
                content_hash: "sha256-test".to_string(),
                byte_length,
                mime_type: mime.to_string(),
                storage_key: None,
            },
            DEFAULT_APP_ID,
            NOW_MS,
        )
        .await
        .expect("create metadata");
    store
        .write_content(TENANT, blob_id, content, DEFAULT_APP_ID, NOW_MS)
        .await
        .expect("write content");
}

// ── registry ────────────────────────────────────────────────────────────────

#[test]
fn register_rejects_duplicate_ids() {
    let mut registry = BlobProcessorRegistry::new();
    registry
        .register(mime_size_validator(MimeSizeValidatorOptions {
            id: "dup".to_string(),
            ..Default::default()
        }))
        .expect("first register");
    let err = registry
        .register(mime_size_validator(MimeSizeValidatorOptions {
            id: "dup".to_string(),
            ..Default::default()
        }))
        .expect_err("duplicate id rejected");
    assert_eq!(err.processor_id, "dup");
    assert_eq!(err.reason(), "duplicateBlobProcessor");
}

#[test]
fn matching_filters_by_mime_prefix_and_size() {
    let mut registry = BlobProcessorRegistry::new();
    // image/* only.
    registry
        .register(mime_size_validator(MimeSizeValidatorOptions {
            id: "img".to_string(),
            matches: ProcessorMatch {
                mime_prefixes: vec!["image/".to_string()],
                max_byte_length: None,
            },
            ..Default::default()
        }))
        .unwrap();
    // any mime, but <= 100 bytes.
    registry
        .register(mime_size_validator(MimeSizeValidatorOptions {
            id: "small".to_string(),
            matches: ProcessorMatch {
                mime_prefixes: Vec::new(),
                max_byte_length: Some(100),
            },
            ..Default::default()
        }))
        .unwrap();
    // any mime, any size.
    registry
        .register(mime_size_validator(MimeSizeValidatorOptions {
            id: "any".to_string(),
            ..Default::default()
        }))
        .unwrap();

    let ids = |mime: &str, len: i64| -> Vec<String> {
        registry
            .matching(mime, len)
            .iter()
            .map(|p| p.id().to_string())
            .collect()
    };
    // A small image hits all three, in registration order.
    assert_eq!(ids("image/png", 50), vec!["img", "small", "any"]);
    // A large image skips the size-capped one.
    assert_eq!(ids("image/png", 500), vec!["img", "any"]);
    // A small non-image skips the image-only one.
    assert_eq!(ids("text/plain", 50), vec!["small", "any"]);
    // A large non-image matches only the catch-all.
    assert_eq!(ids("text/plain", 500), vec!["any"]);
}

#[test]
fn resolve_and_ids_are_sorted() {
    let mut registry = BlobProcessorRegistry::new();
    for id in ["zeta", "alpha", "mid"] {
        registry
            .register(mime_size_validator(MimeSizeValidatorOptions {
                id: id.to_string(),
                ..Default::default()
            }))
            .unwrap();
    }
    assert!(registry.resolve("mid").is_some());
    assert!(registry.resolve("absent").is_none());
    // `ids()` is sorted (inspect surface); `list()` keeps registration order.
    assert_eq!(registry.ids(), vec!["alpha", "mid", "zeta"]);
    let listed: Vec<&str> = registry.list().iter().map(|p| p.id()).collect();
    assert_eq!(listed, vec!["zeta", "alpha", "mid"]);
}

// ── mime/size validator ───────────────────────────────────────────────────

fn validate(
    processor: &SharedBlobProcessor,
    store: &FrickStore,
    mime: &str,
    bytes: &[u8],
) -> BlobValidation {
    processor.validate(&BlobValidateContext {
        tenant_id: TENANT,
        blob_id: "b-1",
        owner_id: "owner-1",
        mime_type: mime,
        byte_length: i64::try_from(bytes.len()).unwrap(),
        preview: bytes,
        store,
    })
}

#[tokio::test]
async fn mime_size_validator_rejects_empty_oversize_and_disallowed() {
    let store = memory_store().await;
    let processor = mime_size_validator(MimeSizeValidatorOptions {
        allowed_mime_types: vec!["image/".to_string(), "application/pdf".to_string()],
        max_bytes: Some(8),
        ..Default::default()
    });
    assert!(processor.has_validate());
    assert!(!processor.has_process());

    // Empty upload → reject.
    assert!(matches!(
        validate(&processor, &store, "image/png", b""),
        BlobValidation::Reject { .. }
    ));
    // Oversize → reject.
    let BlobValidation::Reject { reason } =
        validate(&processor, &store, "image/png", b"0123456789")
    else {
        panic!("expected reject");
    };
    assert!(reason.contains("10 bytes"), "reason: {reason}");
    assert!(reason.contains("limit is 8"), "reason: {reason}");
    // Disallowed mime → reject.
    let BlobValidation::Reject { reason } = validate(&processor, &store, "text/plain", b"ab")
    else {
        panic!("expected reject");
    };
    assert!(reason.contains("text/plain"), "reason: {reason}");
    // Allowed prefix + allowed exact + under cap → ok.
    assert!(matches!(
        validate(&processor, &store, "image/jpeg", b"ab"),
        BlobValidation::Ok
    ));
    assert!(matches!(
        validate(&processor, &store, "application/pdf", b"%PDF"),
        BlobValidation::Ok
    ));
}

#[tokio::test]
async fn mime_size_validator_empty_allow_list_is_size_only() {
    let store = memory_store().await;
    let processor = mime_size_validator(MimeSizeValidatorOptions {
        max_bytes: Some(4),
        reject_empty: false,
        ..Default::default()
    });
    // Empty allowed (reject_empty=false), any mime allowed.
    assert!(matches!(
        validate(&processor, &store, "anything/goes", b""),
        BlobValidation::Ok
    ));
    assert!(matches!(
        validate(&processor, &store, "anything/goes", b"abc"),
        BlobValidation::Ok
    ));
    // Still size-capped.
    assert!(matches!(
        validate(&processor, &store, "anything/goes", b"abcde"),
        BlobValidation::Reject { .. }
    ));
}

// ── payload codec ─────────────────────────────────────────────────────────

#[test]
fn payload_round_trips_and_rejects_garbage() {
    let payload = BlobProcessPayload {
        blob_id: "b-7".to_string(),
        processor_id: "p-9".to_string(),
    };
    let encoded = encode_blob_process_payload(&payload);
    assert_eq!(decode_blob_process_payload(&encoded).unwrap(), payload);

    // Non-map.
    assert!(decode_blob_process_payload(&Value::from("x")).is_err());
    // Missing/empty blobId.
    assert!(
        decode_blob_process_payload(&Value::Map(vec![(
            Value::from("processorId"),
            Value::from("p"),
        )]))
        .is_err()
    );
    assert!(
        decode_blob_process_payload(&Value::Map(vec![
            (Value::from("blobId"), Value::from("")),
            (Value::from("processorId"), Value::from("p")),
        ]))
        .is_err()
    );
    // Missing processorId.
    assert!(
        decode_blob_process_payload(&Value::Map(vec![
            (Value::from("blobId"), Value::from("b"),)
        ]))
        .is_err()
    );
}

// ── blob.process job handler ───────────────────────────────────────────────

/// A processor that emits one fixed derivative per blob, recording the bytes it
/// saw so the test can assert the handler read the right content.
struct DerivativeProcessor {
    id: String,
    derivative_id: String,
}

impl BlobProcessor for DerivativeProcessor {
    fn id(&self) -> &str {
        &self.id
    }
    fn has_process(&self) -> bool {
        true
    }
    fn process<'a>(&'a self, ctx: BlobProcessContext<'a>) -> ProcessFuture<'a> {
        let derivative_id = self.derivative_id.clone();
        Box::pin(async move {
            // Read the parent bytes to prove the context resolved them.
            let bytes = ctx
                .store
                .read_content(ctx.tenant_id, ctx.blob_id, DEFAULT_APP_ID)
                .await
                .unwrap()
                .unwrap_or_default();
            let mut meta = serde_json::Map::new();
            meta.insert("source".to_string(), serde_json::Value::from("test"));
            Ok(BlobProcessOutcome {
                derivatives: vec![BlobDerivative {
                    derivative_id,
                    mime_type: "application/octet-stream".to_string(),
                    bytes: bytes.iter().rev().copied().collect(),
                    metadata: Some(serde_json::Value::Object(meta)),
                }],
            })
        })
    }
}

#[tokio::test]
async fn job_handler_registers_under_blob_process() {
    let processors = Arc::new(BlobProcessorRegistry::new());
    let mut registry = JobHandlerRegistry::new();
    registry
        .register(
            BLOB_PROCESS_JOB_TYPE,
            BlobProcessHandler::new(Arc::clone(&processors)).into_job_handler(),
        )
        .expect("register blob.process");
    assert!(registry.contains(BLOB_PROCESS_JOB_TYPE));
    assert!(registry.list().contains(&"blob.process".to_string()));
}

#[tokio::test]
async fn job_handler_persists_derivative() {
    let store = memory_store().await;
    seed_blob(&store, "blob-A", "image/png", b"hello").await;

    let mut processors = BlobProcessorRegistry::new();
    processors
        .register(Arc::new(DerivativeProcessor {
            id: "rev".to_string(),
            derivative_id: "reversed".to_string(),
        }))
        .unwrap();
    let processors = Arc::new(processors);
    let handler = BlobProcessHandler::new(Arc::clone(&processors));

    let payload = encode_blob_process_payload(&BlobProcessPayload {
        blob_id: "blob-A".to_string(),
        processor_id: "rev".to_string(),
    });
    let result = handler.run_job(TENANT, &payload, &store).await.unwrap();
    // Result reports one derivative.
    let Value::Map(entries) = &result else {
        panic!("map result")
    };
    let count = entries
        .iter()
        .find(|(k, _)| k.as_str() == Some("derivatives"))
        .and_then(|(_, v)| v.as_i64());
    assert_eq!(count, Some(1));

    // The derivative row + bytes landed (reversed "hello" = "olleh").
    let read = store
        .read_derivative("blob-A", "reversed", TENANT)
        .await
        .unwrap()
        .expect("derivative present");
    assert_eq!(read.bytes, b"olleh");
    assert_eq!(read.row.processor_id, "rev");
    assert_eq!(read.row.mime_type, "application/octet-stream");
    assert_eq!(read.row.content_hash, format!("sha256-{}", hex_olleh()));
    assert_eq!(read.row.storage_key, "derivative/blob-A/reversed");
    let metadata = read.row.metadata.expect("metadata json");
    assert_eq!(metadata["source"], serde_json::Value::from("test"));
}

/// `hex(sha256("olleh"))` — pins the derivative content-hash envelope.
fn hex_olleh() -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(b"olleh"))
}

#[tokio::test]
async fn job_handler_unknown_processor_is_fatal() {
    let store = memory_store().await;
    seed_blob(&store, "blob-B", "text/plain", b"x").await;
    let handler = BlobProcessHandler::new(Arc::new(BlobProcessorRegistry::new()));
    let payload = encode_blob_process_payload(&BlobProcessPayload {
        blob_id: "blob-B".to_string(),
        processor_id: "ghost".to_string(),
    });
    let err = handler.run_job(TENANT, &payload, &store).await.unwrap_err();
    assert_eq!(err.error_code, "blob.unknownProcessor");
    assert!(!err.retryable);
}

#[tokio::test]
async fn job_handler_missing_blob_is_fatal() {
    let store = memory_store().await;
    let mut processors = BlobProcessorRegistry::new();
    processors
        .register(Arc::new(DerivativeProcessor {
            id: "rev".to_string(),
            derivative_id: "reversed".to_string(),
        }))
        .unwrap();
    let handler = BlobProcessHandler::new(Arc::new(processors));
    let payload = encode_blob_process_payload(&BlobProcessPayload {
        blob_id: "missing".to_string(),
        processor_id: "rev".to_string(),
    });
    let err = handler.run_job(TENANT, &payload, &store).await.unwrap_err();
    assert_eq!(err.error_code, "blob.notFound");
    assert!(!err.retryable);
}

#[tokio::test]
async fn job_handler_invalid_payload_is_fatal() {
    let store = memory_store().await;
    let handler = BlobProcessHandler::new(Arc::new(BlobProcessorRegistry::new()));
    let err = handler
        .run_job(TENANT, &Value::from("garbage"), &store)
        .await
        .unwrap_err();
    assert_eq!(err.error_code, "blob.invalidPayload");
    assert!(!err.retryable);
}

#[tokio::test]
async fn job_handler_validate_only_processor_completes_zero() {
    let store = memory_store().await;
    seed_blob(&store, "blob-C", "text/plain", b"x").await;
    let mut processors = BlobProcessorRegistry::new();
    // A validate-only processor (no process phase).
    processors
        .register(mime_size_validator(MimeSizeValidatorOptions {
            id: "validate-only".to_string(),
            ..Default::default()
        }))
        .unwrap();
    let handler = BlobProcessHandler::new(Arc::new(processors));
    let payload = encode_blob_process_payload(&BlobProcessPayload {
        blob_id: "blob-C".to_string(),
        processor_id: "validate-only".to_string(),
    });
    let result = handler.run_job(TENANT, &payload, &store).await.unwrap();
    let Value::Map(entries) = &result else {
        panic!("map result")
    };
    let count = entries
        .iter()
        .find(|(k, _)| k.as_str() == Some("derivatives"))
        .and_then(|(_, v)| v.as_i64());
    assert_eq!(count, Some(0));
    // No derivative written.
    assert_eq!(
        store
            .list_derivatives("blob-C", TENANT)
            .await
            .unwrap()
            .len(),
        0
    );
}

// ── moderation processor ──────────────────────────────────────────────────

struct FlagHook;

impl ModerationHook for FlagHook {
    fn decide<'a>(&'a self, ctx: ModerationContext<'a>) -> ModerationFuture<'a> {
        // Assert the hook receives the stored bytes.
        let saw_content = ctx.content.map(<[u8]>::to_vec);
        Box::pin(async move {
            assert_eq!(saw_content.as_deref(), Some(b"unsafe".as_slice()));
            Ok(ModerationVerdict {
                decision: ModerationDecision::Flag,
                reason: Some("looks risky".to_string()),
                details: None,
            })
        })
    }
}

#[tokio::test]
async fn moderation_processor_writes_verdict_sidecar() {
    let store = memory_store().await;
    seed_blob(&store, "blob-M", "text/plain", b"unsafe").await;

    let mut processors = BlobProcessorRegistry::new();
    processors
        .register(moderation_processor(ModerationProcessorOptions::new(
            Arc::new(FlagHook),
        )))
        .unwrap();
    let handler = BlobProcessHandler::new(Arc::new(processors));

    let payload = encode_blob_process_payload(&BlobProcessPayload {
        blob_id: "blob-M".to_string(),
        processor_id: "frick-moderation".to_string(),
    });
    handler.run_job(TENANT, &payload, &store).await.unwrap();

    let read = store
        .read_derivative("blob-M", "moderation", TENANT)
        .await
        .unwrap()
        .expect("sidecar present");
    assert_eq!(read.row.mime_type, "application/json");
    let sidecar: serde_json::Value = serde_json::from_slice(&read.bytes).unwrap();
    assert_eq!(sidecar["decision"], serde_json::Value::from("flag"));
    assert_eq!(sidecar["reason"], serde_json::Value::from("looks risky"));
    // The derivative row metadata carries the decision too.
    let metadata = read.row.metadata.expect("metadata");
    assert_eq!(metadata["decision"], serde_json::Value::from("flag"));
}

struct ErrorHook;

impl ModerationHook for ErrorHook {
    fn decide<'a>(&'a self, _ctx: ModerationContext<'a>) -> ModerationFuture<'a> {
        Box::pin(async { Err(BlobProcessError::retryable("vendor timeout")) })
    }
}

#[tokio::test]
async fn process_error_maps_to_retryable_job_error() {
    let store = memory_store().await;
    seed_blob(&store, "blob-E", "text/plain", b"x").await;
    let mut processors = BlobProcessorRegistry::new();
    processors
        .register(moderation_processor(ModerationProcessorOptions::new(
            Arc::new(ErrorHook),
        )))
        .unwrap();
    let handler = BlobProcessHandler::new(Arc::new(processors));
    let payload = encode_blob_process_payload(&BlobProcessPayload {
        blob_id: "blob-E".to_string(),
        processor_id: "frick-moderation".to_string(),
    });
    let err = handler.run_job(TENANT, &payload, &store).await.unwrap_err();
    assert_eq!(err.error_code, "blob.processorError");
    assert!(err.retryable);
}

// ── dispatch through a JobContext (worker boundary) ─────────────────────────

#[tokio::test]
async fn handle_via_job_context_dispatches_to_run_job() {
    let store = memory_store().await;
    seed_blob(&store, "blob-D", "image/png", b"abc").await;
    let mut processors = BlobProcessorRegistry::new();
    processors
        .register(Arc::new(DerivativeProcessor {
            id: "rev".to_string(),
            derivative_id: "d".to_string(),
        }))
        .unwrap();
    let handler = BlobProcessHandler::new(Arc::new(processors));

    let payload = encode_blob_process_payload(&BlobProcessPayload {
        blob_id: "blob-D".to_string(),
        processor_id: "rev".to_string(),
    });
    let ctx = JobContext {
        tenant_id: TENANT.to_string(),
        app_id: DEFAULT_APP_ID.to_string(),
        job_id: 1,
        job_type: BLOB_PROCESS_JOB_TYPE.to_string(),
        payload,
        attempt_count: 1,
        store: store.for_app(Some(DEFAULT_APP_ID)),
    };
    handler.handle(ctx).await.expect("dispatch ok");
    // "cba" = reversed "abc".
    let read = store
        .read_derivative("blob-D", "d", TENANT)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(read.bytes, b"cba");
}
