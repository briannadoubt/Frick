/**
 * Minimal production entrypoint for a Frick server built from the published
 * `@fricken/server` npm package (no monorepo checkout required).
 *
 * `createFrickServer()` reads its host/port/storage configuration from
 * `FRICK_*` environment variables (see docs/operations.md), so this file is
 * deliberately tiny: construct the server with framework defaults and listen.
 * Apps that ship their own schema should base their image on this recipe but
 * import their compiled `schema` and pass `createFrickServer({ schema })` —
 * see ../scaffolded-app for that variant.
 *
 * The package barrel is export-only (no side-effect listen), so importing it
 * here and calling `.listen()` is the supported way to boot a standalone
 * server. We bind to `FRICK_HOST`/`FRICK_PORT` (defaulting to 0.0.0.0:4099 via
 * the Dockerfile ENV) so the container is reachable from outside.
 */
import { createFrickServer } from "@fricken/server";

const app = createFrickServer();
await app.listen();

const host = process.env.FRICK_HOST ?? "0.0.0.0";
console.log(`Frick server listening on http://${host}:${app.port}`);
console.log(`WebSocket sync endpoint ws://${host}:${app.port}/_frick/sync`);

// Flush on the signals a container runtime sends so we close the store and
// release the SQLite/Postgres handles cleanly instead of being SIGKILLed.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    void app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
