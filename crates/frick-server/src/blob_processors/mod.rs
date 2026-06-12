//! Blob processors / validators pipeline (FR-272; map 05 §3.5/§3.7).
//!
//! Apps register blob processors at boot to hook into the blob upload pipeline.
//! Two phases exist, mirroring the deleted TS (`apps/server/src/blobs/`):
//!
//! - [`BlobProcessor::validate`] runs **synchronously** on the upload request,
//!   before any row is written, against the first 4 KiB preview of the content
//!   (`apps/server/src/blobs/processor.ts`, `validation-processor.ts`). A
//!   rejection surfaces as `415 blob.unsupportedContentType` and never leaves an
//!   upload-in-progress trail in the store. Use it for fast checks (MIME
//!   allow-list, size policy, magic-byte sniffing).
//! - [`BlobProcessor::process`] runs **asynchronously** as a `blob.process` job
//!   after the upload commits (`apps/server/src/blobs/processor-job.ts`). Use it
//!   for slow work (thumbnails, OCR, moderation). Returned derivatives are
//!   persisted via [`FrickStore::record_derivative`].
//!
//! Processors declare match criteria via [`ProcessorMatch`] — a MIME-prefix
//! allow-list and an optional max byte length. A processor that omits both
//! matches every blob.
//!
//! # What ships here
//!
//! - [`BlobProcessor`] / [`BlobProcessorRegistry`] — the registry surface (the
//!   TS `FrickBlobProcessorRegistry`). Duplicate ids throw at registration
//!   ([`DuplicateBlobProcessorError`]) so derivative provenance stays
//!   unambiguous.
//! - [`mime_size_validator`] — a generic MIME/size validator (FR-55,
//!   `validation-processor.ts`).
//! - [`moderation_processor`] — the moderation *hook mechanism*
//!   (`validation-processor.ts`): the app plugs in the policy; the framework
//!   ships the async `process`-phase plumbing + the JSON sidecar derivative.
//! - [`BlobProcessHandler`] + [`BLOB_PROCESS_JOB_TYPE`] — the `blob.process`
//!   [`JobHandler`], registered into the [`JobHandlerRegistry`] at boot
//!   (mirroring `push.deliver`).
//!
//! # What is deferred
//!
//! Image-derivative generation (thumbnails, the magic-byte sniffer + the
//! decompression-bomb pixel guard of `apps/server/src/blobs/image-processor.ts`,
//! FR-130) is a **follow-up**: it needs the `image` crate, which is not yet in
//! the workspace. The processor seam here is the exact insertion point — an
//! image processor is just another [`BlobProcessor`] whose `process` returns
//! derivatives. This module ships the registry, the validator surface, and the
//! `blob.process` job wiring so that work drops in additively.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use frick_protocol::Value;
use frick_store::{DerivativeRecordInput, FrickStore};

use crate::jobs::{JobContext, JobError, JobHandler, JobHandlerFuture};

/// The `blob.process` job type (TS `BLOB_PROCESS_JOB_TYPE`,
/// processor-job.ts:30). Registered into the [`JobHandlerRegistry`] at boot.
///
/// [`JobHandlerRegistry`]: crate::jobs::JobHandlerRegistry
pub const BLOB_PROCESS_JOB_TYPE: &str = "blob.process";

// ── processor surface ──────────────────────────────────────────────────────

/// Match criteria deciding which uploads a processor inspects (TS
/// `FrickBlobProcessor["matches"]`, processor.ts:78-84). An empty match (both
/// fields default) matches **every** blob — so a disallowed upload is actively
/// rejected rather than silently skipped.
#[derive(Debug, Clone, Default)]
pub struct ProcessorMatch {
    /// MIME prefixes the processor matches (e.g. `["image/"]`). Empty ⇒ any.
    pub mime_prefixes: Vec<String>,
    /// Skip blobs above this size. `None` ⇒ any.
    pub max_byte_length: Option<i64>,
}

impl ProcessorMatch {
    /// Whether this match accepts `(mime_type, byte_length)` (TS
    /// `processorMatches`, processor.ts:130-145).
    #[must_use]
    pub fn accepts(&self, mime_type: &str, byte_length: i64) -> bool {
        if !self.mime_prefixes.is_empty()
            && !self
                .mime_prefixes
                .iter()
                .any(|prefix| mime_type.starts_with(prefix.as_str()))
        {
            return false;
        }
        if let Some(max) = self.max_byte_length
            && byte_length > max
        {
            return false;
        }
        true
    }
}

/// Context handed to a sync [`BlobProcessor::validate`] call (TS
/// `FrickBlobValidateContext`, processor.ts:24-33).
pub struct BlobValidateContext<'a> {
    pub tenant_id: &'a str,
    pub blob_id: &'a str,
    pub owner_id: &'a str,
    pub mime_type: &'a str,
    pub byte_length: i64,
    /// First 4 KiB of the content for sniffing. May be shorter for tiny blobs.
    pub preview: &'a [u8],
    pub store: &'a FrickStore,
}

/// Context handed to an async [`BlobProcessor::process`] call (TS
/// `FrickBlobProcessContext`, processor.ts:35-49). Carries the full
/// (committed) blob metadata; the handler reads bytes via `store` if needed.
pub struct BlobProcessContext<'a> {
    pub tenant_id: &'a str,
    pub blob_id: &'a str,
    pub owner_id: &'a str,
    pub mime_type: &'a str,
    pub byte_length: i64,
    /// Logical content key for the stored blob (the `storage_key`, or the blob
    /// id when unset). Apps that swap in a filesystem backend resolve the
    /// on-disk path from this.
    pub content_path: &'a str,
    /// Unscoped store: the handler reads bytes / writes derivatives through it.
    pub store: &'a FrickStore,
}

/// Verdict from [`BlobProcessor::validate`] (TS `FrickBlobValidationResult`,
/// processor.ts:51-58).
#[derive(Debug, Clone)]
pub enum BlobValidation {
    /// The upload is accepted.
    Ok,
    /// The upload is rejected; `reason` is surfaced in the 415 envelope as
    /// `details.rejectionReason`.
    Reject { reason: String },
}

impl BlobValidation {
    /// Build a rejection with a reason string.
    #[must_use]
    pub fn reject(reason: impl Into<String>) -> Self {
        Self::Reject {
            reason: reason.into(),
        }
    }
}

/// A derivative produced by [`BlobProcessor::process`] (TS
/// `FrickBlobDerivative`, processor.ts:60-69).
#[derive(Debug, Clone)]
pub struct BlobDerivative {
    /// Local id within the parent blob (e.g. `"thumb-256"`). The pair
    /// `(parent_blob_id, derivative_id)` is the storage primary key.
    pub derivative_id: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
    /// Optional structured metadata, persisted as JSON on the derivative row.
    pub metadata: Option<serde_json::Value>,
}

/// Outcome of [`BlobProcessor::process`] (TS `FrickBlobProcessResult`,
/// processor.ts:71-73).
#[derive(Debug, Clone, Default)]
pub struct BlobProcessOutcome {
    pub derivatives: Vec<BlobDerivative>,
}

/// The future a [`BlobProcessor::process`] call returns — boxed + `Send` so the
/// `blob.process` job worker can dispatch from a `'static` polling task.
pub type ProcessFuture<'a> =
    Pin<Box<dyn Future<Output = Result<BlobProcessOutcome, BlobProcessError>> + Send + 'a>>;

/// Failure from [`BlobProcessor::process`]. Maps onto a retryable [`JobError`]
/// by default (processor exceptions are usually transient — network, decode
/// glitch — so they shouldn't burn the retry budget on the first attempt; TS
/// processor-job.ts catch arm). Use [`Self::fatal`] for a deterministic
/// rejection that should dead-letter immediately.
#[derive(Debug, Clone)]
pub struct BlobProcessError {
    pub message: String,
    pub retryable: bool,
}

impl BlobProcessError {
    /// A retryable failure (the default for a processor exception).
    #[must_use]
    pub fn retryable(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
        }
    }

    /// A non-retryable failure: the job dead-letters immediately.
    #[must_use]
    pub fn fatal(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
        }
    }
}

/// An app-provided blob processor (TS `FrickBlobProcessor`, processor.ts:75-87).
///
/// A processor supplies a sync [`validate`](Self::validate) hook, an async
/// [`process`](Self::process) hook, or both. The default implementations make
/// each optional: a validate-only processor leaves `process` as the no-op
/// default (it never enqueues a job), and vice-versa.
pub trait BlobProcessor: Send + Sync {
    /// Stable identifier (e.g. `"image-thumbnail"`). Logged with every
    /// derivative and used as the `processorId` on enqueued `blob.process` jobs.
    fn id(&self) -> &str;

    /// Match criteria deciding which uploads this processor inspects.
    fn matches(&self) -> ProcessorMatch {
        ProcessorMatch::default()
    }

    /// Whether this processor runs a sync validator. Used by the upload route
    /// to skip processors that have no validate phase.
    fn has_validate(&self) -> bool {
        false
    }

    /// Whether this processor runs an async `process` phase. Used by the upload
    /// route to decide whether to enqueue a `blob.process` job.
    fn has_process(&self) -> bool {
        false
    }

    /// Synchronous validation over the 4 KiB preview. Default accepts.
    fn validate(&self, ctx: &BlobValidateContext<'_>) -> BlobValidation {
        let _ = ctx;
        BlobValidation::Ok
    }

    /// Asynchronous post-upload processing. Default produces no derivatives.
    fn process<'a>(&'a self, ctx: BlobProcessContext<'a>) -> ProcessFuture<'a> {
        let _ = ctx;
        Box::pin(async { Ok(BlobProcessOutcome::default()) })
    }
}

/// A boxed, shareable processor.
pub type SharedBlobProcessor = Arc<dyn BlobProcessor>;

/// Raised by [`BlobProcessorRegistry::register`] when a processor id is
/// registered twice (TS `DuplicateBlobProcessorError`, processor.ts:90-97).
#[derive(Debug, Clone, thiserror::Error)]
#[error("A blob processor is already registered with id \"{processor_id}\"")]
pub struct DuplicateBlobProcessorError {
    pub processor_id: String,
}

impl DuplicateBlobProcessorError {
    /// Stable machine reason (TS `reason = "duplicateBlobProcessor"`).
    #[must_use]
    pub const fn reason(&self) -> &'static str {
        "duplicateBlobProcessor"
    }
}

/// The per-id blob-processor registry (TS `FrickBlobProcessorRegistry`,
/// processor.ts:89-127). Apps register one processor per id at boot; the upload
/// route resolves matching processors per upload, and the `blob.process` handler
/// resolves a processor by id when running a job.
///
/// Registration order is preserved (insertion order) so [`Self::matching`] and
/// [`Self::list`] return processors deterministically — matching the TS
/// `Map`-iteration order, which the upload route's enqueue loop relies on.
#[derive(Default)]
pub struct BlobProcessorRegistry {
    /// Insertion-ordered ids → processors. A plain `Vec` keeps order without a
    /// second index map; the id count is tiny (one per app feature).
    processors: Vec<SharedBlobProcessor>,
    /// Fast duplicate-id guard.
    ids: HashSet<String>,
}

impl BlobProcessorRegistry {
    /// An empty registry.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register `processor`. Returns [`DuplicateBlobProcessorError`] when a
    /// processor already exists for that id (TS `register` throws).
    pub fn register(
        &mut self,
        processor: SharedBlobProcessor,
    ) -> Result<(), DuplicateBlobProcessorError> {
        let id = processor.id().to_string();
        if self.ids.contains(&id) {
            return Err(DuplicateBlobProcessorError { processor_id: id });
        }
        self.ids.insert(id);
        self.processors.push(processor);
        Ok(())
    }

    /// Every registered processor, in registration order (TS `list()`).
    #[must_use]
    pub fn list(&self) -> &[SharedBlobProcessor] {
        &self.processors
    }

    /// Processors whose [`ProcessorMatch`] accepts `(mime_type, byte_length)`,
    /// in registration order (TS `matching`, processor.ts:118-127).
    #[must_use]
    pub fn matching(&self, mime_type: &str, byte_length: i64) -> Vec<SharedBlobProcessor> {
        self.processors
            .iter()
            .filter(|p| p.matches().accepts(mime_type, byte_length))
            .map(Arc::clone)
            .collect()
    }

    /// Resolve a registered processor by id, or `None`.
    #[must_use]
    pub fn resolve(&self, id: &str) -> Option<SharedBlobProcessor> {
        self.processors
            .iter()
            .find(|p| p.id() == id)
            .map(Arc::clone)
    }

    /// Registered processor ids, **sorted** (for the `/_frick/inspect` surface).
    #[must_use]
    pub fn ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.processors.iter().map(|p| p.id().to_string()).collect();
        ids.sort();
        ids
    }
}

// ── stock processors (validation-processor.ts) ──────────────────────────────

/// Options for [`mime_size_validator`] (TS `MimeSizeValidatorOptions`,
/// validation-processor.ts:31-58).
#[derive(Debug, Clone)]
pub struct MimeSizeValidatorOptions {
    /// Processor id. Defaults to `"frick-mime-size"`.
    pub id: String,
    /// Allowed MIME types. An entry ending in `/` matches by prefix
    /// (`"image/"` ⇒ `image/png`); any other entry matches exactly. Empty ⇒
    /// every MIME type is allowed (size-only gate).
    pub allowed_mime_types: Vec<String>,
    /// Hard upper bound on upload size in bytes. `None` ⇒ no size cap.
    pub max_bytes: Option<i64>,
    /// Reject zero-byte uploads. Defaults to `true`.
    pub reject_empty: bool,
    /// Match criteria deciding which uploads this validator inspects. Defaults
    /// to `{}` (every upload), so disallowed content is actively rejected.
    pub matches: ProcessorMatch,
}

impl Default for MimeSizeValidatorOptions {
    fn default() -> Self {
        Self {
            id: "frick-mime-size".to_string(),
            allowed_mime_types: Vec::new(),
            max_bytes: None,
            reject_empty: true,
            matches: ProcessorMatch::default(),
        }
    }
}

fn mime_allowed(mime_type: &str, allowed: &[String]) -> bool {
    if allowed.is_empty() {
        return true;
    }
    allowed.iter().any(|entry| {
        if entry.ends_with('/') {
            mime_type.starts_with(entry.as_str())
        } else {
            mime_type == entry
        }
    })
}

/// Build a [`BlobProcessor`] that gates uploads on a MIME allow-list and size,
/// rejecting disallowed uploads with a clear reason before any row is written
/// (TS `mimeSizeValidator`, validation-processor.ts:66-103).
#[must_use]
pub fn mime_size_validator(options: MimeSizeValidatorOptions) -> SharedBlobProcessor {
    Arc::new(MimeSizeValidator { options })
}

struct MimeSizeValidator {
    options: MimeSizeValidatorOptions,
}

impl BlobProcessor for MimeSizeValidator {
    fn id(&self) -> &str {
        &self.options.id
    }

    fn matches(&self) -> ProcessorMatch {
        self.options.matches.clone()
    }

    fn has_validate(&self) -> bool {
        true
    }

    fn validate(&self, ctx: &BlobValidateContext<'_>) -> BlobValidation {
        if self.options.reject_empty && ctx.byte_length == 0 {
            return BlobValidation::reject("Empty upload.");
        }
        if let Some(max) = self.options.max_bytes
            && ctx.byte_length > max
        {
            return BlobValidation::reject(format!(
                "Upload is {} bytes; the limit is {max}.",
                ctx.byte_length
            ));
        }
        if !mime_allowed(ctx.mime_type, &self.options.allowed_mime_types) {
            return BlobValidation::reject(format!(
                "MIME type \"{}\" is not allowed.",
                ctx.mime_type
            ));
        }
        BlobValidation::Ok
    }
}

/// Coarse classification a [`ModerationHook`] returns (TS
/// `BlobModerationVerdict.decision`, validation-processor.ts:105-114).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModerationDecision {
    Allow,
    Flag,
    Reject,
}

impl ModerationDecision {
    /// The lowercase wire string persisted on the sidecar derivative.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Flag => "flag",
            Self::Reject => "reject",
        }
    }
}

/// Verdict a [`ModerationHook`] returns (TS `BlobModerationVerdict`).
#[derive(Debug, Clone)]
pub struct ModerationVerdict {
    pub decision: ModerationDecision,
    /// Optional rationale, persisted on the sidecar derivative metadata.
    pub reason: Option<String>,
    /// Optional structured detail (vendor scores, label spans, etc.).
    pub details: Option<serde_json::Value>,
}

/// Context handed to a [`ModerationHook`] (TS `BlobModerationContext`).
pub struct ModerationContext<'a> {
    pub tenant_id: &'a str,
    pub blob_id: &'a str,
    pub owner_id: &'a str,
    pub mime_type: &'a str,
    pub byte_length: i64,
    /// Full stored bytes of the blob, or `None` if content is missing.
    pub content: Option<&'a [u8]>,
}

/// The future a [`ModerationHook`] returns.
pub type ModerationFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ModerationVerdict, BlobProcessError>> + Send + 'a>>;

/// App-supplied moderation decision function (TS `BlobModerationHook`,
/// validation-processor.ts:130-132). Frick ships the hook *mechanism*, not an
/// implementation — apps plug in a vendor API, an ML model, or a manual review
/// queue. Returning `Err` makes the `blob.process` job retry.
pub trait ModerationHook: Send + Sync {
    /// Decide a verdict for the blob.
    fn decide<'a>(&'a self, ctx: ModerationContext<'a>) -> ModerationFuture<'a>;
}

/// Options for [`moderation_processor`] (TS `ModerationProcessorOptions`,
/// validation-processor.ts:147-159).
pub struct ModerationProcessorOptions {
    /// Processor id. Defaults to `"frick-moderation"`.
    pub id: String,
    /// The app's moderation decision function.
    pub hook: Arc<dyn ModerationHook>,
    /// Derivative id under which the verdict sidecar is persisted. Defaults to
    /// `"moderation"`.
    pub derivative_id: String,
    /// Match criteria. Defaults to `{}` (moderate every upload).
    pub matches: ProcessorMatch,
}

impl ModerationProcessorOptions {
    /// Options wrapping `hook` with the documented defaults.
    #[must_use]
    pub fn new(hook: Arc<dyn ModerationHook>) -> Self {
        Self {
            id: "frick-moderation".to_string(),
            hook,
            derivative_id: "moderation".to_string(),
            matches: ProcessorMatch::default(),
        }
    }
}

/// Build a [`BlobProcessor`] that runs an app moderation hook in the async
/// `process` phase and persists the verdict as a JSON sidecar derivative (TS
/// `moderationProcessor`, validation-processor.ts:166-205). The framework ships
/// the wiring; the app owns the policy.
#[must_use]
pub fn moderation_processor(options: ModerationProcessorOptions) -> SharedBlobProcessor {
    Arc::new(ModerationProcessor { options })
}

struct ModerationProcessor {
    options: ModerationProcessorOptions,
}

impl BlobProcessor for ModerationProcessor {
    fn id(&self) -> &str {
        &self.options.id
    }

    fn matches(&self) -> ProcessorMatch {
        self.options.matches.clone()
    }

    fn has_process(&self) -> bool {
        true
    }

    fn process<'a>(&'a self, ctx: BlobProcessContext<'a>) -> ProcessFuture<'a> {
        Box::pin(async move {
            let raw = ctx
                .store
                .read_content(ctx.tenant_id, ctx.blob_id, default_app_id())
                .await
                .map_err(|error| BlobProcessError::retryable(error.to_string()))?;
            let verdict = self
                .options
                .hook
                .decide(ModerationContext {
                    tenant_id: ctx.tenant_id,
                    blob_id: ctx.blob_id,
                    owner_id: ctx.owner_id,
                    mime_type: ctx.mime_type,
                    byte_length: ctx.byte_length,
                    content: raw.as_deref(),
                })
                .await?;
            tracing::info!(
                target: "frick.blob.moderated",
                blob_id = ctx.blob_id,
                processor_id = self.options.id.as_str(),
                decision = verdict.decision.as_str(),
                "blob moderated",
            );
            let sidecar = moderation_sidecar(&verdict);
            let bytes = serde_json::to_vec(&sidecar).unwrap_or_default();
            let mut metadata = serde_json::Map::new();
            metadata.insert(
                "decision".to_string(),
                serde_json::Value::from(verdict.decision.as_str()),
            );
            if let Some(reason) = &verdict.reason {
                metadata.insert(
                    "reason".to_string(),
                    serde_json::Value::from(reason.as_str()),
                );
            }
            Ok(BlobProcessOutcome {
                derivatives: vec![BlobDerivative {
                    derivative_id: self.options.derivative_id.clone(),
                    mime_type: "application/json".to_string(),
                    bytes,
                    metadata: Some(serde_json::Value::Object(metadata)),
                }],
            })
        })
    }
}

/// The JSON body persisted as the moderation sidecar derivative's bytes (TS
/// `JSON.stringify(verdict)`).
fn moderation_sidecar(verdict: &ModerationVerdict) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    map.insert(
        "decision".to_string(),
        serde_json::Value::from(verdict.decision.as_str()),
    );
    if let Some(reason) = &verdict.reason {
        map.insert(
            "reason".to_string(),
            serde_json::Value::from(reason.as_str()),
        );
    }
    if let Some(details) = &verdict.details {
        map.insert("details".to_string(), details.clone());
    }
    serde_json::Value::Object(map)
}

/// The default single-app partition id (`_default`) — blob bytes / metadata in
/// the `blob.process` path are read under it (the `blob_derivatives` table has
/// no `app_id` axis; the job's `app_id` gates nothing on the read here).
fn default_app_id() -> &'static str {
    frick_store::DEFAULT_APP_ID
}

// ── the blob.process job (processor-job.ts) ──────────────────────────────────

/// The decoded `blob.process` payload `{ blobId, processorId }`
/// (TS `BlobProcessJobPayload`, processor-job.ts:34-37).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobProcessPayload {
    pub blob_id: String,
    pub processor_id: String,
}

/// Encode a `blob.process` job payload (TS `encodeBlobProcessPayload`,
/// processor-job.ts:46-50). Centralised so the upload route and the handler
/// agree on the wire shape — change in lockstep.
#[must_use]
pub fn encode_blob_process_payload(payload: &BlobProcessPayload) -> Value {
    Value::Map(vec![
        (Value::from("blobId"), Value::from(payload.blob_id.as_str())),
        (
            Value::from("processorId"),
            Value::from(payload.processor_id.as_str()),
        ),
    ])
}

/// Decode a `blob.process` payload (TS `decodePayload`, processor-job.ts:52-65).
/// Returns a human-readable error string on rejection (→ a non-retryable
/// `blob.invalidPayload` failure).
pub fn decode_blob_process_payload(payload: &Value) -> Result<BlobProcessPayload, String> {
    let Value::Map(entries) = payload else {
        return Err("blob.process payload must be an object".to_string());
    };
    let get = |key: &str| -> Option<&Value> {
        entries
            .iter()
            .find(|(k, _)| k.as_str() == Some(key))
            .map(|(_, v)| v)
    };
    let blob_id = get("blobId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("blob.process payload.blobId must be a non-empty string")?
        .to_string();
    let processor_id = get("processorId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("blob.process payload.processorId must be a non-empty string")?
        .to_string();
    Ok(BlobProcessPayload {
        blob_id,
        processor_id,
    })
}

/// The `blob.process` [`JobHandler`] (TS `createBlobProcessorJobHandler`,
/// processor-job.ts:106-205). Decodes the payload, resolves the processor + the
/// parent blob, runs `process(...)`, and persists each returned derivative.
///
/// Holds an `Arc` to the shared [`BlobProcessorRegistry`] so a job claimed by
/// the worker resolves the same processors the upload route enqueued against.
pub struct BlobProcessHandler {
    processors: Arc<BlobProcessorRegistry>,
}

impl BlobProcessHandler {
    /// Build a handler over the shared processor registry.
    #[must_use]
    pub fn new(processors: Arc<BlobProcessorRegistry>) -> Self {
        Self { processors }
    }

    /// The boxed `blob.process` job handler. Register it on the
    /// [`JobHandlerRegistry`](crate::jobs::JobHandlerRegistry) under
    /// [`BLOB_PROCESS_JOB_TYPE`].
    #[must_use]
    pub fn into_job_handler(self) -> Arc<dyn JobHandler> {
        Arc::new(self)
    }

    /// Run one `blob.process` job body (TS handler arm). Exposed for direct,
    /// timer-free testing. `tenant_id` is the job's tenant; `store` is the
    /// unscoped store the derivatives are persisted through.
    pub async fn run_job(
        &self,
        tenant_id: &str,
        payload: &Value,
        store: &FrickStore,
    ) -> Result<Value, JobError> {
        let decoded = match decode_blob_process_payload(payload) {
            Ok(decoded) => decoded,
            Err(message) => return Err(JobError::fatal("blob.invalidPayload", message)),
        };
        let BlobProcessPayload {
            blob_id,
            processor_id,
        } = decoded;

        // Resolve the processor. A missing processor can only happen if the
        // registry drifts between enqueue and run — non-retryable.
        let Some(processor) = self.processors.resolve(&processor_id) else {
            return Err(JobError::fatal(
                "blob.unknownProcessor",
                format!("No blob processor registered with id \"{processor_id}\""),
            ));
        };
        // A validate-only processor should never have enqueued a job; a registry
        // change between enqueue and run could leave a stale one. Complete with
        // zero derivatives (TS `{ status: "completed", result: { derivatives: 0 } }`).
        if !processor.has_process() {
            return Ok(job_result(0));
        }

        // Resolve the parent blob. A missing parent is non-retryable.
        let metadata = match store
            .blobs()
            .read(tenant_id, &blob_id, default_app_id())
            .await
        {
            Ok(Some(metadata)) => metadata,
            Ok(None) => {
                return Err(JobError::fatal(
                    "blob.notFound",
                    format!("Blob {blob_id} not found in tenant {tenant_id}"),
                ));
            }
            Err(error) => {
                // A store read failure is transient → retryable.
                return Err(JobError::retryable(
                    "blob.processorError",
                    error.to_string(),
                ));
            }
        };

        let content_path = metadata
            .storage_key
            .clone()
            .unwrap_or_else(|| metadata.blob_id.clone());
        let outcome = processor
            .process(BlobProcessContext {
                tenant_id,
                blob_id: &blob_id,
                owner_id: &metadata.owner_id,
                mime_type: &metadata.mime_type,
                byte_length: metadata.byte_length,
                content_path: &content_path,
                store,
            })
            .await;
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => {
                let code = "blob.processorError";
                return Err(if error.retryable {
                    JobError::retryable(code, error.message)
                } else {
                    JobError::fatal(code, error.message)
                });
            }
        };

        let derivative_count = outcome.derivatives.len();
        persist_derivatives(
            store,
            tenant_id,
            &blob_id,
            &processor_id,
            outcome.derivatives,
        )
        .await?;

        tracing::info!(
            target: "frick.blob.processed",
            blob_id = blob_id.as_str(),
            processor_id = processor_id.as_str(),
            derivatives = derivative_count,
            "blob processed",
        );
        Ok(job_result(derivative_count))
    }
}

/// Persist each derivative a processor returned (TS `persistDerivative` loop,
/// processor-job.ts:74-100). A metadata-encode failure is fatal (a bug in the
/// processor's metadata); a store-write failure is retryable so a restart
/// re-runs the job rather than dropping the derivative.
async fn persist_derivatives(
    store: &FrickStore,
    tenant_id: &str,
    blob_id: &str,
    processor_id: &str,
    derivatives: Vec<BlobDerivative>,
) -> Result<(), JobError> {
    for derivative in derivatives {
        let metadata_json = match derivative.metadata {
            Some(metadata) => match serde_json::to_string(&metadata) {
                Ok(json) => Some(json),
                Err(error) => {
                    return Err(JobError::fatal("blob.processorError", error.to_string()));
                }
            },
            None => None,
        };
        store
            .record_derivative(&DerivativeRecordInput {
                parent_blob_id: blob_id.to_string(),
                derivative_id: derivative.derivative_id,
                tenant_id: tenant_id.to_string(),
                processor_id: processor_id.to_string(),
                mime_type: derivative.mime_type,
                content: derivative.bytes,
                metadata_json,
                storage_key: None,
            })
            .await
            .map_err(|error| JobError::retryable("blob.processorError", error.to_string()))?;
    }
    Ok(())
}

impl JobHandler for BlobProcessHandler {
    fn handle<'a>(&'a self, ctx: JobContext<'a>) -> JobHandlerFuture<'a> {
        Box::pin(async move {
            let store = ctx.raw_store();
            self.run_job(&ctx.tenant_id, &ctx.payload, store).await
        })
    }
}

/// The completed-job result `{ derivatives: <n> }` (TS handler completed arm).
fn job_result(derivative_count: usize) -> Value {
    Value::Map(vec![(
        Value::from("derivatives"),
        Value::from(i64::try_from(derivative_count).unwrap_or(i64::MAX)),
    )])
}

#[cfg(test)]
mod tests;
