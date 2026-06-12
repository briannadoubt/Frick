//! The Frick sync server runtime (FR-243+). Embeddable as a library, and also
//! shipped as a thin standalone `frick-server` binary (`src/main.rs`) whose
//! testable boot helpers live in [`standalone`].
//!
//! Ported from `apps/server/src`. Spec:
//! `internal/rust-rewrite/maps/02-server-architecture.md`.

pub mod apps;
pub mod auth;
pub mod auth_routes;
pub mod authz;
pub mod blob_processors;
pub mod boot;
pub mod calls;
pub mod cluster;
pub mod config;
pub mod cors;
pub mod diagnostics;
pub mod email;
pub mod error;
pub mod extract;
pub mod gateway;
pub mod http;
pub mod jobs;
pub mod object_visibility;
pub mod principal;
pub mod projections;
pub mod push;
pub mod routes;
pub mod search;
pub mod session;
pub mod standalone;
pub mod telemetry;

pub use apps::{AppDefinition, AppDescriptor, AppEntry, AppResolution, FrickAppRegistry};
pub use auth::{
    FixedJwksProvider, Jwks, JwksProvider, ReqwestJwksProvider, RsaJwk, SharedJwksProvider,
    VerifiedIdentity, VerifyError, VerifyParams, provider_auth_router, verify_id_token,
};
pub use authz::{Action, Decision, DenyReason, ResourceContext, decide_baseline};
pub use blob_processors::{
    BLOB_PROCESS_JOB_TYPE, BlobDerivative, BlobProcessContext, BlobProcessError,
    BlobProcessHandler, BlobProcessOutcome, BlobProcessPayload, BlobProcessor,
    BlobProcessorRegistry, BlobValidateContext, BlobValidation, DuplicateBlobProcessorError,
    MimeSizeValidatorOptions, ModerationContext, ModerationDecision, ModerationHook,
    ModerationProcessorOptions, ModerationVerdict, ProcessorMatch, SharedBlobProcessor,
    encode_blob_process_payload, mime_size_validator, moderation_processor,
};
pub use boot::{
    AppRouterBuilder, BootError, BootSeams, FrickServer, create_frick_server,
    create_frick_server_with_apps, create_frick_server_with_seams,
};
pub use cluster::{
    ClusterEnvelope, ClusterEnvelopeHandler, FrickClusterBus, MemoryClusterBus,
    MemoryClusterBusOptions, MemoryClusterChannel, NodeId, Unsubscribe, random_node_id,
};
pub use config::{
    EmailProvider, FrickConfig, FrickConfigError, FrickLimits, OtelConfig, load_frick_config,
};
pub use diagnostics::{
    AssembleDiagnosticsOptions, DIAGNOSTICS_VERSION, DiagnosticsCursorProbe,
    assemble_diagnostics_snapshot,
};
pub use email::{
    EmailError, EmailKind, EmailMessage, EmailRouter, FrickEmailAdapter, NoopEmailAdapter,
    RecordingEmailAdapter, ResendEmailAdapter,
};
pub use error::{LimitKind, ServerError};
pub use gateway::{CloseTarget, GatewayHub};
pub use http::{AppState, AppStateInner, respond_error};
pub use principal::{DEFAULT_APP_ID, DEFAULT_TENANT_ID, Principal, PrincipalScope};
pub use push::{
    FrickNotificationIntent, FrickPushPayload, NotificationRouter, PUSH_DELIVER_JOB_TYPE,
    PushAdapter, PushRegistry, PushSubsystem, PushTransports, ReqwestApnsTransport,
    ReqwestFcmTransport, ReqwestWebPushTransport, build_push_subsystem,
};
pub use search::{
    DEFAULT_SEARCH_LIMIT, FrickSearchIndexDefinition, MAX_SEARCH_LIMIT, SearchDoc, SearchRegistry,
    SearchSource,
};
pub use standalone::{SCHEMA_PATH_ENV, config_env, load_schema};
pub use telemetry::{TelemetryGuard, install_tracing};
