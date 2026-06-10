//! The Frick sync server runtime (FR-243+). Embeddable as a library, and also
//! shipped as a thin standalone `frick-server` binary (`src/main.rs`) whose
//! testable boot helpers live in [`standalone`].
//!
//! Ported from `apps/server/src`. Spec:
//! `internal/rust-rewrite/maps/02-server-architecture.md`.

pub mod auth_routes;
pub mod authz;
pub mod boot;
pub mod cluster;
pub mod config;
pub mod cors;
pub mod error;
pub mod extract;
pub mod gateway;
pub mod http;
pub mod jobs;
pub mod principal;
pub mod projections;
pub mod push;
pub mod routes;
pub mod session;
pub mod standalone;

pub use authz::{Action, Decision, DenyReason, ResourceContext, decide_baseline};
pub use boot::{BootError, FrickServer, create_frick_server};
pub use cluster::{
    ClusterEnvelope, ClusterEnvelopeHandler, FrickClusterBus, MemoryClusterBus,
    MemoryClusterBusOptions, MemoryClusterChannel, NodeId, Unsubscribe, random_node_id,
};
pub use config::{FrickConfig, FrickConfigError, FrickLimits, load_frick_config};
pub use error::{LimitKind, ServerError};
pub use gateway::GatewayHub;
pub use http::{AppState, AppStateInner, respond_error};
pub use principal::{DEFAULT_APP_ID, DEFAULT_TENANT_ID, Principal, PrincipalScope};
pub use push::{
    FrickNotificationIntent, FrickPushPayload, NotificationRouter, PUSH_DELIVER_JOB_TYPE,
    PushAdapter, PushRegistry,
};
pub use standalone::{SCHEMA_PATH_ENV, config_env, load_schema};
