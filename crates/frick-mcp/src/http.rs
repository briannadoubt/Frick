//! The outgoing HTTP seam used by the read/write tools and resources.
//!
//! Ported from the `fetchJson`/`fetchRuntime`/`headers` helpers in
//! `packages/mcp/src/server.ts:274-303`. The MCP server only ever issues plain
//! GET/POST requests against a running Frick server, attaching the fixed
//! wire-compat header set (`accept`, `authorization`, `x-frick-tenant`,
//! `x-frick-user`).
//!
//! The trait [`HttpCall`] is the injectable seam: production uses
//! [`ReqwestHttpCall`]; unit tests substitute a recording/stub implementation
//! so the dispatch core can be exercised without a live server.

use std::collections::BTreeMap;

use async_trait::async_trait;
use serde_json::{Value, json};

/// An outgoing HTTP request the MCP server wants to make.
#[derive(Debug, Clone)]
pub struct HttpRequest {
    /// HTTP method (`GET` or `POST`).
    pub method: HttpMethod,
    /// The full request URL (`<endpoint><path>`).
    pub url: String,
    /// The request headers, lower-cased keys (mirrors the TS `Headers`).
    pub headers: BTreeMap<String, String>,
    /// Optional JSON body (POST only).
    pub body: Option<Value>,
}

/// The two methods the MCP server issues.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
}

impl HttpMethod {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            HttpMethod::Get => "GET",
            HttpMethod::Post => "POST",
        }
    }
}

/// A raw HTTP response: status code plus the body text.
#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub text: String,
}

/// The injectable HTTP seam. Mirrors the TS `FrickMcpFetch` type.
#[async_trait]
pub trait HttpCall: Send + Sync {
    /// Perform the request. Implementations must NOT raise on non-2xx — they
    /// return the status + body text and the caller decides (see
    /// [`fetch_runtime`]). Transport-level failure is surfaced as an `Err`.
    async fn call(&self, request: HttpRequest) -> Result<HttpResponse, String>;
}

/// Production HTTP seam backed by `reqwest`.
pub struct ReqwestHttpCall {
    client: reqwest::Client,
}

impl Default for ReqwestHttpCall {
    fn default() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }
}

impl ReqwestHttpCall {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl HttpCall for ReqwestHttpCall {
    async fn call(&self, request: HttpRequest) -> Result<HttpResponse, String> {
        let mut builder = match request.method {
            HttpMethod::Get => self.client.get(&request.url),
            HttpMethod::Post => self.client.post(&request.url),
        };
        for (key, value) in &request.headers {
            builder = builder.header(key.as_str(), value.as_str());
        }
        if let Some(body) = &request.body {
            builder = builder.body(serde_json::to_vec(body).map_err(|e| e.to_string())?);
        }
        let response = builder.send().await.map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        let text = response.text().await.map_err(|e| e.to_string())?;
        Ok(HttpResponse { status, text })
    }
}

/// Parse a Frick server response body the way `fetchJson` does
/// (`server.ts:288-296`): empty → empty string value; valid JSON → that value;
/// non-JSON, non-empty → `{ "text": <raw> }`.
#[must_use]
pub fn parse_body(text: &str) -> Value {
    if text.is_empty() {
        return Value::String(String::new());
    }
    match serde_json::from_str::<Value>(text) {
        Ok(value) => value,
        Err(_) => json!({ "text": text }),
    }
}

/// `fetchRuntime` (`server.ts:300-303`): a 2xx response yields the parsed body
/// directly; a non-2xx response is wrapped `{ ok:false, status, body }`.
#[must_use]
pub fn runtime_value(response: &HttpResponse) -> Value {
    let body = parse_body(&response.text);
    let ok = (200..300).contains(&response.status);
    if ok {
        body
    } else {
        json!({ "ok": false, "status": response.status, "body": body })
    }
}

/// A recording / canned-response HTTP seam for tests. Records every request
/// and returns a fixed [`HttpResponse`] (default 200 `{}`). Lives outside
/// `#[cfg(test)]` so the integration tests in `tests/` and the unit tests in
/// other modules can share it.
#[derive(Default)]
pub struct MockRecordingHttp {
    response: Option<HttpResponse>,
    calls: std::sync::Mutex<Vec<HttpRequest>>,
}

impl MockRecordingHttp {
    /// A mock that returns the given canned response for every call.
    #[must_use]
    pub fn with_response(response: HttpResponse) -> Self {
        Self {
            response: Some(response),
            calls: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Snapshot the recorded requests in call order.
    ///
    /// # Panics
    /// Panics if the internal mutex is poisoned (only possible if a prior call
    /// panicked while holding it — not expected in tests).
    #[must_use]
    pub fn calls(&self) -> Vec<HttpRequest> {
        self.calls.lock().expect("calls mutex").clone()
    }
}

#[async_trait]
impl HttpCall for MockRecordingHttp {
    async fn call(&self, request: HttpRequest) -> Result<HttpResponse, String> {
        self.calls.lock().expect("calls mutex").push(request);
        Ok(self.response.clone().unwrap_or(HttpResponse {
            status: 200,
            text: "{}".into(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_body_handles_empty_json_and_text() {
        assert_eq!(parse_body(""), Value::String(String::new()));
        assert_eq!(parse_body("{\"a\":1}"), json!({ "a": 1 }));
        assert_eq!(parse_body("not json"), json!({ "text": "not json" }));
    }

    #[test]
    fn runtime_value_wraps_non_2xx() {
        let ok = HttpResponse {
            status: 200,
            text: "{\"ok\":true}".into(),
        };
        assert_eq!(runtime_value(&ok), json!({ "ok": true }));

        let bad = HttpResponse {
            status: 404,
            text: "{\"error\":\"nope\"}".into(),
        };
        assert_eq!(
            runtime_value(&bad),
            json!({ "ok": false, "status": 404, "body": { "error": "nope" } })
        );
    }
}
