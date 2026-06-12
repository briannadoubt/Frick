# Enterprise SSO (SAML) via an OIDC broker

Frick does **not** terminate SAML inside `frick-server`, and that is a deliberate
security decision, not a gap. SAML's signature path (XML canonicalization +
signature-wrapping defenses) is the single most dangerous authentication surface
to own in-process — the failure mode is "an attacker forges an assertion and
signs in as anyone," and it would also drag two native C dependencies
(OpenSSL + libxml2/xmlsec1) into the otherwise pure-Rust, rustls-only server.

Instead, Frick supports enterprise SAML SSO the way hardened app servers
should: **put a battle-tested SAML→OIDC broker in front, and have Frick consume
the OIDC token it issues.** Frick already has a security-reviewed generic OIDC
verifier (`POST /auth/oidc/:id/verify`), so this needs **no new server code** —
only configuration.

```
┌──────────────┐   SAML    ┌─────────────────────┐   OIDC id_token   ┌────────────┐
│ Corporate    │ ────────▶ │ Broker              │ ────────────────▶ │ frick      │
│ SAML IdP     │           │ (Dex / Keycloak /   │                   │ -server    │
│ (Okta/ADFS/…)│ ◀──────── │  Auth0 / Okta …)    │   /auth/oidc/:id  │            │
└──────────────┘           └─────────────────────┘                   └────────────┘
```

The broker owns c14n / XSW / certificate trust — code that is independently
audited and maintained — and emits a standard OIDC `id_token`. Frick verifies
that token with the same RS256 / JWKS / `iss` / `aud` / `exp` / nonce checks it
applies to Sign in with Apple, Google, and any other OIDC provider.

## 1. Run a broker that bridges SAML → OIDC

Any of these work; pick the one your org already runs. A minimal
[Dex](https://dexidp.io) example connecting a corporate SAML IdP and issuing
OIDC to Frick:

```yaml
# dex-config.yaml
issuer: https://dex.example.com

storage:
  type: sqlite3
  config: { file: /var/dex/dex.db }

connectors:
  - type: saml
    id: corp
    name: Corp SSO
    config:
      ssoURL: https://idp.example.com/app/sso/saml
      ca: /etc/dex/idp-ca.pem        # the IdP's signing certificate
      redirectURI: https://dex.example.com/callback
      usernameAttr: name
      emailAttr: email
      entityIssuer: https://dex.example.com/callback

# The OIDC client Frick's app authenticates the user as.
staticClients:
  - id: frick
    name: Frick
    secret: ${FRICK_OIDC_CLIENT_SECRET}
    redirectURIs:
      - https://app.example.com/auth/callback

oauth2:
  skipApprovalScreen: true
```

Keycloak (add a SAML Identity Provider + an OIDC client), Auth0, and Okta expose
the same SAML-in / OIDC-out shape — the broker's `issuer` + JWKS URL + the client
id are all you need from this step.

## 2. Point Frick at the broker

Register the broker as an OIDC provider via `FRICK_OIDC_PROVIDERS` (a JSON
array). The `audiences` must include the OIDC **client id** the broker mints
tokens for (`frick` above):

```bash
FRICK_OIDC_PROVIDERS='[
  {
    "id": "corp",
    "issuer": "https://dex.example.com",
    "audiences": ["frick"],
    "jwksUri": "https://dex.example.com/keys"
  }
]'
```

An unconfigured provider id returns `404 providerNotConfigured`, and an
`audiences` list is required — Frick never accepts an unaudienced token.

## 3. The client flow

1. The Frick client runs the standard **OIDC authorization-code + PKCE** flow
   against the broker (`https://dex.example.com`), with a fresh `nonce`. The
   broker redirects the user through the corporate SAML login and returns an
   `id_token`.
2. The client `POST`s the token to Frick:

   ```http
   POST /auth/oidc/corp/verify
   Content-Type: application/json

   { "idToken": "<the broker's id_token>", "nonce": "<the same nonce>" }
   ```
3. Frick verifies the token (RS256 pinned, `iss` = the broker, `aud` ∈
   `audiences`, `exp`, and the matching `nonce`), finds-or-creates the account
   keyed by the provider-scoped subject `oidc:corp:<sub>`, and returns a Frick
   session — identical to every other OIDC login.

That is the whole integration: a broker container and one `FRICK_OIDC_PROVIDERS`
entry give you enterprise SAML SSO with no SAML code, no native crypto
dependencies, and no new authentication-bypass surface in the server.

## When in-process SAML would be reconsidered

If a deployment genuinely cannot run a broker (rare; usually an air-gapped or
strict-compliance constraint), in-process SAML would be added behind an
**optional `saml` cargo feature** backed by the audited `xmlsec1` library, so
the default build, Docker image, and CI stay pure-Rust and the native
dependencies are opt-in — plus a dedicated signature-wrapping security review.
That work is tracked on the FR-280 ticket and is not planned by default.
