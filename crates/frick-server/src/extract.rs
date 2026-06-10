//! Bearer-token principal extraction shared by the data-plane routes (FR-244).
//!
//! Mirrors the TS `sessionTokenFromRequest` + `protectedHttpPrincipal` seam
//! (`src/server.ts:5067-5076`, `3688-3725`): the token comes off
//! `Authorization: Bearer <t>` (case-insensitive) or the `x-frick-session-token`
//! header, then resolves through [`session::principal_from_active_session_token`].
//!
//! The Rust port covers only the session path (password/dev-login sessions).
//! Admin-token and `sk_` service-key principals are resolved upstream of these
//! data-plane handlers and are not re-derived here (TODO(FR-246): admin/service
//! principals on the data plane).

use axum::http::HeaderMap;
use axum::http::header::AUTHORIZATION;

use crate::error::ServerError;
use crate::http::AppState;
use crate::principal::Principal;
use crate::session::principal_from_active_session_token;

/// Header carrying a raw session token when `Authorization` is not used.
const SESSION_TOKEN_HEADER: &str = "x-frick-session-token";

/// Pull the session token off a request's headers
/// (`sessionTokenFromRequest`, `src/server.ts:5067-5076`): prefer
/// `Authorization: Bearer <token>` (the scheme match is case-insensitive and
/// tolerant of extra whitespace), else fall back to `x-frick-session-token`.
#[must_use]
pub fn session_token_from_headers(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok())
        && let Some(token) = parse_bearer(value)
    {
        return Some(token.to_string());
    }
    headers
        .get(SESSION_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

/// Extract a token from an `Authorization` header value, matching the TS regex
/// `/^Bearer\s+(.+)$/i`: a case-insensitive `Bearer` scheme followed by at
/// least one whitespace character and a non-empty token.
fn parse_bearer(value: &str) -> Option<&str> {
    let rest = value.strip_prefix("Bearer").or_else(|| {
        // Case-insensitive scheme match without allocating.
        value
            .get(..6)
            .filter(|prefix| prefix.eq_ignore_ascii_case("Bearer"))
            .map(|_| &value[6..])
    })?;
    // At least one whitespace separator is required.
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let token = rest.trim_start();
    if token.is_empty() { None } else { Some(token) }
}

/// Resolve the request's bearer token to an authenticated [`Principal`], or the
/// appropriate [`ServerError`] (`protectedHttpPrincipal`): a missing token is a
/// generic 401, an expired session is `auth.sessionExpired`, and an unknown
/// token is a generic 401 — the distinctions made by
/// [`principal_from_active_session_token`].
pub async fn require_principal(
    state: &AppState,
    headers: &HeaderMap,
    now_ms: i64,
) -> Result<Principal, ServerError> {
    let Some(token) = session_token_from_headers(headers) else {
        return Err(ServerError::Authentication {
            message: "Missing session token".into(),
        });
    };
    principal_from_active_session_token(&state.store, &token, now_ms).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    #[test]
    fn extracts_bearer_token_case_insensitively() {
        assert_eq!(
            session_token_from_headers(&headers(&[("authorization", "Bearer tok-1")])),
            Some("tok-1".to_string())
        );
        assert_eq!(
            session_token_from_headers(&headers(&[("authorization", "bearer   tok-2")])),
            Some("tok-2".to_string())
        );
    }

    #[test]
    fn falls_back_to_session_token_header() {
        assert_eq!(
            session_token_from_headers(&headers(&[("x-frick-session-token", "tok-3")])),
            Some("tok-3".to_string())
        );
    }

    #[test]
    fn rejects_non_bearer_authorization() {
        assert_eq!(
            session_token_from_headers(&headers(&[("authorization", "Basic abc")])),
            None
        );
        // No separating whitespace.
        assert_eq!(
            session_token_from_headers(&headers(&[("authorization", "Bearertok")])),
            None
        );
    }

    #[test]
    fn no_token_is_none() {
        assert_eq!(session_token_from_headers(&HeaderMap::new()), None);
    }
}
