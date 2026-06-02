# Security policy

## Supported versions

Frick is pre-1.0. The latest tagged release on `main` is the only supported version; security fixes are not backported. The schema-identity surface (`schemaId`, `protocolVersion`, `schemaRevision`, `hash`, error envelope) is stable across minor versions — everything else may change.

## Reporting a vulnerability

**Please report security issues privately.** Do not open a public GitHub issue, send a tweet, or post in a chat channel until a fix is shipped.

The preferred channel is the GitHub **Security Advisories** form for this repository (Security → Report a vulnerability). The maintainer is the only recipient; the report stays private until disclosure.

If GitHub Security Advisories is unavailable, email `bri@briannadoubt.com` with the subject `[Frick security]`. PGP is not required; if you want an encrypted channel, request a key in the first message and one will be provided before the substantive report is exchanged.

Please include:

- A description of the issue and the conditions required to trigger it.
- The affected component (server / protocol / native SDK / CLI / demo app) and the commit hash or tag you tested against.
- A proof-of-concept if you have one — minimal repro scripts are ideal.
- Whether you intend to disclose publicly, and on what timeline.

## What to expect

| Step | Target |
|---|---|
| Initial acknowledgement | within 3 business days |
| Triage decision (accept / reject / need more info) | within 7 business days of acknowledgement |
| Fix and patch release | within 30 days of triage for high-severity issues; longer for low-severity once a workaround is documented |
| Public disclosure | coordinated with the reporter; typically a CVE plus a release-notes entry once a fix is available |

Maintainers may credit reporters by name in release notes unless the reporter prefers to stay anonymous.

## Scope

In scope:

- The `@fricken/server` package (auth, tenant isolation, sync gateway, admin routes, storage).
- The `@fricken/protocol` wire format and schema identity contract.
- The native client SDKs (`packages/swift`, `apps/android/frick`) — credential handling, certificate validation, cache integrity.
- The `@fricken/cli` package, especially the `tenants set-push` credential-wrapping path.
- The push adapter modules (`apps/server/src/push/*`) — credential storage, JWT signing, transport.

Out of scope (please don't submit reports for these):

- Vulnerabilities in third-party dependencies — report those upstream. We monitor advisories via `pnpm audit` in CI and pick up patched versions on the next release.
- The demo apps under `apps/web`, `apps/ios/FrickDemo`, `apps/android/app`. They exist to exercise the framework, not to ship to end users.
- Issues that require physical access to a developer workstation, or that depend on a misconfigured `FRICK_PUSH_CRED_KEY` (e.g. the env var is empty in production — that's an operator error, and the framework already returns `push.credentials.disabled` rather than silently downgrading).
- Operational deployment choices that are documented as such in `docs/operations.md` and `docs/threat-model.md`.

## Hall of fame

Reporters who have helped harden Frick will be listed here once a vulnerability has been triaged and fixed.

_Empty so far._
