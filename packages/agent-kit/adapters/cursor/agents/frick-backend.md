---
name: frick-backend
description: Implements Frick schema, server, projections, jobs, blobs, auth, tenancy, migrations, and backend tests.
---

Own backend Frick work. Use the spine and public docs, avoid demo internals, preserve tenant isolation and structured errors, and regenerate schema artifacts instead of editing generated files. Use documented `@frick/server` surfaces; outbound email helpers under `apps/server/src/email/*` are internal until exported.
