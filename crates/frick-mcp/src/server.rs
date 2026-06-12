//! The MCP server: protocol dispatch, tools, resources, and prompts.
//!
//! Ported from `packages/mcp/src/server.ts`. The dispatch core is the pure
//! async function [`FrickMcpServer::handle`]: a JSON-RPC request value in, a
//! JSON-RPC response value out (or `None` for notifications). The HTTP-calling
//! tools route through the injectable [`HttpCall`] seam so dispatch is testable
//! without a live server.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{Value, json};

use crate::config::{FrickMcpOptions, create_mcp_client_config, normalize_endpoint};
use crate::http::{HttpCall, HttpMethod, HttpRequest, runtime_value};

/// `DEFAULT_MCP_PROTOCOL_VERSION` (`server.ts:1`).
pub const DEFAULT_MCP_PROTOCOL_VERSION: &str = "2025-11-25";

/// A JSON-RPC id is a string or number. We carry it as a raw [`Value`] so we
/// preserve the exact client-supplied form (and `null` for parse errors).
type JsonRpcId = Value;

/// The MCP server. Holds the normalized endpoint, the resolved auth/tenant
/// context, the write-gating flag, and the HTTP seam.
pub struct FrickMcpServer {
    endpoint: String,
    token: Option<String>,
    tenant_id: Option<String>,
    user_id: Option<String>,
    allow_writes: bool,
    http: Arc<dyn HttpCall>,
}

impl FrickMcpServer {
    /// Build a server (`createFrickMcpServer`). The endpoint is normalized
    /// here; `http` is the injectable HTTP seam.
    #[must_use]
    pub fn new(options: &FrickMcpOptions, http: Arc<dyn HttpCall>) -> Self {
        Self {
            endpoint: normalize_endpoint(options.endpoint.as_deref()),
            token: non_empty(options.token.as_deref()),
            tenant_id: non_empty(options.tenant_id.as_deref()),
            user_id: non_empty(options.user_id.as_deref()),
            allow_writes: options.allow_writes,
            http,
        }
    }

    /// The public option view used by `frick_mcp_config` / `resources/read`.
    fn public_options(&self) -> FrickMcpOptions {
        FrickMcpOptions {
            endpoint: Some(self.endpoint.clone()),
            token: self.token.clone(),
            tenant_id: self.tenant_id.clone(),
            user_id: self.user_id.clone(),
            allow_writes: self.allow_writes,
        }
    }

    /// Whether the write tool is exposed (`allowWrites`).
    #[must_use]
    pub fn allow_writes(&self) -> bool {
        self.allow_writes
    }

    /// The normalized endpoint.
    #[must_use]
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// The fixed outgoing header set (`headers()`, `server.ts:274-281`).
    fn headers(&self) -> BTreeMap<String, String> {
        let mut headers = BTreeMap::new();
        headers.insert("accept".into(), "application/json".into());
        if let Some(token) = &self.token {
            headers.insert("authorization".into(), format!("Bearer {token}"));
        }
        if let Some(tenant) = &self.tenant_id {
            headers.insert("x-frick-tenant".into(), tenant.clone());
        }
        if let Some(user) = &self.user_id {
            headers.insert("x-frick-user".into(), user.clone());
        }
        headers
    }

    /// `fetchRuntime` over the seam: GET `path`, return the parsed/normalized
    /// body. Transport failure surfaces as a `{ ok:false, status:0, body }`
    /// envelope (mirrors a non-2xx wrap) rather than a JSON-RPC error.
    async fn fetch_runtime(&self, path: &str) -> Value {
        self.request_runtime(HttpMethod::Get, path, None).await
    }

    async fn request_runtime(&self, method: HttpMethod, path: &str, body: Option<Value>) -> Value {
        let mut headers = self.headers();
        if body.is_some() {
            headers.insert("content-type".into(), "application/json".into());
        }
        let request = HttpRequest {
            method,
            url: format!("{}{}", self.endpoint, path),
            headers,
            body,
        };
        match self.http.call(request).await {
            Ok(response) => runtime_value(&response),
            Err(error) => json!({ "ok": false, "status": 0, "body": { "text": error } }),
        }
    }

    /// The dispatch core (`handle`, `server.ts:362-422`): one JSON-RPC request
    /// value to one response value, or `None` for notifications.
    pub async fn handle(&self, message: &Value) -> Option<Value> {
        let id = request_id(message);
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            return Some(fail(&id, -32600, "Invalid JSON-RPC request", None));
        };
        let params = as_record(message.get("params"));

        match method {
            "initialize" => {
                let protocol_version = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or(DEFAULT_MCP_PROTOCOL_VERSION);
                Some(ok(
                    &id,
                    json!({
                        "protocolVersion": protocol_version,
                        "serverInfo": { "name": "frick-mcp", "version": "0.0.0" },
                        "capabilities": { "tools": {}, "resources": {}, "prompts": {} },
                    }),
                ))
            }
            "notifications/initialized" => None,
            "tools/list" => {
                let mut tools = read_tools();
                if self.allow_writes {
                    tools.extend(write_tools());
                }
                Some(ok(&id, json!({ "tools": tools })))
            }
            "tools/call" => {
                let Some(name) = string_arg(&params, &["name"]) else {
                    return Some(fail(&id, -32602, "tools/call requires params.name", None));
                };
                let arguments = as_record(params.get("arguments"));
                Some(ok(&id, self.call_tool(&name, &arguments).await))
            }
            "resources/list" => Some(ok(&id, json!({ "resources": resources() }))),
            "resources/templates/list" => Some(ok(
                &id,
                json!({
                    "resourceTemplates": [{
                        "uriTemplate": "frick://streams/{stream}/{key}",
                        "name": "stream-page",
                        "title": "Frick Stream Page",
                        "description": "Read a Frick stream page by stream name and key.",
                        "mimeType": "application/json",
                    }],
                }),
            )),
            "resources/read" => {
                let Some(uri) = string_arg(&params, &["uri"]) else {
                    return Some(fail(
                        &id,
                        -32602,
                        "resources/read requires params.uri",
                        None,
                    ));
                };
                Some(ok(&id, self.read_resource(&uri).await))
            }
            "prompts/list" => Some(ok(&id, json!({ "prompts": prompts() }))),
            "prompts/get" => {
                let Some(name) = string_arg(&params, &["name"]) else {
                    return Some(fail(&id, -32602, "prompts/get requires params.name", None));
                };
                let arguments = as_record(params.get("arguments"));
                Some(ok(&id, render_prompt(&name, &arguments)))
            }
            other => Some(fail(
                &id,
                -32601,
                &format!("Unknown MCP method: {other}"),
                None,
            )),
        }
    }

    /// `callTool` (`server.ts:305-347`).
    async fn call_tool(&self, name: &str, args: &Value) -> Value {
        match name {
            "frick_mcp_config" => {
                text_result(create_mcp_client_config(&self.public_options()), false)
            }
            "frick_health" => text_result(self.fetch_runtime("/health").await, false),
            "frick_ready" => text_result(self.fetch_runtime("/ready").await, false),
            "frick_inspect_server" => {
                text_result(self.fetch_runtime("/_frick/inspect/server").await, false)
            }
            "frick_inspect_db" => {
                text_result(self.fetch_runtime("/_frick/inspect/db").await, false)
            }
            "frick_inspect_jobs" => {
                text_result(self.fetch_runtime("/_frick/inspect/jobs").await, false)
            }
            "frick_explain_error" => {
                let code = string_arg(args, &["code"]).unwrap_or_else(|| "unknown".to_string());
                let hint = error_hint(&code);
                text_result(json!({ "code": code, "hint": hint }), false)
            }
            "frick_read_stream" => {
                let stream = string_arg(args, &["stream", "name"]);
                let key = string_arg(args, &["key"]);
                let (Some(stream), Some(key)) = (stream, key) else {
                    return text_result(json!({ "error": "stream and key are required" }), true);
                };
                let limit = integer_arg(args, "limit", 50).clamp(1, 100);
                let cursor = string_arg(args, &["cursor"]);
                let mut query = format!("limit={limit}");
                if let Some(cursor) = cursor {
                    query.push_str("&cursor=");
                    query.push_str(&url_encode_component(&cursor));
                }
                let path = format!(
                    "/streams/{}/{}?{}",
                    url_encode_component(&stream),
                    url_encode_component(&key),
                    query
                );
                text_result(self.fetch_runtime(&path).await, false)
            }
            "frick_append_event" => {
                if !self.allow_writes {
                    return text_result(
                        json!({ "error": "frick_append_event requires --allow-writes" }),
                        true,
                    );
                }
                let stream = string_arg(args, &["stream", "name"]);
                let key = string_arg(args, &["key"]);
                let event_type = string_arg(args, &["eventType", "type"]);
                let payload = args.get("payload").filter(|p| is_truthy_payload(p));
                let (Some(stream), Some(key), Some(event_type), Some(payload)) =
                    (stream, key, event_type, payload)
                else {
                    return text_result(
                        json!({ "error": "stream, key, eventType, and payload are required" }),
                        true,
                    );
                };
                let path = format!(
                    "/streams/{}/{}",
                    url_encode_component(&stream),
                    url_encode_component(&key)
                );
                let body = json!({ "type": event_type, "payload": payload });
                text_result(
                    self.request_runtime(HttpMethod::Post, &path, Some(body))
                        .await,
                    false,
                )
            }
            other => text_result(
                json!({ "error": format!("Unknown Frick MCP tool: {other}") }),
                true,
            ),
        }
    }

    /// `readResource` (`server.ts:349-358`).
    async fn read_resource(&self, uri: &str) -> Value {
        match uri {
            "frick://mcp/config" => {
                resource_content(uri, create_mcp_client_config(&self.public_options()))
            }
            "frick://server/health" => resource_content(uri, self.fetch_runtime("/health").await),
            "frick://server/ready" => resource_content(uri, self.fetch_runtime("/ready").await),
            // `schema/current` is documented as a distinct resource but reads
            // the same server-inspection payload (`server.ts:356`).
            "frick://inspect/server" | "frick://schema/current" => {
                resource_content(uri, self.fetch_runtime("/_frick/inspect/server").await)
            }
            "frick://inspect/db" => {
                resource_content(uri, self.fetch_runtime("/_frick/inspect/db").await)
            }
            "frick://inspect/jobs" => {
                resource_content(uri, self.fetch_runtime("/_frick/inspect/jobs").await)
            }
            other => json!({
                "contents": [{
                    "uri": other,
                    "mimeType": "text/plain",
                    "text": format!("Unknown Frick MCP resource: {other}"),
                }],
            }),
        }
    }
}

/// `requestId` (`server.ts:198-200`): `message.id ?? null`.
fn request_id(message: &Value) -> JsonRpcId {
    message.get("id").cloned().unwrap_or(Value::Null)
}

/// `ok` (`server.ts:202-204`).
#[allow(clippy::needless_pass_by_value)]
fn ok(id: &JsonRpcId, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// `fail` (`server.ts:206-216`): the `data` field is omitted when `None`.
fn fail(id: &JsonRpcId, code: i64, message: &str, data: Option<Value>) -> Value {
    let mut error = serde_json::Map::new();
    error.insert("code".into(), json!(code));
    error.insert("message".into(), json!(message));
    if let Some(data) = data {
        error.insert("data".into(), data);
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": Value::Object(error) })
}

/// `asRecord` (`server.ts:218-220`): an object → itself; anything else → `{}`.
fn as_record(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Object(map)) => Value::Object(map.clone()),
        _ => json!({}),
    }
}

/// `stringArg` (`server.ts:222-228`): first present non-empty string among the
/// candidate names.
fn string_arg(args: &Value, names: &[&str]) -> Option<String> {
    for name in names {
        if let Some(Value::String(value)) = args.get(name)
            && !value.is_empty()
        {
            return Some(value.clone());
        }
    }
    None
}

/// `integerArg` (`server.ts:230-235`): an integer number, or a digits-only
/// string, else the fallback.
fn integer_arg(args: &Value, name: &str, fallback: i64) -> i64 {
    match args.get(name) {
        Some(Value::Number(n)) => {
            // `Number.isInteger`: an exact integer value only. serde_json
            // exposes integral numbers via `as_i64`/`as_u64`; a JSON float
            // (e.g. `3.5`) yields neither, so it falls through to `fallback`.
            if let Some(i) = n.as_i64() {
                i
            } else if let Some(u) = n.as_u64() {
                i64::try_from(u).unwrap_or(fallback)
            } else if let Some(f) = n.as_f64().filter(|f| f.is_finite() && f.fract() == 0.0) {
                // `Number.isInteger` accepts integral float64 values. `f` is
                // known integral and finite; the cast is exact for the
                // in-range page sizes this is used for (later clamped 1..100).
                #[allow(clippy::cast_possible_truncation)]
                let i = f as i64;
                i
            } else {
                fallback
            }
        }
        Some(Value::String(s)) if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => {
            s.parse::<i64>().unwrap_or(fallback)
        }
        _ => fallback,
    }
}

/// JS truthiness of the `payload` arg: the TS guard is `if (!payload)`, so any
/// present non-null, non-empty-string, non-zero, non-false value passes. In
/// practice the schema constrains it to an object, but mirror the runtime
/// check faithfully: reject `null`, `false`, `0`, and `""`.
fn is_truthy_payload(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_none_or(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `textResult` (`server.ts:237-243`): `{ content:[{type:"text", text:
/// JSON.stringify(body, null, 2)}], structuredContent: body, isError }`.
/// `body` is consumed into the result; the borrow for `to_string_pretty`
/// happens first, so clippy's by-value lint is a false positive here.
#[allow(clippy::needless_pass_by_value)]
fn text_result(body: Value, is_error: bool) -> Value {
    let text = serde_json::to_string_pretty(&body).unwrap_or_else(|_| "null".into());
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": body,
        "isError": is_error,
    })
}

/// `resourceContent` (`server.ts:433-444`): a top-level `structuredContent`
/// alongside `contents` (the non-standard mirror). `body` is consumed.
#[allow(clippy::needless_pass_by_value)]
fn resource_content(uri: &str, body: Value) -> Value {
    let text = serde_json::to_string(&body).unwrap_or_else(|_| "null".into());
    json!({
        "structuredContent": body,
        "contents": [{ "uri": uri, "mimeType": "application/json", "text": text }],
    })
}

/// `objectSchema` (`server.ts:174-181`): omit `required` when empty.
fn object_schema(properties: Value, required: &[&str]) -> Value {
    let mut schema = serde_json::Map::new();
    schema.insert("type".into(), json!("object"));
    schema.insert("properties".into(), properties);
    schema.insert("additionalProperties".into(), json!(false));
    if !required.is_empty() {
        schema.insert("required".into(), json!(required));
    }
    Value::Object(schema)
}

#[allow(clippy::needless_pass_by_value)]
fn tool(name: &str, title: &str, description: &str, input_schema: Value) -> Value {
    json!({
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": input_schema,
    })
}

/// `READ_TOOLS` (`server.ts:57-113`).
fn read_tools() -> Vec<Value> {
    vec![
        tool(
            "frick_mcp_config",
            "Frick MCP Config",
            "Return the current Frick MCP endpoint and safety mode.",
            object_schema(json!({}), &[]),
        ),
        tool(
            "frick_health",
            "Frick Health",
            "Read the running Frick server /health endpoint.",
            object_schema(json!({}), &[]),
        ),
        tool(
            "frick_ready",
            "Frick Readiness",
            "Read the running Frick server /ready endpoint.",
            object_schema(json!({}), &[]),
        ),
        tool(
            "frick_inspect_server",
            "Inspect Frick Server",
            "Read documented server inspection data.",
            object_schema(json!({}), &[]),
        ),
        tool(
            "frick_inspect_db",
            "Inspect Frick Database",
            "Read documented database inspection data.",
            object_schema(json!({}), &[]),
        ),
        tool(
            "frick_inspect_jobs",
            "Inspect Frick Jobs",
            "Read documented job inspection data.",
            object_schema(json!({}), &[]),
        ),
        tool(
            "frick_read_stream",
            "Read Frick Stream",
            "Read a bounded page from a Frick stream.",
            object_schema(
                json!({
                    "stream": { "type": "string", "description": "Stream name." },
                    "key": { "type": "string", "description": "Stream key." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100, "description": "Page size." },
                    "cursor": { "type": "string", "description": "Optional cursor." },
                }),
                &["stream", "key"],
            ),
        ),
        tool(
            "frick_explain_error",
            "Explain Frick Error",
            "Explain a structured Frick error code and likely debugging path.",
            object_schema(
                json!({
                    "code": { "type": "string", "description": "Structured Frick error code." },
                }),
                &["code"],
            ),
        ),
    ]
}

/// `WRITE_TOOLS` (`server.ts:115-127`).
fn write_tools() -> Vec<Value> {
    vec![tool(
        "frick_append_event",
        "Append Frick Stream Event",
        "Append an event to a Frick stream. Requires --allow-writes and normal Frick authz.",
        object_schema(
            json!({
                "stream": { "type": "string" },
                "key": { "type": "string" },
                "eventType": { "type": "string" },
                "payload": { "type": "object" },
            }),
            &["stream", "key", "eventType", "payload"],
        ),
    )]
}

/// `resource` (`server.ts:183-192`): `name` = uri minus `frick://`.
fn resource_def(uri: &str, title: &str, description: &str) -> Value {
    json!({
        "uri": uri,
        "name": uri.strip_prefix("frick://").unwrap_or(uri),
        "title": title,
        "description": description,
        "mimeType": "application/json",
        "annotations": { "audience": ["assistant"], "priority": 0.8 },
    })
}

/// `RESOURCES` (`server.ts:129-137`).
fn resources() -> Vec<Value> {
    vec![
        resource_def(
            "frick://mcp/config",
            "MCP Config",
            "Current MCP endpoint and safety mode",
        ),
        resource_def(
            "frick://server/health",
            "Server Health",
            "Frick /health response",
        ),
        resource_def(
            "frick://server/ready",
            "Server Readiness",
            "Frick /ready response",
        ),
        resource_def(
            "frick://inspect/server",
            "Server Inspection",
            "Frick documented server inspection response",
        ),
        resource_def(
            "frick://inspect/db",
            "Database Inspection",
            "Frick documented database inspection response",
        ),
        resource_def(
            "frick://inspect/jobs",
            "Jobs Inspection",
            "Frick documented jobs inspection response",
        ),
        resource_def(
            "frick://schema/current",
            "Current Schema",
            "Current schema identity from server inspection",
        ),
    ]
}

/// `PROMPTS` (`server.ts:139-160`).
fn prompts() -> Vec<Value> {
    vec![
        json!({
            "name": "debug_frick_sync",
            "title": "Debug Frick Sync",
            "description": "Guide an agent through schema identity, handshake, cursor, cache, and structured error debugging.",
            "arguments": [
                { "name": "userId", "description": "Optional user id involved in the sync issue." },
                { "name": "stream", "description": "Optional stream name involved in the issue." },
            ],
        }),
        json!({
            "name": "inspect_frick_runtime",
            "title": "Inspect Frick Runtime",
            "description": "Collect health, readiness, inspection, and job context from a running Frick app.",
        }),
        json!({
            "name": "design_frick_projection",
            "title": "Design Frick Projection",
            "description": "Use live schema context to design or review a projection.",
            "arguments": [
                { "name": "projection", "description": "Projection name or product concept." },
            ],
        }),
    ]
}

/// `renderPrompt` (`server.ts:446-501`).
fn render_prompt(name: &str, args: &Value) -> Value {
    match name {
        "debug_frick_sync" => {
            let user = string_arg(args, &["userId"]).unwrap_or_else(|| "the affected user".into());
            let stream =
                string_arg(args, &["stream"]).unwrap_or_else(|| "the affected stream".into());
            let text = format!(
                "Debug Frick sync for {user} and {stream}. \
Start with schema identity, Hello/HelloAck capabilities, auth/session state, cursors, pending mutations, cache metadata, and structured error envelopes."
            );
            prompt_message("Debug Frick sync", &text)
        }
        "inspect_frick_runtime" => prompt_message(
            "Inspect Frick runtime",
            "Collect Frick health, readiness, server inspection, db inspection, jobs, schema identity, and MCP config before diagnosing runtime behavior.",
        ),
        "design_frick_projection" => {
            let projection = string_arg(args, &["projection"])
                .unwrap_or_else(|| "the requested projection".into());
            let text = format!(
                "Use the live Frick schema and app spine to design {projection}. Identify source objects/streams, derived shape, tenant scope, and client subscription behavior."
            );
            prompt_message("Design Frick projection", &text)
        }
        other => prompt_message(
            "Unknown prompt",
            &format!("Unknown Frick MCP prompt: {other}"),
        ),
    }
}

fn prompt_message(description: &str, text: &str) -> Value {
    json!({
        "description": description,
        "messages": [{
            "role": "user",
            "content": { "type": "text", "text": text },
        }],
    })
}

/// The error codes that have a dedicated hint (`ERROR_HINTS` keys,
/// `server.ts:162-172`). Exactly the §2.4 set of nine. Exposed for the
/// canonical-code drift test.
pub const HINTED_ERROR_CODES: [&str; 9] = [
    "auth.unauthenticated",
    "auth.forbidden",
    "auth.sessionExpired",
    "schema.incompatible",
    "schema.migrationRequired",
    "storage.conflict",
    "stream.appendRejected",
    "sync.protocolError",
    "sync.reconnectExhausted",
];

/// `ERROR_HINTS` (`server.ts:162-172`) plus the unknown-code fallback.
fn error_hint(code: &str) -> &'static str {
    match code {
        "auth.unauthenticated" => {
            "Check session token presence and whether the client sent credentials during Hello or HTTP request auth."
        }
        "auth.forbidden" => "Check tenant membership, object/stream visibility, and policy hooks.",
        "auth.sessionExpired" => "Refresh or recreate the session and reconnect the sync socket.",
        "schema.incompatible" => {
            "Compare schemaId, schemaRevision, schemaHash, and generated artifacts across server and client."
        }
        "schema.migrationRequired" => {
            "Run migration status and apply compatible migrations before reconnecting clients."
        }
        "storage.conflict" => "Check expectedVersion, mergePolicy, and pending offline upserts.",
        "stream.appendRejected" => {
            "Inspect stream schema, event payload shape, tenant scope, and authz policy."
        }
        "sync.protocolError" => {
            "Inspect Hello/HelloAck ordering, frame kind, payload shape, and required capabilities."
        }
        "sync.reconnectExhausted" => {
            "Check network stability, retry policy, server readiness, and last nack envelope."
        }
        _ => {
            "Unknown Frick error code. Treat it as opaque and inspect the full structured envelope."
        }
    }
}

/// `encodeURIComponent`-equivalent for a single path/query segment. JS encodes
/// everything except the unreserved set `A-Za-z0-9` and `- _ . ! ~ * ' ( )`.
fn url_encode_component(input: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    out
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value.filter(|v| !v.is_empty()).map(ToString::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::{HttpResponse, MockRecordingHttp};

    fn readonly_server() -> FrickMcpServer {
        FrickMcpServer::new(
            &FrickMcpOptions {
                endpoint: Some("http://127.0.0.1:4099".into()),
                ..FrickMcpOptions::default()
            },
            Arc::new(MockRecordingHttp::default()),
        )
    }

    #[tokio::test]
    async fn initialize_echoes_client_protocol_version() {
        let server = readonly_server();
        let response = server
            .handle(&json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": { "protocolVersion": "2025-11-25" }
            }))
            .await
            .unwrap();
        assert_eq!(response["id"], 1);
        assert_eq!(response["result"]["protocolVersion"], "2025-11-25");
        assert_eq!(response["result"]["serverInfo"]["name"], "frick-mcp");
        assert_eq!(response["result"]["serverInfo"]["version"], "0.0.0");
        assert!(response["result"]["capabilities"]["tools"].is_object());
    }

    #[tokio::test]
    async fn initialize_defaults_protocol_version() {
        let server = readonly_server();
        let response = server
            .handle(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }))
            .await
            .unwrap();
        assert_eq!(
            response["result"]["protocolVersion"],
            DEFAULT_MCP_PROTOCOL_VERSION
        );
    }

    #[tokio::test]
    async fn notifications_initialized_is_silent() {
        let server = readonly_server();
        let response = server
            .handle(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .await;
        assert!(response.is_none());
    }

    #[tokio::test]
    async fn missing_method_is_invalid_request() {
        let server = readonly_server();
        let response = server
            .handle(&json!({ "jsonrpc": "2.0", "id": 9 }))
            .await
            .unwrap();
        assert_eq!(response["error"]["code"], -32600);
    }

    #[tokio::test]
    async fn unknown_method_is_method_not_found() {
        let server = readonly_server();
        let response = server
            .handle(&json!({ "jsonrpc": "2.0", "id": 2, "method": "frobnicate" }))
            .await
            .unwrap();
        assert_eq!(response["error"]["code"], -32601);
        assert_eq!(
            response["error"]["message"],
            "Unknown MCP method: frobnicate"
        );
        // data omitted
        assert!(response["error"].get("data").is_none());
    }

    #[tokio::test]
    async fn tools_call_missing_name_is_invalid_params() {
        let server = readonly_server();
        let response = server
            .handle(&json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {} }))
            .await
            .unwrap();
        assert_eq!(response["error"]["code"], -32602);
    }

    #[tokio::test]
    async fn tools_list_gates_write_tool() {
        let read = readonly_server();
        let read_list = read
            .handle(&json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/list" }))
            .await
            .unwrap();
        assert!(!read_list.to_string().contains("frick_append_event"));
        assert!(read_list.to_string().contains("frick_read_stream"));

        let write = FrickMcpServer::new(
            &FrickMcpOptions {
                endpoint: Some("http://127.0.0.1:4099".into()),
                allow_writes: true,
                ..FrickMcpOptions::default()
            },
            Arc::new(MockRecordingHttp::default()),
        );
        let write_list = write
            .handle(&json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/list" }))
            .await
            .unwrap();
        assert!(write_list.to_string().contains("frick_append_event"));
    }

    #[tokio::test]
    async fn append_event_gated_without_allow_writes() {
        let server = readonly_server();
        let response = server
            .handle(&json!({
                "jsonrpc": "2.0", "id": 6, "method": "tools/call",
                "params": { "name": "frick_append_event", "arguments": {
                    "stream": "s", "key": "k", "eventType": "e", "payload": {}
                } }
            }))
            .await
            .unwrap();
        assert_eq!(response["result"]["isError"], true);
        assert_eq!(
            response["result"]["structuredContent"]["error"],
            "frick_append_event requires --allow-writes"
        );
    }

    #[tokio::test]
    async fn unknown_tool_is_error_result() {
        let server = readonly_server();
        let response = server
            .handle(&json!({
                "jsonrpc": "2.0", "id": 7, "method": "tools/call",
                "params": { "name": "nope", "arguments": {} }
            }))
            .await
            .unwrap();
        assert_eq!(response["result"]["isError"], true);
        assert_eq!(
            response["result"]["structuredContent"]["error"],
            "Unknown Frick MCP tool: nope"
        );
    }

    #[tokio::test]
    async fn explain_error_uses_static_hint_table() {
        let server = readonly_server();
        let response = server
            .handle(&json!({
                "jsonrpc": "2.0", "id": 8, "method": "tools/call",
                "params": { "name": "frick_explain_error", "arguments": { "code": "auth.forbidden" } }
            }))
            .await
            .unwrap();
        assert_eq!(
            response["result"]["structuredContent"]["hint"],
            "Check tenant membership, object/stream visibility, and policy hooks."
        );
        let unknown = server
            .handle(&json!({
                "jsonrpc": "2.0", "id": 8, "method": "tools/call",
                "params": { "name": "frick_explain_error", "arguments": { "code": "made.up" } }
            }))
            .await
            .unwrap();
        assert!(
            unknown["result"]["structuredContent"]["hint"]
                .as_str()
                .unwrap()
                .starts_with("Unknown Frick error code")
        );
    }

    #[tokio::test]
    async fn health_call_sends_auth_headers_and_returns_structured_content() {
        let mock = Arc::new(MockRecordingHttp::with_response(HttpResponse {
            status: 200,
            text: "{\"ok\":true,\"schemaId\":\"demo\"}".into(),
        }));
        let server = FrickMcpServer::new(
            &FrickMcpOptions {
                endpoint: Some("http://127.0.0.1:4099".into()),
                token: Some("session-token".into()),
                tenant_id: Some("tenant-dev".into()),
                user_id: Some("user-ada".into()),
                ..FrickMcpOptions::default()
            },
            mock.clone(),
        );
        let response = server
            .handle(&json!({
                "jsonrpc": "2.0", "id": 5, "method": "tools/call",
                "params": { "name": "frick_inspect_server", "arguments": {} }
            }))
            .await
            .unwrap();
        assert_eq!(response["result"]["isError"], false);
        assert_eq!(response["result"]["structuredContent"]["schemaId"], "demo");
        let calls = mock.calls();
        assert_eq!(calls[0].url, "http://127.0.0.1:4099/_frick/inspect/server");
        assert_eq!(
            calls[0].headers.get("authorization").unwrap(),
            "Bearer session-token"
        );
        assert_eq!(
            calls[0].headers.get("x-frick-tenant").unwrap(),
            "tenant-dev"
        );
        assert_eq!(calls[0].headers.get("x-frick-user").unwrap(), "user-ada");
    }

    #[tokio::test]
    async fn read_stream_clamps_limit_and_encodes_segments() {
        let mock = Arc::new(MockRecordingHttp::with_response(HttpResponse {
            status: 200,
            text: "{\"data\":[]}".into(),
        }));
        let server = FrickMcpServer::new(
            &FrickMcpOptions {
                endpoint: Some("http://127.0.0.1:4099".into()),
                ..FrickMcpOptions::default()
            },
            mock.clone(),
        );
        let _ = server
            .handle(&json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": { "name": "frick_read_stream", "arguments": {
                    "stream": "a/b", "key": "k 1", "limit": 9999, "cursor": "c?x"
                } }
            }))
            .await
            .unwrap();
        let calls = mock.calls();
        assert_eq!(
            calls[0].url,
            "http://127.0.0.1:4099/streams/a%2Fb/k%201?limit=100&cursor=c%3Fx"
        );
    }

    #[tokio::test]
    async fn read_stream_requires_stream_and_key() {
        let server = readonly_server();
        let response = server
            .handle(&json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": { "name": "frick_read_stream", "arguments": { "stream": "s" } }
            }))
            .await
            .unwrap();
        assert_eq!(response["result"]["isError"], true);
    }

    #[tokio::test]
    async fn read_stream_accepts_name_alias() {
        let mock = Arc::new(MockRecordingHttp::with_response(HttpResponse {
            status: 200,
            text: "{}".into(),
        }));
        let server = FrickMcpServer::new(
            &FrickMcpOptions {
                endpoint: Some("http://127.0.0.1:4099".into()),
                ..FrickMcpOptions::default()
            },
            mock.clone(),
        );
        let _ = server
            .handle(&json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": { "name": "frick_read_stream", "arguments": { "name": "feed", "key": "k" } }
            }))
            .await
            .unwrap();
        assert_eq!(
            mock.calls()[0].url,
            "http://127.0.0.1:4099/streams/feed/k?limit=50"
        );
    }

    #[tokio::test]
    async fn append_event_posts_type_and_payload() {
        let mock = Arc::new(MockRecordingHttp::with_response(HttpResponse {
            status: 201,
            text: "{\"ok\":true}".into(),
        }));
        let server = FrickMcpServer::new(
            &FrickMcpOptions {
                endpoint: Some("http://127.0.0.1:4099".into()),
                allow_writes: true,
                ..FrickMcpOptions::default()
            },
            mock.clone(),
        );
        let _ = server
            .handle(&json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": { "name": "frick_append_event", "arguments": {
                    "stream": "feed", "key": "k", "type": "Posted", "payload": { "n": 1 }
                } }
            }))
            .await
            .unwrap();
        let call = &mock.calls()[0];
        assert_eq!(call.method, HttpMethod::Post);
        assert_eq!(call.url, "http://127.0.0.1:4099/streams/feed/k");
        assert_eq!(
            call.headers.get("content-type").unwrap(),
            "application/json"
        );
        assert_eq!(
            call.body.as_ref().unwrap(),
            &json!({ "type": "Posted", "payload": { "n": 1 } })
        );
    }

    #[tokio::test]
    async fn resources_read_includes_top_level_structured_content() {
        let mock = Arc::new(MockRecordingHttp::with_response(HttpResponse {
            status: 200,
            text: "{\"ok\":true,\"status\":\"ready\"}".into(),
        }));
        let server = FrickMcpServer::new(
            &FrickMcpOptions {
                endpoint: Some("http://127.0.0.1:4099".into()),
                ..FrickMcpOptions::default()
            },
            mock,
        );
        let response = server
            .handle(&json!({
                "jsonrpc": "2.0", "id": 8, "method": "resources/read",
                "params": { "uri": "frick://server/ready" }
            }))
            .await
            .unwrap();
        assert_eq!(response["result"]["structuredContent"]["status"], "ready");
        assert!(
            response["result"]["contents"][0]["text"]
                .as_str()
                .unwrap()
                .contains("\"status\":\"ready\"")
        );
    }

    #[tokio::test]
    async fn prompts_get_renders_user_message() {
        let server = readonly_server();
        let response = server
            .handle(&json!({
                "jsonrpc": "2.0", "id": 9, "method": "prompts/get",
                "params": { "name": "debug_frick_sync", "arguments": { "userId": "user-ada" } }
            }))
            .await
            .unwrap();
        let text = response["result"]["messages"][0]["content"]["text"]
            .as_str()
            .unwrap();
        assert!(text.contains("user-ada"));
        assert!(text.contains("schema identity"));
    }

    #[tokio::test]
    async fn unknown_prompt_is_success_with_description() {
        let server = readonly_server();
        let response = server
            .handle(&json!({
                "jsonrpc": "2.0", "id": 9, "method": "prompts/get",
                "params": { "name": "nope", "arguments": {} }
            }))
            .await
            .unwrap();
        assert_eq!(response["result"]["description"], "Unknown prompt");
    }

    #[tokio::test]
    async fn non_2xx_response_wraps_body() {
        let mock = Arc::new(MockRecordingHttp::with_response(HttpResponse {
            status: 503,
            text: "{\"reason\":\"down\"}".into(),
        }));
        let server = FrickMcpServer::new(
            &FrickMcpOptions {
                endpoint: Some("http://127.0.0.1:4099".into()),
                ..FrickMcpOptions::default()
            },
            mock,
        );
        let response = server
            .handle(&json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": { "name": "frick_ready", "arguments": {} }
            }))
            .await
            .unwrap();
        let sc = &response["result"]["structuredContent"];
        assert_eq!(sc["ok"], false);
        assert_eq!(sc["status"], 503);
        assert_eq!(sc["body"]["reason"], "down");
    }

    #[test]
    fn hinted_codes_are_canonical_frick_error_codes() {
        // Every code we hand a hint to must be a real `FrickErrorCode` (drift
        // guard against the canonical list the server emits). The hint table
        // is intentionally a SUBSET of the 16 codes (§2.4 lists nine).
        for code in HINTED_ERROR_CODES {
            assert!(
                code.parse::<frick_protocol::FrickErrorCode>().is_ok(),
                "hinted code {code} is not a canonical FrickErrorCode"
            );
            // And the hint must be the real one, not the fallback.
            assert!(!error_hint(code).starts_with("Unknown Frick error code"));
        }
    }

    #[test]
    fn integer_arg_parses_digit_strings_and_clamps() {
        assert_eq!(integer_arg(&json!({ "limit": 7 }), "limit", 50), 7);
        assert_eq!(integer_arg(&json!({ "limit": "12" }), "limit", 50), 12);
        assert_eq!(integer_arg(&json!({ "limit": "x" }), "limit", 50), 50);
        assert_eq!(integer_arg(&json!({ "limit": 3.5 }), "limit", 50), 50);
        assert_eq!(integer_arg(&json!({}), "limit", 50), 50);
    }
}
