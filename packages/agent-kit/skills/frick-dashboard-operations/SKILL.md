---
name: frick-dashboard-operations
description: Use when working with Frick health, readiness, inspection, local dashboard, doctor, migrations, backup, restore, tenants, or operational CLI flows.
---

# Frick Dashboard and Operations

Read `docs/operations.md` and `apps/cli/README.md`.

Guidance:
- Keep `apps/dev-dashboard` static and local-only.
- Use documented health, readiness, and inspection surfaces.
- Do not create a second operational API for dashboard-only behavior.
- Preserve JSON output shapes for CLI commands so agents can parse them.

Common commands: `pnpm cli doctor`, `pnpm cli inspect server`, `pnpm dashboard`, `pnpm cli migrate status`.
