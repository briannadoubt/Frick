//! Command handlers for the `frick` CLI. Each returns `Result<i32, CliError>`
//! where the `i32` is the success-path exit code; the top-level `run()` maps
//! both arms onto a process exit code.

pub mod backup;
pub mod dashboard;
pub mod deploy;
pub mod dev;
pub mod doctor;
pub mod init;
pub mod inspect;
pub mod lint;
pub mod mcp;
pub mod migrate;
pub mod reset;
pub mod restore;
pub mod scaffold;
pub mod schema;
pub mod tenants;
pub mod verify;
