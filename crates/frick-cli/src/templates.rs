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
            "dev": "tsx src/server.ts",
            "build": "tsc",
            "test": "vitest run"
        },
        "dependencies": {
            "@fricken/protocol": "workspace:*",
            "@fricken/server": "workspace:*"
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
/// `// frick:projections:imports` / `// frick:projections:register` markers.
#[must_use]
pub fn render_server_ts(vars: &TemplateVariables) -> String {
    format!(
        "import {{ createFrickServer }} from \"@fricken/server\";\n\
import {{ schema }} from \"./schema.js\";\n\
\n\
// frick:projections:imports\n\
\n\
const port = Number(process.env.PORT ?? {port});\n\
\n\
const app = createFrickServer({{ schema, port }});\n\
\n\
// frick:projections:register\n\
\n\
await app.listen();\n",
        port = vars.port
    )
}

/// `tests/smoke.test.ts` (`templates/smoke.test.ts.ts`).
#[must_use]
pub fn render_smoke_test_ts(_vars: &TemplateVariables) -> String {
    "import { describe, expect, it } from \"vitest\";\n\
import { createFrickServer } from \"@fricken/server\";\n\
import { schema } from \"../src/schema.js\";\n\
\n\
describe(\"smoke\", () => {\n\
  it(\"boots the server and answers /health\", async () => {\n\
    const app = createFrickServer({\n\
      schema,\n\
      port: 0,\n\
      dbPath: \":memory:\",\n\
      config: { env: \"test\" },\n\
      jobs: { workerEnabled: false },\n\
    });\n\
    await app.listen();\n\
    try {\n\
      const response = await fetch(`${app.httpUrl}/health`);\n\
      expect(response.status).toBe(200);\n\
      expect(app.store.schema.schemaId).toBe(schema.schemaId);\n\
    } finally {\n\
      await app.close();\n\
    }\n\
  });\n\
});\n"
        .to_string()
}
