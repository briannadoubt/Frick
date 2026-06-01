# Push notification adapters

Frick currently has three push adapter implementations:

| Adapter | Module | Platform |
|---|---|---|
| APNs | public subpath `@frick/server/push/apns-adapter`; source at [`apps/server/src/push/apns-adapter.ts`](../apps/server/src/push/apns-adapter.ts) | `apns` |
| FCM (v1) | public subpath `@frick/server/push/fcm-adapter`; source at [`apps/server/src/push/fcm-adapter.ts`](../apps/server/src/push/fcm-adapter.ts) | `fcm` |
| Web Push | public subpath `@frick/server/push/web-push-adapter`; source at [`apps/server/src/push/web-push-adapter.ts`](../apps/server/src/push/web-push-adapter.ts) | `webPush` |

All adapters conform to [`FrickPushAdapter`](../apps/server/src/push/types.ts) and slot into the existing notification router, job framework, and dead-token revocation paths. They only handle the platform-specific encoding + transport step — fan-out, retries, and registration tombstoning live in the router.

All three adapters are documented package exports and have CLI credential workflows today. Web Push registration tokens are accepted by the server and validated as PushSubscription JSON. The Web Push adapter encrypts the notification payload per RFC 8291 (`aes128gcm` content encoding, RFC 8188) when the subscription carries the browser's `p256dh` + `auth` keys; older registrations without those keys keep the backward-compatible empty-body wake-up path.

The framework's in-memory `TestPushAdapter` ships unchanged for local development and tests.

## How push delivery flows end-to-end

```
app code
  └─ enqueueIntent(FrickNotificationIntent)        ← apps/server/src/push/router.ts
       └─ jobs.enqueue({ jobType: "push.deliver", … })
            └─ job worker picks up row
                 └─ router.handler(ctx) decodes intent and calls deliver()
                      └─ for each (recipient userId × active registration):
                           └─ adapter = registry.resolveAdapter(registration.platform)
                                └─ adapter.send(intent, registration, ctx)
                                     ├─ delivered  → pushRegistrations.touch(...)
                                     ├─ failed (revocation code) → pushRegistrations.revoke(...)
                                     └─ devtoolsEvents.record({ kind: "frick.push.delivery", … })
```

`status: "skipped"` is the right outcome when an adapter has nothing to send (no credentials, no matching environment); the job still completes successfully. The router only fails the job when its own bookkeeping fails — partial delivery is intentional, since reattempting would multiply successful deliveries.

## Registering the adapters at server boot

```ts
import { createFrickServer } from "@frick/server";
import { createFrickApnsAdapter } from "@frick/server/push/apns-adapter";
import { createFrickFcmAdapter } from "@frick/server/push/fcm-adapter";
import { createFrickWebPushAdapter } from "@frick/server/push/web-push-adapter";

const apns = createFrickApnsAdapter();
const fcm = createFrickFcmAdapter();
const webPush = createFrickWebPushAdapter();

const server = createFrickServer({
  push: {
    adapters: [apns, fcm, webPush],
    // The default test adapter is still registered for the "test" platform.
    // Apps that want to fully replace it can pass their own here.
  },
});

await server.listen();

// On shutdown, close the APNs HTTP/2 sessions so the process exits cleanly.
process.on("SIGTERM", async () => {
  await apns.close();
  await server.close();
});
```

The adapters resolve per-tenant credentials at delivery time via `ctx.store.tenantSettings`. There is no per-tenant *adapter instance* — one global APNs adapter handles every tenant, with cached HTTP/2 sessions and JWTs keyed by `(tenantId, endpoint)` and `(tenantId, keyId)` respectively. FCM is the same: one global adapter, OAuth2 access tokens cached per `(tenantId, clientEmail)`. The Web Push implementation signs VAPID JWTs per endpoint origin and encrypts the notification payload per RFC 8291 when the subscription carries browser keys.

## Encrypted Web Push payloads (RFC 8291)

When a `PushSubscription` registration includes the browser's `keys.p256dh`
(the user agent's uncompressed P-256 public point, base64url) and `keys.auth`
(a 16-byte secret, base64url), the Web Push adapter encrypts the notification
content end-to-end so the push service never sees plaintext. The encrypted
blob is delivered with `Content-Encoding: aes128gcm`; the Service Worker's
`push` event receives the decrypted JSON (`{ intent, title, body, data,
threadId, deepLink }`).

The adapter follows RFC 8291 (Message Encryption for Web Push) with the
`aes128gcm` content encoding from RFC 8188:

1. Generate an ephemeral P-256 keypair (`node:crypto` ECDH `prime256v1`) and
   run ECDH against the subscription's `p256dh` to get the shared secret.
2. HKDF-SHA-256 the shared secret keyed by the `auth` secret as salt, with
   `info = "WebPush: info\0" || ua_public || as_public`, to derive the input
   keying material.
3. Generate a random 16-byte content-encoding salt and HKDF-derive the
   16-byte AES-128-GCM key (`info = "Content-Encoding: aes128gcm\0"`) and the
   12-byte nonce (`info = "Content-Encoding: nonce\0"`).
4. AES-128-GCM encrypt a single record: `plaintext || 0x02` (the last-record
   delimiter), no further padding.
5. Frame the request body as the RFC 8188 header
   `salt(16) || rs(4, big-endian) || idlen(1) || keyid` followed by the
   ciphertext, where `keyid` is the uncompressed ephemeral server public key.

A fresh ephemeral keypair and salt are used on every send. The encrypted body
is capped at 4096 octets (RFC 8291); an over-cap payload returns
`push.payloadTooLarge` without dispatching. Registrations whose subscription
omits `p256dh`/`auth` still send an empty body (the pre-FR-60 wake-up path).
Multi-key rotation for the encryption material is out of scope here (FR-61).

The `encryptWebPushPayload(payload, p256dh, auth)` helper is exported from
`@frick/server/push/web-push-adapter` for callers that need to build the body
directly.

## Required environment variable

Per-tenant credentials are stored in the `tenant_settings` table wrapped with AES-256-GCM. The encryption key is sourced from:

```sh
export FRICK_PUSH_CRED_KEY=$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64"))')
```

When `FRICK_PUSH_CRED_KEY` is unset (or not a base64-encoded 32-byte value):

- The CLI's `tenants set-push` command refuses to encrypt — it surfaces `push.credentials.disabled`.
- The adapters return `status: "skipped"` deliveries with the same code, so a misconfigured deploy doesn't silently downgrade to plaintext.

Key rotation: change the env var, then `tenants set-push` every tenant again. Multi-key decryption (overlap windows) is not implemented yet — file a follow-up if you need it.

## Setting per-tenant credentials

### APNs

You need: the `.p8` key file from Apple Developer, the 10-character key id, your 10-character team id, and the bundle id of the iOS app.

```sh
frick tenants set-push tenant-acme \
  --platform apns \
  --p8 ./AuthKey_ABCD123456.p8 \
  --key-id ABCD123456 \
  --team-id TEAM12345 \
  --bundle-id com.acme.app
```

Add `--sandbox` to target `api.sandbox.push.apple.com` instead of production. Useful when ops haven't cut over production certs yet.

### FCM

You need: a Firebase service-account JSON file with the **Firebase Admin SDK** or **firebase-messaging.send** role. Download it from Project Settings → Service Accounts → Generate New Private Key.

```sh
frick tenants set-push tenant-acme \
  --platform fcm \
  --service-account ./firebase-svc-account.json
```

The CLI reads `project_id`, `client_email`, and `private_key` out of the service-account JSON and discards the rest. The wrapped envelope is stored under `tenant_settings.push.fcm.encrypted`.

### Web Push

You need: a VAPID keypair and a contact subject. The subject must be a
`mailto:` or `https://` URI. The public key is the base64url VAPID application
server key (the `k=` parameter the adapter sends); the private key is the
PEM-encoded EC (P-256) private key the adapter signs the VAPID JWT with.

```sh
frick tenants set-push tenant-acme \
  --platform webpush \
  --subject mailto:ops@acme.com \
  --public-key BJ...base64url... \
  --private-key ./vapid-private.pem
```

The CLI reads the private key from the `--private-key` file (key material is
not echoed) and stores the wrapped envelope under
`tenant_settings.push.webPush.encrypted`. The server accepts
`platform: "webPush"` registrations when the registration token is JSON for a
public HTTPS `PushSubscription`.

## Observability

Every fan-out attempt writes a row to the DevTools event feed:

```json
{
  "kind": "frick.push.delivery",
  "tenantId": "tenant-acme",
  "fields": {
    "intent": "message.new",
    "platform": "apns",
    "registrationId": "reg-…",
    "userId": "user-…",
    "status": "delivered",
    "receiptId": "apns-…"
  }
}
```

Query them via `/_frick/inspect/devtools/events?kind=frick.push.delivery&tenantId=tenant-acme` (inspection-auth scoped). Same retention policy as every other DevTools event.

## Error codes returned to callers

The adapters normalize platform-specific failures onto a stable set of codes:

| Code | Source | Router behavior |
|---|---|---|
| `push.unregistered` | APNs 410 / FCM `UNREGISTERED` / Web Push 404 or 410 | **Revokes** the registration |
| `push.badDeviceToken` | APNs `BadDeviceToken` / FCM `INVALID_ARGUMENT` / `SENDER_ID_MISMATCH` / invalid Web Push subscription JSON | **Revokes** the registration |
| `push.tokenExpired` | APNs `ExpiredProviderToken` | **Revokes** the registration |
| `push.rateLimited` | APNs 429 / FCM `QUOTA_EXCEEDED` / FCM 429 / Web Push 429 | Surfaced; not revoked |
| `push.serverError` | APNs 5xx / FCM 5xx / Web Push 5xx | Surfaced; not revoked |
| `push.payloadTooLarge` | APNs 413 / Web Push 413 | Surfaced; not revoked |
| `push.deliveryFailed` | Anything else | Surfaced; not revoked |
| `push.credentials.missing` | No `tenant_settings` row | Adapter returns `skipped` |
| `push.credentials.disabled` | `FRICK_PUSH_CRED_KEY` unset/invalid | Adapter returns `skipped` |
| `push.credentials.corrupt` | AES-GCM auth-tag mismatch | Adapter returns `skipped` |
| `push.tokenExchangeFailed` | FCM OAuth2 token endpoint returned non-2xx | Surfaced as `failed` |

Apps that want different revocation behavior can subclass the adapter or supply their own — the router treats every adapter identically.

## Threat model notes

- **At rest:** credentials are AES-256-GCM ciphertext. Anyone with read access to `tenant_settings` plus `FRICK_PUSH_CRED_KEY` can decrypt; without the key, the ciphertext is opaque.
- **In transit:** APNs uses TLS via HTTP/2; FCM and Web Push use TLS via HTTPS. The adapters don't pin certificates. Web Push payloads are additionally encrypted end-to-end per RFC 8291 (`aes128gcm`) so the push service relays opaque ciphertext — only the subscribing browser, holding the `p256dh` private key + `auth` secret, can decrypt.
- **In memory:** decrypted credentials live on the adapter's HTTP/2 session cache (APNs), in the closure of the JWT signer (FCM), or in the Web Push VAPID signing path. They are not written to logs.
- **JWTs:** APNs JWTs are signed with the tenant's `.p8`; FCM service-account JWTs are short-lived (1 hour) and used only to obtain a longer-lived OAuth2 access token; Web Push VAPID JWTs are cached per public key and endpoint origin. Tokens are not persisted.

Operators rotating credentials should call `tenants set-push` again with the new material; the adapters will swap to the new JWT on the next refresh window (no restart required for FCM; APNs needs the cached JWT to expire, which happens within ~50 minutes).
