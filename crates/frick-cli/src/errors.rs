//! CLI exit codes and the error model (ported from `apps/cli/src/errors.ts`).
//!
//! Exit codes:
//!  - `0` success
//!  - `1` a check failed (doctor red, db unreachable, schema invalid, …)
//!  - `2` argument / usage error (unknown command, missing required arg, bad flag)
//!  - `3` framework refused (e.g. `reset` outside development, prod `migrate up`
//!    without `--confirm-prod`).

use serde_json::{Map, Value};

/// Success.
pub const EXIT_OK: i32 = 0;
/// A check failed.
pub const EXIT_FAILURE: i32 = 1;
/// Argument / usage error.
pub const EXIT_USAGE: i32 = 2;
/// Framework refused.
pub const EXIT_REFUSED: i32 = 3;

/// A structured CLI error. Carries the wire `code`, `message`, optional
/// `details`, and the process exit code (`toErrorShape` in TS).
#[derive(Debug, Clone)]
pub struct CliError {
    /// Stable machine code (`cli.usage`, `cli.refused`, `schema.invalid`, …).
    pub code: String,
    /// Human-readable message.
    pub message: String,
    /// Optional structured details object.
    pub details: Option<Value>,
    /// Process exit code this error maps to.
    pub exit_code: i32,
}

impl CliError {
    /// `CliUsageError` — code `cli.usage`, exit 2.
    #[must_use]
    pub fn usage(message: impl Into<String>) -> Self {
        Self {
            code: "cli.usage".to_string(),
            message: message.into(),
            details: None,
            exit_code: EXIT_USAGE,
        }
    }

    /// `CliUsageError` with a `details` object.
    #[must_use]
    pub fn usage_with(message: impl Into<String>, details: Value) -> Self {
        Self {
            details: Some(details),
            ..Self::usage(message)
        }
    }

    /// `CliRefusedError` — code `cli.refused`, exit 3.
    #[must_use]
    pub fn refused(message: impl Into<String>) -> Self {
        Self {
            code: "cli.refused".to_string(),
            message: message.into(),
            details: None,
            exit_code: EXIT_REFUSED,
        }
    }

    /// `CliRefusedError` with a `details` object.
    #[must_use]
    pub fn refused_with(message: impl Into<String>, details: Value) -> Self {
        Self {
            details: Some(details),
            ..Self::refused(message)
        }
    }

    /// `CliFailureError` — an arbitrary code, exit 1.
    #[must_use]
    pub fn failure(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
            exit_code: EXIT_FAILURE,
        }
    }

    /// `CliFailureError` with a `details` object.
    #[must_use]
    pub fn failure_with(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Value,
    ) -> Self {
        Self {
            details: Some(details),
            ..Self::failure(code, message)
        }
    }

    /// Render the `{ error: { code, message, details? } }` body.
    #[must_use]
    pub fn to_body(&self) -> Value {
        let mut error = Map::new();
        error.insert("code".to_string(), Value::String(self.code.clone()));
        error.insert("message".to_string(), Value::String(self.message.clone()));
        if let Some(details) = &self.details {
            error.insert("details".to_string(), details.clone());
        }
        let mut body = Map::new();
        body.insert("error".to_string(), Value::Object(error));
        Value::Object(body)
    }
}

/// Helper: build a JSON object value from key/value pairs.
#[must_use]
pub fn details(pairs: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in pairs {
        map.insert(key.to_string(), value);
    }
    Value::Object(map)
}
