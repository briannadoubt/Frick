//! Pure, unit-testable helpers backing the standalone `frick-server` binary
//! (`src/main.rs`). The binary itself stays thin; everything that can be tested
//! without binding a socket lives here.
//!
//! Schema selection mirrors the framework contract: an app serves its own
//! schema by pointing `FRICK_SCHEMA_PATH` at a serialized [`FrickSchema`] JSON
//! file; with the variable unset the server serves the empty
//! [`foundation_schema`].

use std::collections::BTreeMap;

use frick_protocol::{FrickSchema, foundation_schema, validate_schema};

/// Environment variable naming the JSON schema file the standalone server
/// should serve. Unset → the foundation schema.
pub const SCHEMA_PATH_ENV: &str = "FRICK_SCHEMA_PATH";

/// Collect the current process environment into the map shape
/// [`crate::load_frick_config`] and [`load_schema`] consume.
#[must_use]
pub fn config_env() -> BTreeMap<String, String> {
    std::env::vars().collect()
}

/// Resolve the schema the standalone server should serve.
///
/// If `FRICK_SCHEMA_PATH` is set, the named file is read, parsed as a
/// [`FrickSchema`], and validated; any failure becomes a clear `String` that
/// names the offending path. With the variable unset, the empty
/// [`foundation_schema`] is returned.
///
/// # Errors
///
/// Returns `Err` when the path is set but the file cannot be read, does not
/// parse as a schema, or fails [`validate_schema`].
pub fn load_schema(env: &BTreeMap<String, String>) -> Result<FrickSchema, String> {
    let Some(path) = env
        .get(SCHEMA_PATH_ENV)
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(foundation_schema());
    };

    let raw = std::fs::read_to_string(path)
        .map_err(|error| format!("failed to read {SCHEMA_PATH_ENV} \"{path}\": {error}"))?;
    let schema = serde_json::from_str::<FrickSchema>(&raw)
        .map_err(|error| format!("failed to parse schema JSON at \"{path}\": {error}"))?;
    validate_schema(&schema).map_err(|error| format!("invalid schema at \"{path}\": {error}"))?;
    Ok(schema)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn env_with_schema_path(path: &str) -> BTreeMap<String, String> {
        let mut env = BTreeMap::new();
        env.insert(SCHEMA_PATH_ENV.to_string(), path.to_string());
        env
    }

    #[test]
    fn no_env_var_yields_foundation_schema() {
        let schema = load_schema(&BTreeMap::new()).unwrap();
        assert_eq!(schema.schema_id, foundation_schema().schema_id);
    }

    #[test]
    fn empty_env_var_yields_foundation_schema() {
        let schema = load_schema(&env_with_schema_path("   ")).unwrap();
        assert_eq!(schema.schema_id, foundation_schema().schema_id);
    }

    #[test]
    fn serialized_schema_file_round_trips_and_validates() {
        let original = foundation_schema();
        let json = serde_json::to_string(&original).unwrap();
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(json.as_bytes()).unwrap();
        let path = file.path().to_str().unwrap().to_string();

        let loaded = load_schema(&env_with_schema_path(&path)).unwrap();
        assert_eq!(loaded.schema_id, original.schema_id);
        assert_eq!(loaded.schema_revision, original.schema_revision);
        assert_eq!(loaded, original);
    }

    #[test]
    fn missing_file_is_an_error_naming_the_path() {
        let path = "/nonexistent/frick-schema-should-not-exist.json";
        let error = load_schema(&env_with_schema_path(path)).unwrap_err();
        assert!(error.contains(path), "error should name the path: {error}");
    }

    #[test]
    fn malformed_json_is_an_error() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"{ not valid schema json").unwrap();
        let path = file.path().to_str().unwrap().to_string();
        let error = load_schema(&env_with_schema_path(&path)).unwrap_err();
        assert!(
            error.contains("parse"),
            "error should mention parse: {error}"
        );
    }

    #[test]
    fn structurally_invalid_schema_is_rejected() {
        // A well-formed JSON schema whose protocol is wrong fails
        // `validate_schema` even though it deserializes cleanly.
        let mut schema = foundation_schema();
        schema.protocol = "not.frick".to_string();
        let json = serde_json::to_string(&schema).unwrap();
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(json.as_bytes()).unwrap();
        let path = file.path().to_str().unwrap().to_string();

        let error = load_schema(&env_with_schema_path(&path)).unwrap_err();
        assert!(error.contains("invalid schema"), "got: {error}");
    }
}
