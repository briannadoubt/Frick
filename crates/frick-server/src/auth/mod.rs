//! Third-party identity-provider auth (FR-269): Sign in with Apple / Google
//! id-token verification login.
//!
//! - [`verify`] — the SECURITY-CRITICAL RS256 id-token verifier (alg-pinned,
//!   `iss`/`aud`/`exp`/`nonce` validated), built over the pure-Rust `rsa` crate.
//! - [`jwks`] — the [`jwks::JwksProvider`] seam: a `reqwest`-backed cached
//!   fetcher for production, an injectable fixed key set for tests.
//! - [`routes`] — `POST /auth/apple/verify`, `/auth/google/verify`,
//!   `/auth/apple/notifications`, sharing the email-auth find-or-create +
//!   session-mint pattern.
//!
//! The built-in password / email-auth routes live in
//! [`crate::auth_routes`]; this module layers the provider routes on top.

pub mod jwks;
pub mod routes;
pub mod verify;

pub use jwks::{FixedJwksProvider, Jwks, JwksProvider, ReqwestJwksProvider, RsaJwk};
pub use routes::{SharedJwksProvider, provider_auth_router};
pub use verify::{VerifiedIdentity, VerifyError, VerifyParams, verify_id_token};
