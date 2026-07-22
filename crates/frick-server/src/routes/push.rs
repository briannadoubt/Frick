//! `/push/registrations` create + revoke (`src/server.ts:1862-1921`).

use std::net::IpAddr;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use frick_store::StoreError;
use frick_store::stores::push_registration::{
    PushDeviceRegistration, PushEnvironment, PushPlatform, PushRegistrationInput,
};
use serde_json::json;

use super::{authenticate, map_get, new_request_id, parse_body_value, require_string};
use crate::error::ServerError;
use crate::http::{AppState, respond_error};

/// Routes for this surface.
pub fn router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/push/registrations", post(register))
        .route("/push/registrations/:id", axum::routing::delete(revoke))
        .with_state(state)
}

/// `POST /push/registrations` (`src/server.ts:1862-1896`): validate
/// `{deviceId, platform, token, environment?}`, register, 201 `{registration}`.
async fn register(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let request_id = new_request_id();
    let (principal, now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };

    let parsed = match parse_body_value(&body) {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    let device_id = match require_string(&parsed, "deviceId", "deviceId") {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    let platform_str = match require_string(&parsed, "platform", "platform") {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    let Some(platform) = PushPlatform::parse(&platform_str) else {
        return respond_error(
            &ServerError::BadRequest {
                message: format!(
                    "platform must be one of apns, apnsVoip, fcm, webPush, test (got \"{platform_str}\")"
                ),
            },
            &request_id,
        );
    };
    let token = match require_string(&parsed, "token", "token") {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    if platform == PushPlatform::WebPush
        && let Err(error) = validate_web_push_token(&token)
    {
        return respond_error(&error, &request_id);
    }
    let environment = match parse_environment(&parsed) {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };

    let new_id = format!("push-{}", uuid::Uuid::new_v4());
    match state
        .store
        .push_registrations()
        .register(
            &PushRegistrationInput {
                tenant_id: principal.tenant_id.clone(),
                user_id: principal.user_id.clone(),
                device_id,
                platform,
                token,
                environment,
            },
            &new_id,
            now,
        )
        .await
    {
        Ok(registration) => (
            StatusCode::CREATED,
            axum::Json(json!({ "registration": registration_json(&registration) })),
        )
            .into_response(),
        Err(error) => respond_error(&store_error(&error), &request_id),
    }
}

/// `DELETE /push/registrations/:id` (`src/server.ts:1898-1921`): 404 when
/// missing OR owned by another user in the same tenant (no cross-user existence
/// leak); 204 on revoke.
async fn revoke(
    State(state): State<AppState>,
    Path(registration_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let request_id = new_request_id();
    let (principal, now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };

    if registration_id.is_empty() {
        return not_found();
    }
    let existing = match state
        .store
        .push_registrations()
        .get_by_id(&registration_id, &principal.tenant_id)
        .await
    {
        Ok(existing) => existing,
        Err(error) => return respond_error(&store_error(&error), &request_id),
    };
    // 404 covers truly-missing OR another user's row in the same tenant.
    let Some(_) = existing.filter(|r| r.user_id == principal.user_id) else {
        return not_found();
    };

    match state
        .store
        .push_registrations()
        .revoke(&registration_id, &principal.tenant_id, now)
        .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => respond_error(&store_error(&error), &request_id),
    }
}

/// The bespoke `{error:"push_registration_not_found"}` 404 body.
fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        axum::Json(json!({ "error": "push_registration_not_found" })),
    )
        .into_response()
}

/// Parse the optional `environment` field: default `production`; a present
/// value must be `production` or `sandbox`.
fn parse_environment(body: &frick_protocol::Value) -> Result<PushEnvironment, ServerError> {
    match map_get(body, "environment").and_then(frick_protocol::Value::as_str) {
        None | Some("" | "production") => Ok(PushEnvironment::Production),
        Some("sandbox") => Ok(PushEnvironment::Sandbox),
        Some(_) => Err(ServerError::BadRequest {
            message: "environment must be \"production\" or \"sandbox\"".into(),
        }),
    }
}

/// `validateWebPushRegistrationToken` (`push/web-push-adapter.ts:334-352`): the
/// token must be a PushSubscription JSON whose `endpoint` is a public https URL
/// (not localhost / cloud-metadata / a private or loopback IP). The full SSRF
/// host blocklist is ported here in its essential form.
fn validate_web_push_token(token: &str) -> Result<(), ServerError> {
    let bad = || ServerError::BadRequest {
        message: "webPush token must be a PushSubscription JSON with a public https endpoint"
            .into(),
    };
    let parsed = serde_json::from_str::<serde_json::Value>(token).map_err(|_| bad())?;
    let endpoint = parsed
        .get("endpoint")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(bad)?;
    if !is_safe_web_push_endpoint(endpoint) {
        return Err(bad());
    }
    Ok(())
}

/// `isSafeWebPushEndpoint` (`push/web-push-adapter.ts:354-365`): https scheme +
/// a host that is not unsafe.
fn is_safe_web_push_endpoint(endpoint: &str) -> bool {
    // A minimal URL parse: scheme://host[:port]/...
    let Some(rest) = endpoint.strip_prefix("https://") else {
        return false;
    };
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('@')
        .next()
        .unwrap_or("");
    // Strip an optional port (but not inside an IPv6 literal).
    let host = if host.starts_with('[') {
        host.split(']')
            .next()
            .unwrap_or(host)
            .trim_start_matches('[')
    } else {
        host.split(':').next().unwrap_or(host)
    };
    !host.is_empty() && !is_unsafe_host(host)
}

/// `isUnsafeHost` (`push/web-push-adapter.ts:391-408`): localhost variants,
/// the cloud metadata host, and private/loopback/link-local IPs.
fn is_unsafe_host(host: &str) -> bool {
    let lower = host.trim_end_matches('.').to_ascii_lowercase();
    if lower == "localhost" || lower.ends_with(".localhost") || lower == "metadata.google.internal"
    {
        return true;
    }
    if let Ok(ip) = lower.parse::<IpAddr>() {
        return is_unsafe_ip(ip);
    }
    false
}

/// Private / loopback / link-local / unspecified ranges (the union of the TS
/// `isUnsafeIpv4` / `isUnsafeIpv6` checks).
fn is_unsafe_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                // Carrier-grade NAT 100.64.0.0/10.
                || (v4.octets()[0] == 100 && (64..=127).contains(&v4.octets()[1]))
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                // Unique-local fc00::/7.
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                // Link-local fe80::/10.
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                || v6.to_ipv4_mapped().is_some_and(is_unsafe_ipv4_mapped)
        }
    }
}

fn is_unsafe_ipv4_mapped(v4: std::net::Ipv4Addr) -> bool {
    is_unsafe_ip(IpAddr::V4(v4))
}

/// A push registration row → its camelCase JSON shape. `revokedAt` is null when
/// the row is active (the TS mapper omits the key; null serializes equivalently
/// for clients).
fn registration_json(reg: &PushDeviceRegistration) -> serde_json::Value {
    json!({
        "registrationId": reg.registration_id,
        "tenantId": reg.tenant_id,
        "userId": reg.user_id,
        "deviceId": reg.device_id,
        "platform": reg.platform.as_str(),
        "token": reg.token,
        "environment": reg.environment.as_str(),
        "createdAt": reg.created_at,
        "lastSeenAt": reg.last_seen_at,
        "revokedAt": reg.revoked_at,
    })
}

fn store_error(error: &StoreError) -> ServerError {
    ServerError::BadRequest {
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_push_endpoint_safety() {
        assert!(is_safe_web_push_endpoint(
            "https://fcm.googleapis.com/fcm/send/abc"
        ));
        // Non-https.
        assert!(!is_safe_web_push_endpoint("http://example.com/x"));
        // Localhost and private IPs.
        assert!(!is_safe_web_push_endpoint("https://localhost/x"));
        assert!(!is_safe_web_push_endpoint("https://127.0.0.1/x"));
        assert!(!is_safe_web_push_endpoint("https://10.0.0.5/x"));
        assert!(!is_safe_web_push_endpoint("https://192.168.1.1/x"));
        assert!(!is_safe_web_push_endpoint(
            "https://metadata.google.internal/x"
        ));
        assert!(!is_safe_web_push_endpoint("https://[::1]/x"));
    }

    #[test]
    fn web_push_token_validation() {
        assert!(validate_web_push_token(r#"{"endpoint":"https://push.example.com/abc"}"#).is_ok());
        assert!(validate_web_push_token("not json").is_err());
        assert!(validate_web_push_token(r#"{"endpoint":"http://insecure/x"}"#).is_err());
        assert!(validate_web_push_token(r#"{"foo":"bar"}"#).is_err());
    }
}
