---
name: frick-push-notifications
description: Use when adding or debugging APNs, FCM, web push, push adapters, push receive payloads, deep links, credentials, or delivery telemetry.
---

# Frick Push Notifications

Read `docs/push-adapters.md`, `docs/push-receive.md`, and `docs/operations.md`.

Guidance:
- Register server push adapters through documented extension points. APNs, FCM, and Web Push all have public `@fricken/server` subpath exports today.
- Store APNs/FCM/Web Push per-tenant credentials through documented CLI or operations surfaces. The CLI platform value is `webpush` (lowercase, no capital P).
- Use typed push payloads and deep link routers on clients.
- Preserve encrypted Web Push payload behavior for registrations that include `p256dh` and `auth` keys; registrations without keys keep the empty wake-up fallback.
- Keep delivery telemetry inspectable without making the dashboard a production dependency.

Verify backend adapter behavior and each touched client receive path.
