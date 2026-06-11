//! Templates for the canonical Rust-DSL authoring scaffold (`frick init`,
//! FR-263).
//!
//! Post-cutover the backend is the Rust `frick-server`, which loads a
//! serialized [`FrickSchema`](frick_protocol::schema::FrickSchema) JSON via
//! `FRICK_SCHEMA_PATH`. The epic decided schemas are *authored in a Rust DSL*
//! (the `frick-schema` builder) with TS/Swift/Kotlin as codegen targets. These
//! renderers emit the **source of truth**: a small, buildable binary crate that
//!
//!  1. defines the app schema with [`SchemaBuilder`](frick_schema::SchemaBuilder),
//!  2. on `cargo run`, exports `schema.json` (the file the standalone server
//!     reads), and
//!  3. generates the Swift / Kotlin / TypeScript client SDKs into `generated/`
//!     via [`frick_codegen`].
//!
//! The render functions are deterministic `vars -> String`; [`init`](crate::commands::init)
//! writes each one with the existing refuse-on-overwrite guard.
//!
//! ## Dependency wiring
//!
//! The scaffolded `Cargo.toml` depends on `frick-schema` + `frick-codegen`.
//! Those crates are not (yet) published to crates.io, so the default
//! [`CrateDeps::Path`] points the dependencies at the Frick repo's crates by
//! absolute path — this is what makes the scaffold `cargo build` *today* and
//! keeps the authoring loop real. [`CrateDeps::Version`] instead pins a
//! registry version for when the crates are published; the generated README
//! documents the swap.

use serde_json::json;

/// Template variables for the Rust authoring scaffold.
#[derive(Debug, Clone)]
pub struct InitVariables {
    /// Human/app name (also the schema `name`).
    pub app_name: String,
    /// Cargo package name (a sanitized, crate-name-safe form of `app_name`).
    pub crate_name: String,
    /// Wire schema id (defaults to `app_name`).
    pub schema_id: String,
    /// Default server port (used in the README run instructions).
    pub port: u32,
    /// Schema version string (`schemaVersion`).
    pub version: String,
    /// How the scaffold's `frick-*` dependencies are wired.
    pub crate_deps: CrateDeps,
}

/// How the scaffolded crate depends on `frick-schema` / `frick-codegen`.
#[derive(Debug, Clone)]
pub enum CrateDeps {
    /// Absolute path dependencies into the Frick repo's `crates/` (the default
    /// — the crates are not published, so this is what builds today). Carries
    /// the absolute path to the `crates/` directory.
    Path(String),
    /// A published registry version pin (e.g. `"0.4.0"`).
    Version(String),
}

impl CrateDeps {
    /// Render the two `[dependencies]` lines for `frick-schema` and
    /// `frick-codegen`.
    fn dependency_lines(&self) -> String {
        match self {
            Self::Path(crates_dir) => {
                // TOML basic strings: escape backslashes (Windows paths) and quotes.
                let dir = crates_dir.replace('\\', "\\\\").replace('"', "\\\"");
                format!(
                    "frick-schema = {{ path = \"{dir}/frick-schema\" }}\n\
                     frick-codegen = {{ path = \"{dir}/frick-codegen\" }}\n"
                )
            }
            Self::Version(version) => format!(
                "frick-schema = \"{version}\"\n\
                 frick-codegen = \"{version}\"\n"
            ),
        }
    }
}

/// Sanitize an arbitrary app name into a Cargo-package-name-safe identifier:
/// lowercase ASCII, non-alphanumerics collapsed to `-`, no leading/trailing or
/// doubled `-`, a leading digit prefixed with `app-`, and a non-empty fallback.
#[must_use]
pub fn crate_name_from(app_name: &str) -> String {
    let mut out = String::with_capacity(app_name.len());
    let mut last_dash = false;
    for ch in app_name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        return "frick-app".to_string();
    }
    if out.starts_with(|c: char| c.is_ascii_digit()) {
        out.insert_str(0, "app-");
    }
    out
}

/// JSON-encode a string for embedding as a Rust string literal (handles quotes
/// and backslashes; the app name / version are otherwise free-form).
fn rust_str(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| format!("\"{value}\""))
}

/// `Cargo.toml` for the scaffolded authoring crate. A standalone binary crate
/// (its own `[workspace]` table so it is never absorbed into a surrounding
/// workspace, e.g. when scaffolded inside the Frick repo).
#[must_use]
pub fn render_cargo_toml(vars: &InitVariables) -> String {
    let crate_name = &vars.crate_name;
    let version = &vars.version;
    let deps = vars.crate_deps.dependency_lines();
    format!(
        "[package]\n\
         name = \"{crate_name}\"\n\
         version = \"{version}\"\n\
         edition = \"2021\"\n\
         publish = false\n\
         \n\
         # Standalone workspace: keep this crate from being absorbed into a\n\
         # surrounding Cargo workspace (e.g. when scaffolded inside a monorepo).\n\
         [workspace]\n\
         \n\
         [[bin]]\n\
         name = \"{crate_name}\"\n\
         path = \"src/main.rs\"\n\
         \n\
         [dependencies]\n\
         {deps}\
         serde_json = \"1\"\n"
    )
}

/// `src/main.rs`: defines the schema via the builder and, when run, exports
/// `schema.json` plus the client SDKs. The `frick:schema` marker brackets the
/// builder chain so future tooling can locate the authoring block.
#[must_use]
pub fn render_main_rs(vars: &InitVariables) -> String {
    let app_name = rust_str(&vars.app_name);
    let schema_id = rust_str(&vars.schema_id);
    let version = rust_str(&vars.version);
    let hash = rust_str(&format!("{}-{}", vars.crate_name, vars.version));
    format!(
        "//! Schema authoring entry point for this Frick app.\n\
         //!\n\
         //! `cargo run` (re)writes `schema.json` for the standalone\n\
         //! `frick-server` and regenerates the Swift / Kotlin / TypeScript\n\
         //! client SDKs under `generated/`. Edit [`app_schema`] to evolve the\n\
         //! app, then run again. See README.md for the full loop.\n\
         \n\
         use std::fs;\n\
         use std::path::Path;\n\
         \n\
         use frick_codegen::error_enums::generate_typescript_error_enum;\n\
         use frick_codegen::kotlin::generate_kotlin_artifact;\n\
         use frick_codegen::swift::generate_swift_artifact;\n\
         use frick_codegen::typescript::generate_typescript_bindings;\n\
         use frick_schema::SchemaBuilder;\n\
         use frick_schema::builder::field;\n\
         use frick_schema::FrickSchema;\n\
         \n\
         /// The app schema. This is the **source of truth** — TS/Swift/Kotlin\n\
         /// are generated from it. Grow it with the builder DSL; numeric ids\n\
         /// are the wire contract and are never auto-assigned.\n\
         fn app_schema() -> FrickSchema {{\n\
         \x20   // frick:schema:start\n\
         \x20   SchemaBuilder::new({app_name}, {schema_id})\n\
         \x20       .version({version})\n\
         \x20       .revision(1)\n\
         \x20       .hash({hash})\n\
         \x20       // A first example object — rename or replace it.\n\
         \x20       .object(\"Item\", 1, |o| {{\n\
         \x20           o.field(field::string(\"title\", 1).required())\n\
         \x20               .field(field::bool(\"done\", 2).required())\n\
         \x20               .field(field::timestamp(\"createdAt\", 3))\n\
         \x20               .index(\"byTitle\", 1, [\"title\"])\n\
         \x20       }})\n\
         \x20       .build()\n\
         \x20       .expect(\"schema validates\")\n\
         \x20   // frick:schema:end\n\
         }}\n\
         \n\
         fn main() -> Result<(), Box<dyn std::error::Error>> {{\n\
         \x20   let schema = app_schema();\n\
         \n\
         \x20   // 1. Export schema.json for the standalone frick-server\n\
         \x20   //    (FRICK_SCHEMA_PATH=schema.json).\n\
         \x20   let schema_json = serde_json::to_string_pretty(&schema)?;\n\
         \x20   fs::write(\"schema.json\", format!(\"{{schema_json}}\\n\"))?;\n\
         \n\
         \x20   // 2. Generate the client SDKs under generated/.\n\
         \x20   let generated = Path::new(\"generated\");\n\
         \x20   fs::create_dir_all(generated.join(\"swift\"))?;\n\
         \x20   fs::create_dir_all(generated.join(\"kotlin\"))?;\n\
         \x20   fs::create_dir_all(generated.join(\"typescript\"))?;\n\
         \x20   fs::write(\n\
         \x20       generated.join(\"swift/FrickGenerated.swift\"),\n\
         \x20       format!(\"{{}}\\n\", generate_swift_artifact(&schema)),\n\
         \x20   )?;\n\
         \x20   fs::write(\n\
         \x20       generated.join(\"kotlin/FrickGenerated.kt\"),\n\
         \x20       format!(\"{{}}\\n\", generate_kotlin_artifact(&schema)),\n\
         \x20   )?;\n\
         \x20   fs::write(\n\
         \x20       generated.join(\"typescript/bindings.ts\"),\n\
         \x20       format!(\"{{}}\\n\", generate_typescript_bindings(&schema)),\n\
         \x20   )?;\n\
         \x20   fs::write(\n\
         \x20       generated.join(\"typescript/errors.ts\"),\n\
         \x20       format!(\"{{}}\\n\", generate_typescript_error_enum()),\n\
         \x20   )?;\n\
         \n\
         \x20   println!(\n\
         \x20       \"wrote schema.json ({{}} objects) + client SDKs under generated/\",\n\
         \x20       schema.objects.len()\n\
         \x20   );\n\
         \x20   Ok(())\n\
         }}\n\
         \n\
         #[cfg(test)]\n\
         mod tests {{\n\
         \x20   use super::app_schema;\n\
         \n\
         \x20   #[test]\n\
         \x20   fn schema_builds_and_is_valid() {{\n\
         \x20       // `app_schema` calls `.build()`, which runs validate_schema;\n\
         \x20       // reaching this line means the schema is valid.\n\
         \x20       let schema = app_schema();\n\
         \x20       assert_eq!(schema.schema_id, {schema_id});\n\
         \x20   }}\n\
         }}\n"
    )
}

/// `.gitignore` — keep build output and the generated SDKs out of version
/// control (they are reproducible from `cargo run`).
#[must_use]
pub fn render_gitignore(_vars: &InitVariables) -> String {
    "/target\n\
     /schema.json\n\
     /generated\n"
        .to_string()
}

/// `README.md` — explains the Rust-DSL authoring loop end to end.
#[must_use]
pub fn render_readme_md(vars: &InitVariables) -> String {
    let app_name = &vars.app_name;
    let crate_name = &vars.crate_name;
    let port = vars.port;
    let deps_note = match &vars.crate_deps {
        CrateDeps::Path(_) => {
            "> `Cargo.toml` currently pins `frick-schema` / `frick-codegen` by **path** into your\n\
             > local Frick checkout (those crates are not published yet). When they ship to\n\
             > crates.io, replace the `path = \"…\"` entries with a version pin, e.g.\n\
             > `frick-schema = \"0.4\"`."
        }
        CrateDeps::Version(version) => {
            return render_readme_with_version(app_name, crate_name, port, version);
        }
    };
    format!(
        "# {app_name}\n\
         \n\
         A [Frick](https://github.com/briannadoubt/Frick) app. **The schema is authored in\n\
         Rust** (the `frick-schema` builder DSL) and everything else is generated from it.\n\
         \n\
         ## The authoring loop\n\
         \n\
         ```\n\
         edit src/main.rs  ->  cargo run  ->  schema.json + client SDKs  ->  run frick-server\n\
         ```\n\
         \n\
         1. **Author** the schema in `src/main.rs` (`app_schema()`), using the\n\
         \x20  [`SchemaBuilder`] DSL. Numeric ids are the wire contract — set them explicitly.\n\
         2. **Generate** by running the crate:\n\
         \n\
         \x20  ```sh\n\
         \x20  cargo run\n\
         \x20  ```\n\
         \n\
         \x20  This (re)writes:\n\
         \x20  - `schema.json` — the serialized `FrickSchema` the standalone server reads.\n\
         \x20  - `generated/swift/FrickGenerated.swift`\n\
         \x20  - `generated/kotlin/FrickGenerated.kt`\n\
         \x20  - `generated/typescript/bindings.ts` + `generated/typescript/errors.ts`\n\
         \n\
         \x20  Copy the generated SDKs into your client apps (or wire them up however you\n\
         \x20  consume generated code).\n\
         3. **Run the backend** — the standalone Rust `frick-server`, pointed at the exported\n\
         \x20  schema:\n\
         \n\
         \x20  ```sh\n\
         \x20  # from source\n\
         \x20  FRICK_SCHEMA_PATH=./schema.json FRICK_PORT={port} cargo run -p frick-server\n\
         \n\
         \x20  # or via the published server image\n\
         \x20  docker run --rm -p {port}:{port} \\\n\
         \x20    -e FRICK_SCHEMA_PATH=/app/schema.json -e FRICK_PORT={port} \\\n\
         \x20    -v \"$PWD/schema.json:/app/schema.json:ro\" frick-server:latest\n\
         \x20  ```\n\
         \n\
         To evolve the app, edit `app_schema()` and re-run `cargo run` — bump the `.hash(…)`\n\
         and `.revision(…)` whenever the schema changes shape.\n\
         \n\
         ## Project layout\n\
         \n\
         - `src/main.rs` — the schema (source of truth) + the export/codegen entry point.\n\
         - `schema.json` — generated; feed it to `frick-server` via `FRICK_SCHEMA_PATH`.\n\
         - `generated/` — generated client SDKs (Swift, Kotlin, TypeScript).\n\
         \n\
         `cargo test` validates the schema without writing any files.\n\
         \n\
         {deps_note}\n\
         \n\
         [`SchemaBuilder`]: https://github.com/briannadoubt/Frick/tree/main/crates/frick-schema\n"
    )
}

/// README body for the published-version dependency variant.
fn render_readme_with_version(
    app_name: &str,
    _crate_name: &str,
    port: u32,
    version: &str,
) -> String {
    format!(
        "# {app_name}\n\
         \n\
         A [Frick](https://github.com/briannadoubt/Frick) app. **The schema is authored in\n\
         Rust** (the `frick-schema` builder DSL, pinned at `{version}`) and everything else is\n\
         generated from it.\n\
         \n\
         ## The authoring loop\n\
         \n\
         ```\n\
         edit src/main.rs  ->  cargo run  ->  schema.json + client SDKs  ->  run frick-server\n\
         ```\n\
         \n\
         1. **Author** the schema in `src/main.rs` (`app_schema()`).\n\
         2. **Generate** with `cargo run` — writes `schema.json` + `generated/` SDKs.\n\
         3. **Run** the standalone `frick-server`:\n\
         \n\
         \x20  ```sh\n\
         \x20  FRICK_SCHEMA_PATH=./schema.json FRICK_PORT={port} frick-server\n\
         \x20  ```\n\
         \n\
         `cargo test` validates the schema without writing any files.\n"
    )
}

/// The summary record's `created` paths, relative to the scaffold root, in the
/// order [`init`](crate::commands::init) writes them. Exposed so the README and
/// tests describe the same file set.
#[must_use]
pub fn scaffold_layout() -> serde_json::Value {
    json!({
        "cargoToml": "Cargo.toml",
        "mainRs": "src/main.rs",
        "gitignore": ".gitignore",
        "readme": "README.md",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars() -> InitVariables {
        InitVariables {
            app_name: "My App".to_string(),
            crate_name: "my-app".to_string(),
            schema_id: "My App".to_string(),
            port: 4099,
            version: "0.1.0".to_string(),
            crate_deps: CrateDeps::Path("/repo/crates".to_string()),
        }
    }

    #[test]
    fn crate_name_sanitizes() {
        assert_eq!(crate_name_from("My Cool App"), "my-cool-app");
        assert_eq!(crate_name_from("already-kebab"), "already-kebab");
        assert_eq!(crate_name_from("under_score"), "under-score");
        assert_eq!(crate_name_from("Trailing!!"), "trailing");
        assert_eq!(crate_name_from("  spaced  "), "spaced");
        assert_eq!(crate_name_from("3dprint"), "app-3dprint");
        assert_eq!(crate_name_from("***"), "frick-app");
        assert_eq!(crate_name_from(""), "frick-app");
    }

    #[test]
    fn cargo_toml_has_standalone_workspace_and_both_deps() {
        let toml = render_cargo_toml(&vars());
        assert!(toml.contains("name = \"my-app\""));
        assert!(toml.contains("[workspace]"));
        assert!(toml.contains("[[bin]]"));
        assert!(toml.contains("frick-schema = { path = \"/repo/crates/frick-schema\" }"));
        assert!(toml.contains("frick-codegen = { path = \"/repo/crates/frick-codegen\" }"));
    }

    #[test]
    fn cargo_toml_version_deps_pin_registry() {
        let mut v = vars();
        v.crate_deps = CrateDeps::Version("0.4.0".to_string());
        let toml = render_cargo_toml(&v);
        assert!(toml.contains("frick-schema = \"0.4.0\""));
        assert!(toml.contains("frick-codegen = \"0.4.0\""));
        // Version mode must not emit a path-*dependency* (the `[[bin]]
        // path = "src/main.rs"` line is legitimate and unrelated).
        assert!(!toml.contains("{ path ="));
    }

    #[test]
    fn main_rs_uses_builder_and_exports() {
        let main = render_main_rs(&vars());
        assert!(main.contains("use frick_schema::SchemaBuilder;"));
        assert!(main.contains("SchemaBuilder::new(\"My App\", \"My App\")"));
        assert!(main.contains("fs::write(\"schema.json\""));
        assert!(main.contains("generate_swift_artifact"));
        assert!(main.contains("generate_kotlin_artifact"));
        assert!(main.contains("generate_typescript_bindings"));
        assert!(main.contains("// frick:schema:start"));
        assert!(main.contains("// frick:schema:end"));
    }

    #[test]
    fn readme_documents_the_loop() {
        let readme = render_readme_md(&vars());
        assert!(readme.contains("authoring loop"));
        assert!(readme.contains("cargo run"));
        assert!(readme.contains("FRICK_SCHEMA_PATH=./schema.json"));
        assert!(readme.contains("frick-server"));
    }
}
