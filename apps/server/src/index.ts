import { createFrickServer } from "./server.js";

export { createFrickServer, defaultDatabasePath, type ServerOptions } from "./server.js";
export {
  createFrickAppRegistry,
  type FrickAppDefinition,
  type FrickAppRegistry,
  type FrickAppResolution,
} from "./apps/registry.js";
export {
  FRAMEWORK_MIGRATIONS,
  FrickMigrationChecksumError,
  FrickMigrationError,
  FrickMigrationRevisionError,
  computeMigrationChecksum,
  listAppliedMigrations,
  runFrameworkMigrations,
  type AppliedMigrationRow,
  type FrameworkMigration,
} from "./storage/migrations.js";
export { FrickResetRefusedError, resetFrickDatabase } from "./storage/reset.js";

const app = createFrickServer();
await app.listen();

console.log(`Frick sync server listening on http://127.0.0.1:${app.port}`);
console.log(`WebSocket sync endpoint ws://127.0.0.1:${app.port}/_frick/sync`);
