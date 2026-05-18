import { createFrickServer } from "./server.js";

export { createFrickServer, defaultDatabasePath, type ServerOptions } from "./server.js";
export {
  createFrickAppRegistry,
  type FrickAppDefinition,
  type FrickAppRegistry,
  type FrickAppResolution,
} from "./apps/registry.js";
export {
  createFrickProjectModule,
  projectModuleToAppDefinition,
  type FrickProjectManifest,
  type FrickProjectModule,
  type FrickProjectModuleInput,
} from "./platform/project.js";
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
export {
  createFrickTelemetryRuntime,
  createNoopTelemetryRuntime,
  type FrickHttpTelemetryRequest,
  type FrickHttpTelemetryResult,
  type FrickHttpTelemetrySpan,
  type FrickJobTelemetryResult,
  type FrickJobTelemetryRun,
  type FrickJobTelemetrySpan,
  type FrickTelemetryRuntime,
  type FrickWebSocketCloseCategory,
  type FrickWebSocketConnectionTelemetry,
  type FrickWebSocketConnectionTelemetryPrincipal,
  type FrickWebSocketConnectionTelemetryResult,
  type FrickWebSocketConnectionTelemetrySpan,
  type FrickWebSocketFrameTelemetry,
} from "./telemetry/runtime.js";

const app = createFrickServer();
await app.listen();

console.log(`Frick sync server listening on http://127.0.0.1:${app.port}`);
console.log(`WebSocket sync endpoint ws://127.0.0.1:${app.port}/_frick/sync`);
