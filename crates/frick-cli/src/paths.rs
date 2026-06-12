//! Repo-relative path resolution for the dev/deploy plan commands.
//!
//! The TS resolves ops paths relative to the compiled module's `dist`
//! directory (`../../../..` ⇒ repo root). The Rust CLI resolves them relative
//! to the workspace root: `CARGO_MANIFEST_DIR` is `crates/frick-cli`, so its
//! grandparent is the repo root. This keeps the emitted plan paths stable
//! across `cargo test` (in-crate cwd) and the installed binary.

use std::path::{Path, PathBuf};

/// The workspace/repo root (`crates/frick-cli/../..`).
#[must_use]
pub fn repo_root() -> PathBuf {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .and_then(Path::parent)
        .map_or_else(|| manifest_dir.to_path_buf(), Path::to_path_buf)
}

/// Resolve `relative` against the repo root, returned as a string.
#[must_use]
pub fn resolve_repo_path(relative: &str) -> String {
    repo_root().join(relative).to_string_lossy().into_owned()
}

/// Resolve `relative` against the current working directory (TS
/// `resolveInputPath` = `resolve(process.cwd(), path)`).
#[must_use]
pub fn resolve_input_path(relative: &str) -> String {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    cwd.join(relative).to_string_lossy().into_owned()
}

/// Strip the repo-root prefix from an absolute path (TS `relativeRepoPath`):
/// returns `.` when the path *is* the repo root.
#[must_use]
pub fn relative_repo_path(path: &str) -> String {
    let root = repo_root();
    let root_str = root.to_string_lossy();
    if let Some(rest) = path.strip_prefix(root_str.as_ref()) {
        let trimmed = rest.trim_start_matches('/');
        if trimmed.is_empty() {
            ".".to_string()
        } else {
            trimmed.to_string()
        }
    } else {
        path.to_string()
    }
}
