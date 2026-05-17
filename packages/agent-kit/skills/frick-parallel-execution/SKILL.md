---
name: frick-parallel-execution
description: Use when splitting Frick app work across multiple agents or sequencing backend, web, iOS, Android, and debugging tasks.
---

# Frick Parallel Execution

Read `docs/frick/spine.md` and `docs/frick/agent-kit/parallel-execution.md` before delegating or splitting work.

Recommended ownership:
- Orchestrator: spine, scope, acceptance criteria, command matrix.
- Backend: schema, server, projections, jobs, blobs, auth, tenancy, migrations.
- Web: React, TypeScript core runtime, browser cache, design-web.
- iOS: Swift DTOs/runtime, cache, push receive, design-swift.
- Android: Kotlin DTOs/runtime, cache, push receive, design module.
- Debugger/reviewer: sync diagnostics, generated drift, cross-platform parity.

Avoid concurrent edits to the same files. Backend lands schema changes and regenerates artifacts before client agents depend on new generated shapes.
