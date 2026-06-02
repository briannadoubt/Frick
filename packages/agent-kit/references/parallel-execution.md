# Frick Parallel Execution

Parallel agents work safely when every worker reads `docs/frick/spine.md` and owns a disjoint surface.

Use this split for fullstack app work:

- Orchestrator: updates the spine, decides scope, keeps commands and acceptance criteria visible.
- Backend: schema, server wiring, projections, jobs, blobs, auth, tenancy, migrations.
- Web: React UI, `@fricken/react`, `@fricken/core`, browser cache behavior, design-web.
- iOS: Swift DTOs, Swift runtime, cache reset behavior, push receive, design-swift.
- Android: Kotlin DTOs, runtime, StateFlow sync state, push receive, design module.
- Debugger/reviewer: sync diagnostics, generated drift, cross-platform parity, release gates.

Workers should not edit the same files in parallel. If a schema change is required, backend updates the spine first, regenerates artifacts, and client workers consume the new generated shape.
