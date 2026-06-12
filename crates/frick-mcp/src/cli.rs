//! `frick-mcp` standalone CLI argument parsing.
//!
//! Ports `packages/mcp/src/cli.ts`. Accepts exactly `--endpoint`, `--token`,
//! `--tenant`, `--user`, `--allow-writes`, `--readonly`, `--print-config`.
//! Unknown args raise [`CliError`] (mapped to a `mcp.usage` stderr envelope +
//! exit 2 by `main`). `--readonly` always wins over `--allow-writes`
//! (`allowWrites = --allow-writes && !--readonly`).

use crate::config::FrickMcpOptions;

/// The parsed argv.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ParsedArgs {
    pub endpoint: Option<String>,
    pub token: Option<String>,
    pub tenant_id: Option<String>,
    pub user_id: Option<String>,
    /// `--allow-writes` was seen.
    pub allow_writes_flag: bool,
    /// `--readonly` was seen.
    pub readonly_flag: bool,
    /// `--print-config` was seen.
    pub print_config: bool,
}

/// A usage error: the message is surfaced under `mcp.usage`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct CliError(pub String);

impl ParsedArgs {
    /// `allowWrites = --allow-writes && !--readonly` (`mcp.ts:41`,
    /// `cli.ts:37-40`). In the TS the last-seen of the two flags wins because
    /// it assigns `allowWrites` on each; in the CLI command it is the boolean
    /// AND. Both reduce to: writes allowed only when `--allow-writes` is
    /// present and `--readonly` is not.
    #[must_use]
    pub fn allow_writes(&self) -> bool {
        self.allow_writes_flag && !self.readonly_flag
    }

    /// Convert to [`FrickMcpOptions`] (`toOptions`, `cli.ts:50-58`). Empty
    /// strings are dropped to mirror the TS truthiness guards.
    #[must_use]
    pub fn to_options(&self) -> FrickMcpOptions {
        FrickMcpOptions {
            endpoint: non_empty(self.endpoint.as_deref()),
            token: non_empty(self.token.as_deref()),
            tenant_id: non_empty(self.tenant_id.as_deref()),
            user_id: non_empty(self.user_id.as_deref()),
            allow_writes: self.allow_writes(),
        }
    }
}

/// Parse the args after the program name (`parse`, `cli.ts:20-48`).
pub fn parse(argv: &[String]) -> Result<ParsedArgs, CliError> {
    let mut parsed = ParsedArgs::default();
    let mut i = 0;
    while i < argv.len() {
        let arg = argv[i].as_str();
        match arg {
            "--endpoint" => {
                parsed.endpoint = Some(read_value(argv, i, arg)?);
                i += 1;
            }
            "--token" => {
                parsed.token = Some(read_value(argv, i, arg)?);
                i += 1;
            }
            "--tenant" => {
                parsed.tenant_id = Some(read_value(argv, i, arg)?);
                i += 1;
            }
            "--user" => {
                parsed.user_id = Some(read_value(argv, i, arg)?);
                i += 1;
            }
            "--allow-writes" => parsed.allow_writes_flag = true,
            "--readonly" => parsed.readonly_flag = true,
            "--print-config" => parsed.print_config = true,
            other => return Err(CliError(format!("Unknown argument: {other}"))),
        }
        i += 1;
    }
    Ok(parsed)
}

/// `readValue` (`cli.ts:14-18`): the next token, rejecting a missing value or
/// one that looks like another flag.
fn read_value(argv: &[String], index: usize, flag: &str) -> Result<String, CliError> {
    match argv.get(index + 1) {
        Some(value) if !value.starts_with("--") && !value.is_empty() => Ok(value.clone()),
        _ => Err(CliError(format!("{flag} requires a value"))),
    }
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value.filter(|v| !v.is_empty()).map(ToString::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn parses_all_flags() {
        let parsed = parse(&args(&[
            "--endpoint",
            "http://h:1",
            "--token",
            "t",
            "--tenant",
            "tn",
            "--user",
            "u",
            "--allow-writes",
            "--print-config",
        ]))
        .unwrap();
        assert_eq!(parsed.endpoint.as_deref(), Some("http://h:1"));
        assert_eq!(parsed.token.as_deref(), Some("t"));
        assert_eq!(parsed.tenant_id.as_deref(), Some("tn"));
        assert_eq!(parsed.user_id.as_deref(), Some("u"));
        assert!(parsed.print_config);
        assert!(parsed.allow_writes());
    }

    #[test]
    fn readonly_wins_over_allow_writes() {
        let parsed = parse(&args(&["--allow-writes", "--readonly"])).unwrap();
        assert!(!parsed.allow_writes());
        let parsed = parse(&args(&["--readonly", "--allow-writes"])).unwrap();
        assert!(!parsed.allow_writes());
    }

    #[test]
    fn unknown_arg_is_usage_error() {
        let err = parse(&args(&["--nope"])).unwrap_err();
        assert_eq!(err.0, "Unknown argument: --nope");
    }

    #[test]
    fn missing_value_is_usage_error() {
        let err = parse(&args(&["--endpoint"])).unwrap_err();
        assert_eq!(err.0, "--endpoint requires a value");
        let err = parse(&args(&["--endpoint", "--token"])).unwrap_err();
        assert_eq!(err.0, "--endpoint requires a value");
    }

    #[test]
    fn empty_argv_is_readonly_no_print() {
        let parsed = parse(&[]).unwrap();
        assert!(!parsed.allow_writes());
        assert!(!parsed.print_config);
    }
}
