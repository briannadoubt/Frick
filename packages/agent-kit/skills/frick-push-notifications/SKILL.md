---
name: frick-push-notifications
description: Use when adding or debugging APNs, FCM, web push, push adapters, push receive payloads, deep links, credentials, or delivery telemetry.
---

# Frick Push Notifications

Read `docs/push-adapters.md`, `docs/push-receive.md`, and `docs/operations.md`.

Guidance:
- Register server push adapters through documented extension points. APNs and FCM have public `@frick/server` subpath exports today; Web Push adapter code exists but is not yet a documented package export.
- Store APNs/FCM per-tenant credentials through documented CLI or operations surfaces. Do not tell scaffolded apps to use `frick tenants set-push --platform webPush`; that CLI path is not implemented yet.
- Use typed push payloads and deep link routers on clients.
- Keep delivery telemetry inspectable without making the dashboard a production dependency.

Verify backend adapter behavior and each touched client receive path.
