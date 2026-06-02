/**
 * Dev entry: spins up a Frick server with the empty foundation schema and
 * default config. Used by `pnpm server` in the Frick monorepo. The package's
 * public barrel (`./index.ts`) is exports-only so that downstream apps can
 * `import { createFrickServer } from "@fricken/server"` without triggering a
 * side-effect listen.
 */
import { createFrickServer } from "./server.js";

const app = createFrickServer();
await app.listen();

console.log(`Frick sync server listening on http://127.0.0.1:${app.port}`);
console.log(`WebSocket sync endpoint ws://127.0.0.1:${app.port}/_frick/sync`);
