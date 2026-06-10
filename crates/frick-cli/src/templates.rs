//! Inline scaffold templates (ported from `apps/cli/src/templates/`).
//!
//! Each renderer returns the exact file contents the TS templates produce for
//! the same `{appName, port, version}` — the JSON files are emitted via
//! `serde_json::to_string_pretty` (2-space indent) plus a trailing newline,
//! matching `JSON.stringify(body, null, 2) + "\n"`.

use serde_json::json;

/// Template variables (`TemplateVariables` in TS).
#[derive(Debug, Clone)]
pub struct TemplateVariables {
    /// Application name (package name + schema identity).
    pub app_name: String,
    /// Default server port.
    pub port: u32,
    /// Version string.
    pub version: String,
}

fn pretty_json(value: &serde_json::Value) -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(value).unwrap_or_default()
    )
}

/// JSON-encode a string literal (always succeeds for `&str`).
fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| format!("\"{value}\""))
}

/// `package.json` (`templates/package.json.ts`).
#[must_use]
pub fn render_package_json(vars: &TemplateVariables) -> String {
    let body = json!({
        "name": vars.app_name,
        "version": vars.version,
        "private": true,
        "type": "module",
        "scripts": {
            "build": "tsc",
            "test": "vitest run"
        },
        "dependencies": {
            "@fricken/protocol": "workspace:*"
        },
        "devDependencies": {
            "@types/node": "^24.10.0",
            "tsx": "^4.21.0",
            "typescript": "^5.9.3",
            "vitest": "^4.0.8"
        }
    });
    pretty_json(&body)
}

/// `tsconfig.json` (`templates/tsconfig.json.ts`).
#[must_use]
pub fn render_tsconfig_json(_vars: &TemplateVariables) -> String {
    let body = json!({
        "compilerOptions": {
            "target": "ES2022",
            "module": "ESNext",
            "moduleResolution": "Bundler",
            "strict": true,
            "esModuleInterop": true,
            "skipLibCheck": true,
            "forceConsistentCasingInFileNames": true,
            "resolveJsonModule": true,
            "declaration": true,
            "outDir": "dist",
            "rootDir": "src"
        },
        "include": ["src/**/*.ts"],
        "exclude": ["node_modules", "dist", "tests"]
    });
    pretty_json(&body)
}

/// `frick.config.json` (`templates/frick.config.json.ts`).
#[must_use]
pub fn render_frick_config_json(vars: &TemplateVariables) -> String {
    let body = json!({
        "appName": vars.app_name,
        "port": vars.port,
        "env": "development"
    });
    pretty_json(&body)
}

/// `src/schema.ts` (`templates/schema.ts.ts`). Contains the `// frick:objects`
/// and `// frick:streams` markers consumed by `frick scaffold`.
#[must_use]
pub fn render_schema_ts(vars: &TemplateVariables) -> String {
    let app_name = json_string(&vars.app_name);
    let version = json_string(&vars.version);
    format!(
        "import type {{ FrickSchema }} from \"@fricken/protocol\";\n\
\n\
export const schema: FrickSchema = {{\n\
  name: {app_name},\n\
  schemaId: {app_name},\n\
  schemaVersion: {version},\n\
  schemaRevision: 1,\n\
  minimumClientRevision: 1,\n\
  minimumServerRevision: 1,\n\
  protocol: \"frick.realtime\",\n\
  protocolVersion: 1,\n\
  compatibility: \"greenfield-cutover\",\n\
  hash: \"scaffold\",\n\
  // frick:objects\n\
  objects: [],\n\
  // frick:streams\n\
  streams: [],\n\
  events: [],\n\
  presences: [],\n\
  signals: [],\n\
  blobs: [],\n\
  jobs: [],\n\
  projections: [],\n\
}};\n"
    )
}

/// `src/server.ts` (`templates/server.ts.ts`). Contains the
/// `// frick:projections:imports` / `// frick:projections:register` markers
/// consumed by `frick scaffold projection`.
///
/// Post-cutover this module is *data only*: the backend runs as the standalone
/// Rust `frick-server` binary (see README.md), so the file exports the app's
/// schema + projection registry rather than booting an embedded TS server.
#[must_use]
pub fn render_server_ts(_vars: &TemplateVariables) -> String {
    "/**\n\
 * App definition consumed by the standalone `frick-server` binary (see\n\
 * README.md). The backend is the Rust `frick-server`, NOT an embedded TS\n\
 * server — this module is the app schema plus its projection registry.\n\
 */\n\
import { schema } from \"./schema.js\";\n\
\n\
// frick:projections:imports\n\
\n\
export const app = {\n\
  schema,\n\
  projections: [\n\
    // frick:projections:register\n\
  ] as const,\n\
};\n"
        .to_string()
}

/// `tests/smoke.test.ts` (`templates/smoke.test.ts.ts`). Post-cutover this
/// validates the scaffold schema rather than booting a server (the embedded TS
/// server was removed — the backend is the standalone `frick-server` binary).
#[must_use]
pub fn render_smoke_test_ts(vars: &TemplateVariables) -> String {
    let app_name = json_string(&vars.app_name);
    format!(
        "import {{ describe, expect, it }} from \"vitest\";\n\
import {{ validateSchema }} from \"@fricken/protocol\";\n\
import {{ schema }} from \"../src/schema.js\";\n\
\n\
describe(\"smoke\", () => {{\n\
  it(\"has a valid scaffold schema\", () => {{\n\
    expect(() => validateSchema(schema)).not.toThrow();\n\
  }});\n\
\n\
  it(\"uses the app name as its schemaId\", () => {{\n\
    expect(schema.schemaId).toBe({app_name});\n\
  }});\n\
}});\n"
    )
}

/// `README.md` (`templates/README.md.ts`). Explains the project shape and how
/// to run the standalone Rust `frick-server` backend.
#[must_use]
pub fn render_readme_md(vars: &TemplateVariables) -> String {
    let app_name = &vars.app_name;
    let port = vars.port;
    format!(
        "# {app_name}\n\
\n\
A [Frick](https://github.com/briannadoubt/Frick) schema + client project.\n\
\n\
- `src/schema.ts` — the app schema (objects, streams, events, …). Edit it by\n\
  hand or with `frick scaffold object|stream <Name>`.\n\
- `src/server.ts` — the **app definition** (`export const app = {{ schema,\n\
  projections }}`) that the backend consumes. It does NOT boot a server; the\n\
  backend is the standalone Rust `frick-server` binary. Add projections with\n\
  `frick scaffold projection <name>`.\n\
- `tests/smoke.test.ts` — validates the schema with `vitest run`.\n\
\n\
## Running the backend\n\
\n\
The backend is the Rust `frick-server` binary — there is no embedded TS server.\n\
\n\
### Docker\n\
\n\
Build/run the server image (see `ops/deploy/server.Dockerfile` and the deploy\n\
compose files), pointing `FRICK_SCHEMA_PATH` at this app's exported schema JSON:\n\
\n\
```sh\n\
FRICK_SCHEMA_PATH=./schema.json FRICK_PORT={port} \\\n\
  docker run --rm -p {port}:{port} \\\n\
  -e FRICK_SCHEMA_PATH -e FRICK_PORT frick-server:latest\n\
```\n\
\n\
### From source\n\
\n\
```sh\n\
FRICK_SCHEMA_PATH=./schema.json FRICK_PORT={port} cargo run -p frick-server\n\
```\n\
\n\
## Exporting the schema\n\
\n\
The standalone server reads the schema as JSON (`FRICK_SCHEMA_PATH`). Exporting\n\
`src/schema.ts` → `schema.json` is a follow-up: `frick` will gain a\n\
schema-export command. Until then, serialize the exported `schema` yourself.\n"
    )
}
