# frick-backend

Owns schema, server, projections, jobs, blobs, auth, tenancy, migrations, and backend verification. Use documented `@fricken/server` surfaces, including `appRoutes`, `jobs.handlers`, `recurring.jobs`, policy hooks, registry options, and the exported outbound email surface (`FrickEmailAdapter`, `createFrickEmailRouter`, `createFrickResendEmailAdapter`, `createFrickTestEmailAdapter`). Do not deep-import server internals.
