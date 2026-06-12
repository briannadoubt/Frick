//! Hand-rolled argv parser (ported from `apps/cli/src/argv.ts`).
//!
//! Grammar:
//!   - `--flag` → `true`
//!   - `--flag=value` → `"value"`
//!   - `--flag value` → `"value"` only if `value` doesn't start with `--`
//!   - anything not starting with `--` is a positional.
//!
//! No flag schema, no single-dash short flags. `requireBoolean` treats the
//! string values `"false"`, `"0"`, `"no"` as false; any other string truthy.

use std::collections::BTreeMap;

/// A parsed flag value (`string | boolean` in TS).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FlagValue {
    /// A bare `--flag` with no value.
    Bool(bool),
    /// A `--flag value` / `--flag=value` string.
    Str(String),
}

/// Parsed argv: positionals + flags.
#[derive(Debug, Clone, Default)]
pub struct ParsedArgs {
    /// Positional arguments, in order.
    pub positionals: Vec<String>,
    /// Flags by name, in insertion order is irrelevant — last wins like TS.
    pub flags: BTreeMap<String, FlagValue>,
}

/// Parse argv per the grammar above.
#[must_use]
pub fn parse_args(args: &[String]) -> ParsedArgs {
    let mut positionals = Vec::new();
    let mut flags = BTreeMap::new();
    let mut i = 0;
    while i < args.len() {
        let token = &args[i];
        if !token.starts_with("--") {
            positionals.push(token.clone());
            i += 1;
            continue;
        }
        let body = &token[2..];
        if let Some(eq) = body.find('=') {
            let key = body[..eq].to_string();
            let value = body[eq + 1..].to_string();
            flags.insert(key, FlagValue::Str(value));
            i += 1;
            continue;
        }
        let next = args.get(i + 1);
        if let Some(next) = next
            && !next.starts_with("--")
        {
            flags.insert(body.to_string(), FlagValue::Str(next.clone()));
            i += 2;
        } else {
            flags.insert(body.to_string(), FlagValue::Bool(true));
            i += 1;
        }
    }
    ParsedArgs { positionals, flags }
}

impl ParsedArgs {
    /// `requireString` — the string value of a flag, or `None` if absent or a
    /// bare boolean.
    #[must_use]
    pub fn flag_str(&self, key: &str) -> Option<&str> {
        match self.flags.get(key) {
            Some(FlagValue::Str(value)) => Some(value),
            _ => None,
        }
    }

    /// True iff the flag was passed as a bare `--flag` (boolean `true`). This
    /// mirrors the many TS sites that test `flags.x === true`.
    #[must_use]
    pub fn flag_bool_present(&self, key: &str) -> bool {
        matches!(self.flags.get(key), Some(FlagValue::Bool(true)))
    }

    /// True iff the flag is present at all (boolean or string).
    #[must_use]
    pub fn flag_present(&self, key: &str) -> bool {
        self.flags.contains_key(key)
    }

    /// `requireBoolean` — `true` for a bare `--flag`; for a string value,
    /// truthy unless it is `"false"`, `"0"`, or `"no"`; absent ⇒ false.
    #[must_use]
    pub fn flag_truthy(&self, key: &str) -> bool {
        match self.flags.get(key) {
            Some(FlagValue::Bool(value)) => *value,
            Some(FlagValue::Str(value)) => value != "false" && value != "0" && value != "no",
            None => false,
        }
    }

    /// Positional at `index`, if present.
    #[must_use]
    pub fn positional(&self, index: usize) -> Option<&str> {
        self.positionals.get(index).map(String::as_str)
    }
}
