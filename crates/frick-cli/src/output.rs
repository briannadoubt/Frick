//! JSON-first output helpers (ported from `apps/cli/src/output.ts`).
//!
//! Default output is JSON Lines (one compact JSON object per record) on
//! stdout. `--pretty` / `--json=pretty` switches to 2-space-indented JSON.
//! Errors always go to stderr as a single `{ "error": { … } }` object.

use std::io::Write;

use serde_json::Value;

use crate::argv::ParsedArgs;
use crate::errors::CliError;

/// Output mode (`OutputMode` in TS).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputMode {
    /// Compact JSON Lines (default).
    Json,
    /// 2-space-indented JSON.
    Pretty,
}

/// Output sinks + the resolved mode. Streams are `&mut dyn Write` so tests can
/// capture into buffers and the binary passes stdout/stderr.
pub struct Output<'a> {
    /// Resolved output mode.
    pub mode: OutputMode,
    /// Stdout sink (records).
    pub stdout: &'a mut dyn Write,
    /// Stderr sink (errors).
    pub stderr: &'a mut dyn Write,
}

/// `resolveOutputMode` — `--pretty` (boolean true) or `--json=pretty` ⇒ pretty.
#[must_use]
pub fn resolve_output_mode(parsed: &ParsedArgs) -> OutputMode {
    if parsed.flag_bool_present("pretty") {
        return OutputMode::Pretty;
    }
    if parsed.flag_str("json") == Some("pretty") {
        return OutputMode::Pretty;
    }
    OutputMode::Json
}

impl Output<'_> {
    /// Emit one record to stdout, newline-terminated.
    pub fn emit(&mut self, record: &Value) {
        let payload = match self.mode {
            OutputMode::Pretty => serde_json::to_string_pretty(record),
            OutputMode::Json => serde_json::to_string(record),
        }
        .unwrap_or_else(|_| "null".to_string());
        let _ = writeln!(self.stdout, "{payload}");
    }

    /// Emit a structured error to stderr (`{ "error": { … } }`).
    pub fn emit_error(&mut self, error: &CliError) {
        let body = error.to_body();
        let payload = match self.mode {
            OutputMode::Pretty => serde_json::to_string_pretty(&body),
            OutputMode::Json => serde_json::to_string(&body),
        }
        .unwrap_or_else(|_| "null".to_string());
        let _ = writeln!(self.stderr, "{payload}");
    }
}
