//! Integration tests for the email/password identity + refresh-token routes
//! (FR-268). Drives the routes over a real socket against a booted server with
//! a [`RecordingEmailAdapter`] injected through [`BootSeams`], so the
//! forgot-password email seam is observable.
//!
//! Coverage:
//! - signup → login happy path;
//! - duplicate-email 409 `storage.conflict` + `reason: "emailTaken"` (FR-219);
//! - wrong password = generic `auth.unauthenticated`, identical to an unknown
//!   email (no user enumeration);
//! - forgot-password returns 200 for existing AND non-existing accounts, and
//!   the recording adapter captured a reset message ONLY for the existing one;
//! - reset-password with a valid token sets a new password (old fails, new
//!   works); a reused token is rejected;
//! - refresh rotates (old token dies, new works) and revoke works.

use std::sync::Arc;

use frick_server::email::RecordingEmailAdapter;
use frick_server::{
    BootSeams, FrickConfig, FrickServer, create_frick_server, create_frick_server_with_seams,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn test_config() -> FrickConfig {
    let mut env = std::collections::BTreeMap::new();
    env.insert("FRICK_ENV".to_string(), "test".to_string());
    env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
    env.insert("FRICK_PORT".to_string(), "0".to_string());
    frick_server::config::load_frick_config(&env).unwrap()
}

/// Boot a server with a recording email adapter; returns the running server +
/// a handle to the captured messages.
async fn boot() -> (FrickServer, RecordingEmailAdapter) {
    let recorder = RecordingEmailAdapter::new();
    let mut seams = BootSeams::production();
    // Inject the recorder behind a router with a real `from:` so the
    // password-reset helper actually formats + sends (rather than reporting
    // missingFrom). This is the FR-271 plug point.
    seams.email_router = Arc::new(frick_server::EmailRouter::new(
        Arc::new(recorder.clone()),
        Some("noreply@frick.test".to_string()),
        Some("Frick".to_string()),
    ));
    let mut server =
        create_frick_server_with_seams(test_config(), frick_protocol::foundation_schema(), seams)
            .await
            .unwrap();
    server.listen().await.unwrap();
    (server, recorder)
}

/// FR-271: a deployment with NO email configuration boots through the real
/// `create_frick_server` config-driven path, keeps the Noop email router (no
/// provider is wired), and `forgot-password` still returns 200 — the seam never
/// makes the route depend on a real send. Drives the full boot path (not a
/// seam-injected recorder) so the config→router selection is exercised.
#[tokio::test]
async fn unconfigured_deployment_stays_noop_and_forgot_password_still_200s() {
    let mut server = create_frick_server(test_config(), frick_protocol::foundation_schema())
        .await
        .unwrap();
    // No FRICK_EMAIL_PROVIDER ⇒ Noop router.
    assert_eq!(server.state.email_router.provider(), "noop");
    server.listen().await.unwrap();
    let port = server.port();

    let (status, body) = post(
        port,
        "/auth/email/forgot-password",
        r#"{"email":"nobody@example.com"}"#,
    )
    .await;
    assert_eq!(status, 200, "forgot-password body: {body}");
    assert!(body.contains("\"ok\":true"), "forgot-password body: {body}");

    server.close().await;
}

/// Minimal HTTP POST that returns `(status_line_code, body)`.
async fn post(port: u16, path: &str, body: &str) -> (u16, String) {
    post_with_headers(port, path, body, &[]).await
}

async fn post_with_headers(
    port: u16,
    path: &str,
    body: &str,
    headers: &[(&str, &str)],
) -> (u16, String) {
    let mut stream = tokio::net::TcpStream::connect(format!("127.0.0.1:{port}"))
        .await
        .unwrap();
    let mut header_block = String::new();
    for (name, value) in headers {
        header_block.push_str(name);
        header_block.push_str(": ");
        header_block.push_str(value);
        header_block.push_str("\r\n");
    }
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n{header_block}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    let status = response
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);
    let body = response
        .split_once("\r\n\r\n")
        .map_or(String::new(), |(_, b)| b.to_string());
    (status, body)
}

/// Extract a JSON string value out of a raw response body.
fn json_string(body: &str, key: &str) -> String {
    let needle = format!("\"{key}\":\"");
    let start = body
        .find(&needle)
        .unwrap_or_else(|| panic!("key {key} missing in {body}"))
        + needle.len();
    let rest = &body[start..];
    let end = rest.find('"').expect("closing quote");
    rest[..end].to_string()
}

#[tokio::test]
async fn signup_then_login_happy_path() {
    let (mut server, _recorder) = boot().await;
    let port = server.port();

    let (status, body) = post(
        port,
        "/auth/email/signup",
        r#"{"email":"Ada@Example.com","password":"hunter2hunter2"}"#,
    )
    .await;
    assert_eq!(status, 201, "signup body: {body}");
    assert!(body.contains("\"sessionToken\""), "signup body: {body}");
    assert!(body.contains("\"isNewUser\":true"), "signup body: {body}");
    // Email is normalized to lowercase and echoed as the handle.
    assert_eq!(json_string(&body, "email"), "ada@example.com");

    // Login with the same (case-insensitive) email + password succeeds.
    let (status, body) = post(
        port,
        "/auth/email/login",
        r#"{"email":"ada@example.com","password":"hunter2hunter2"}"#,
    )
    .await;
    assert_eq!(status, 200, "login body: {body}");
    assert!(body.contains("\"sessionToken\""), "login body: {body}");
    assert!(body.contains("\"isNewUser\":false"), "login body: {body}");

    server.close().await;
}

#[tokio::test]
async fn duplicate_email_returns_distinct_409() {
    let (mut server, _recorder) = boot().await;
    let port = server.port();

    let (status, _) = post(
        port,
        "/auth/email/signup",
        r#"{"email":"dup@example.com","password":"hunter2hunter2"}"#,
    )
    .await;
    assert_eq!(status, 201);

    // A second signup for the same email is a DISTINCT 409 (FR-219), not a
    // generic 400 — the envelope carries `storage.conflict` + reason emailTaken.
    let (status, body) = post(
        port,
        "/auth/email/signup",
        r#"{"email":"dup@example.com","password":"different-pass"}"#,
    )
    .await;
    assert_eq!(status, 409, "expected 409, body: {body}");
    assert!(body.contains("storage.conflict"), "body: {body}");
    assert!(body.contains("emailTaken"), "body: {body}");

    server.close().await;
}

#[tokio::test]
async fn wrong_password_is_generic_and_matches_unknown_email() {
    let (mut server, _recorder) = boot().await;
    let port = server.port();

    post(
        port,
        "/auth/email/signup",
        r#"{"email":"real@example.com","password":"correct-horse"}"#,
    )
    .await;

    // Wrong password for a real account.
    let (wrong_pw_status, wrong_pw_body) = post(
        port,
        "/auth/email/login",
        r#"{"email":"real@example.com","password":"WRONG-password"}"#,
    )
    .await;
    // Unknown email entirely.
    let (unknown_status, unknown_body) = post(
        port,
        "/auth/email/login",
        r#"{"email":"ghost@example.com","password":"anything-here"}"#,
    )
    .await;

    // Both are the identical generic 401 — no enumeration: a wrong password is
    // indistinguishable from an unknown account.
    assert_eq!(wrong_pw_status, 401, "wrong-pw body: {wrong_pw_body}");
    assert_eq!(unknown_status, 401, "unknown body: {unknown_body}");
    assert!(
        wrong_pw_body.contains("auth.unauthenticated"),
        "body: {wrong_pw_body}"
    );
    assert!(
        unknown_body.contains("auth.unauthenticated"),
        "body: {unknown_body}"
    );
    // The message must not differ between the two branches.
    assert_eq!(
        json_string(&wrong_pw_body, "message"),
        json_string(&unknown_body, "message"),
        "the two 401s must be byte-identical to avoid enumeration"
    );

    server.close().await;
}

#[tokio::test]
async fn forgot_password_is_uniform_and_only_sends_for_real_accounts() {
    let (mut server, recorder) = boot().await;
    let port = server.port();

    post(
        port,
        "/auth/email/signup",
        r#"{"email":"member@example.com","password":"correct-horse"}"#,
    )
    .await;

    // Existing account: 200, and a reset email IS dispatched.
    let (existing_status, existing_body) = post(
        port,
        "/auth/email/forgot-password",
        r#"{"email":"member@example.com"}"#,
    )
    .await;
    assert_eq!(existing_status, 200, "body: {existing_body}");
    assert!(
        existing_body.contains("\"ok\":true"),
        "body: {existing_body}"
    );

    // Non-existing account: identical 200, but NO email dispatched.
    let (missing_status, missing_body) = post(
        port,
        "/auth/email/forgot-password",
        r#"{"email":"nobody@example.com"}"#,
    )
    .await;
    assert_eq!(missing_status, 200, "body: {missing_body}");
    assert!(missing_body.contains("\"ok\":true"), "body: {missing_body}");

    // The recording adapter captured exactly one message — for the real account.
    let sent = recorder.sent();
    assert_eq!(sent.len(), 1, "exactly one reset email expected: {sent:?}");
    assert_eq!(sent[0].to, "member@example.com");
    assert!(sent[0].subject.contains("Reset your password"));

    server.close().await;
}

#[tokio::test]
async fn reset_password_consumes_token_and_rejects_reuse() {
    let (mut server, recorder) = boot().await;
    let port = server.port();

    post(
        port,
        "/auth/email/signup",
        r#"{"email":"reset@example.com","password":"old-password-1"}"#,
    )
    .await;
    post(
        port,
        "/auth/email/forgot-password",
        r#"{"email":"reset@example.com"}"#,
    )
    .await;

    // Pull the raw token out of the captured reset link.
    let sent = recorder.sent();
    let reset_url = &sent[0].text;
    let token = reset_url
        .split("token=")
        .nth(1)
        .and_then(|s| s.split_whitespace().next())
        .expect("token in reset link")
        .to_string();

    // Reset to a new password.
    let (status, body) = post(
        port,
        "/auth/email/reset-password",
        &format!(r#"{{"token":"{token}","password":"brand-new-pass"}}"#),
    )
    .await;
    assert_eq!(status, 200, "reset body: {body}");

    // Old password no longer works; the new one does.
    let (old_status, _) = post(
        port,
        "/auth/email/login",
        r#"{"email":"reset@example.com","password":"old-password-1"}"#,
    )
    .await;
    assert_eq!(old_status, 401, "old password must fail after reset");
    let (new_status, _) = post(
        port,
        "/auth/email/login",
        r#"{"email":"reset@example.com","password":"brand-new-pass"}"#,
    )
    .await;
    assert_eq!(new_status, 200, "new password must work after reset");

    // The reset token is single-use: replaying it is rejected.
    let (reuse_status, reuse_body) = post(
        port,
        "/auth/email/reset-password",
        &format!(r#"{{"token":"{token}","password":"another-pass-99"}}"#),
    )
    .await;
    assert_eq!(
        reuse_status, 400,
        "reused token must be rejected: {reuse_body}"
    );

    server.close().await;
}

#[tokio::test]
async fn reset_password_rejects_unknown_token() {
    let (mut server, _recorder) = boot().await;
    let port = server.port();
    let (status, body) = post(
        port,
        "/auth/email/reset-password",
        r#"{"token":"this-token-was-never-issued","password":"whatever-pass"}"#,
    )
    .await;
    assert_eq!(status, 400, "body: {body}");
    server.close().await;
}

#[tokio::test]
async fn refresh_rotates_and_revoke_works() {
    let (mut server, _recorder) = boot().await;
    let port = server.port();

    // Sign up, then mint a refresh token for the new user. Signup itself does
    // not return a refresh token (the foundation has no refresh split wired to
    // signup), so issue one directly through the store, then exercise the route.
    let (_, signup_body) = post(
        port,
        "/auth/email/signup",
        r#"{"email":"rotate@example.com","password":"correct-horse"}"#,
    )
    .await;
    let user_id = json_string(&signup_body, "userId");
    let device_id = json_string(&signup_body, "deviceId");
    let replica_id = json_string(&signup_body, "replicaId");

    // Seed with the current wall clock so the 30-day TTL hasn't already lapsed
    // by the time the route (which uses `now`) evaluates it.
    let now_ms = i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap();
    let issued = server
        .state
        .store
        .refresh_tokens()
        .issue(
            "rt-seed-token",
            "fam-seed",
            "_default",
            &user_id,
            &device_id,
            &replica_id,
            frick_store::stores::refresh_token::DEFAULT_REFRESH_TTL_SECONDS,
            now_ms,
        )
        .await
        .unwrap();

    // Rotate: a fresh session + a fresh refresh token; the old token is revoked.
    let (status, body) = post(
        port,
        "/auth/refresh",
        &format!(r#"{{"refreshToken":"{}"}}"#, issued.token),
    )
    .await;
    assert_eq!(status, 200, "refresh body: {body}");
    assert!(body.contains("\"sessionToken\""), "body: {body}");
    let next_refresh = json_string(&body, "refreshToken");
    assert_ne!(next_refresh, issued.token, "refresh token must rotate");

    // Replaying the OLD (now-revoked) token is rejected.
    let (replay_status, replay_body) = post(
        port,
        "/auth/refresh",
        &format!(r#"{{"refreshToken":"{}"}}"#, issued.token),
    )
    .await;
    assert_eq!(replay_status, 401, "replay body: {replay_body}");

    // Revoke the fresh token; it can no longer be exchanged.
    let (revoke_status, _) = post(
        port,
        "/auth/refresh/revoke",
        &format!(r#"{{"refreshToken":"{next_refresh}"}}"#),
    )
    .await;
    assert_eq!(revoke_status, 200);
    let (after_revoke_status, _) = post(
        port,
        "/auth/refresh",
        &format!(r#"{{"refreshToken":"{next_refresh}"}}"#),
    )
    .await;
    assert_eq!(after_revoke_status, 401, "revoked token must not refresh");

    server.close().await;
}

#[tokio::test]
async fn forgot_password_throttle_keys_on_email_and_ip() {
    // FR-217: the forgot-password limiter key combines the email AND the client
    // IP, so one attacker IP can exhaust only its own (email, ip) bucket and
    // cannot lock out the victim's own (email, victim-ip) requests. With the
    // default 30/window cap, draining one IP must not 429 a different IP.
    let (mut server, _recorder) = boot().await;
    let port = server.port();

    // Hammer from one IP up to the cap.
    let mut last = 200;
    for _ in 0..40 {
        let (status, _) = post_with_headers(
            port,
            "/auth/email/forgot-password",
            r#"{"email":"victim@example.com"}"#,
            &[("x-forwarded-for", "10.0.0.1")],
        )
        .await;
        last = status;
    }
    assert_eq!(last, 429, "the attacker IP bucket should exhaust to 429");

    // The SAME email from a DIFFERENT IP is still allowed — the buckets are
    // independent, so the victim is not locked out.
    let (victim_status, victim_body) = post_with_headers(
        port,
        "/auth/email/forgot-password",
        r#"{"email":"victim@example.com"}"#,
        &[("x-forwarded-for", "203.0.113.9")],
    )
    .await;
    assert_eq!(
        victim_status, 200,
        "victim from a different IP must not be locked out: {victim_body}"
    );

    server.close().await;
}
