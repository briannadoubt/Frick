# Frick App Spine

This document is the shared implementation contract for agents working on this app. Keep it current before splitting backend, web, iOS, Android, and debugging work.

## Product Shape

- App name:
- Primary users:
- Core realtime workflow:
- Offline expectations:
- Platforms:

## Schema Spine

- Objects:
- Streams and events:
- Presence rooms:
- Signals:
- Projections:
- Jobs:
- Blobs:
- Search indexes:

## Auth and Tenancy

- Tenant model:
- Session source:
- Permission checks:
- Development login behavior:

## Platform Contracts

- Web:
- TypeScript core:
- iOS:
- Android:
- Push:
- Design tokens:

## Verification

- Schema and generated artifacts: `pnpm schema:generate && pnpm design:generate && pnpm verify:generated`
- TypeScript: `pnpm test && pnpm typecheck`
- Swift: `pnpm swift:test`
- Android: `pnpm android:build`

## Agent Worksplit

- Backend owner:
- Web owner:
- iOS owner:
- Android owner:
- Debugging/parity owner:
