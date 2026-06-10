//! The Frick sync server runtime (FR-243+). Embeddable as a library; the
//! standalone binary entry point lives in `frick-cli`.
//!
//! Ported from `apps/server/src`. Spec:
//! `internal/rust-rewrite/maps/02-server-architecture.md`.

pub mod authz;
pub mod boot;
pub mod config;
pub mod error;
pub mod http;
pub mod principal;

pub use authz::{Action, Decision, DenyReason, ResourceContext, decide_baseline};
pub use boot::{BootError, FrickServer, create_frick_server};
pub use config::{FrickConfig, FrickConfigError, FrickLimits, load_frick_config};
pub use error::{LimitKind, ServerError};
pub use http::{AppState, AppStateInner, respond_error};
pub use principal::{DEFAULT_APP_ID, DEFAULT_TENANT_ID, Principal, PrincipalScope};
