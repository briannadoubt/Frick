---
name: frick-push-notifications
description: Use when adding or debugging APNs, FCM, web push, push adapters, push receive payloads, deep links, credentials, or delivery telemetry.
---

# Frick Push Notifications

Read `docs/push-adapters.md`, `docs/push-receive.md`, and `docs/operations.md`.

Guidance:
- Register server push adapters through documented extension points.
- Store per-tenant credentials through documented CLI or operations surfaces.
- Use typed push payloads and deep link routers on clients.
- Keep delivery telemetry inspectable without making the dashboard a production dependency.

Verify backend adapter behavior and each touched client receive path.
