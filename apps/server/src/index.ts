export { createFrickServer, defaultDatabasePath, type FrickAppRoute, type ServerOptions } from "./server.js";
// Async storage seam (FR-118): the SqlDriver interface every store binds to,
// plus the SQLite implementation. Exported so out-of-tree adapters/tests can
// construct stores; the Postgres adapter implements the same interface.
export { SqliteSqlDriver, createSqlDriver, type SqlDriver } from "./storage/sql-driver.js";
// Postgres implementation of the same SqlDriver seam (FR-119).
export {
  PgSqlDriver,
  createPgSqlDriver,
  rewritePlaceholders,
  type CreatePgSqlDriverOptions,
} from "./storage/pg-sql-driver.js";
// Multi-tenant active-tenant switch: re-mint a session into a sibling tenant.
export {
  SourceSessionNotActiveError,
  deriveSiblingSession,
  type DeriveSiblingSessionOptions,
} from "./auth/session-derive.js";
export type { CreateSessionInput, StoredSession } from "./storage/session-store.js";
// App-route helper kit: the glue every `appRoutes` handler otherwise rewrites
// (CORS, JSON I/O, :param matching, bearer→session principal auth).
export {
  DEFAULT_MAX_JSON_BODY_BYTES,
  JsonBodyTooLargeError,
  authenticateRequest,
  handlePreflight,
  matchPath,
  readJsonBody,
  sendJson,
  setCors,
  type AppRouteCorsOptions,
  type ReadJsonBodyOptions,
} from "./app-routes/kit.js";
// Extension-authoring types: the symbols apps need to author the
// `policyHooks` and `blobProcessors` they pass to `createFrickServer`.
// Referenced by `ServerOptions` but otherwise internal — surfaced here so
// hosts can type their hooks directly instead of indexing into `ServerOptions`.
export {
  ALLOW,
  deny,
  type FrickAction,
  type FrickDecision,
  type FrickDecisionReason,
  type FrickPolicyHook,
  type FrickPolicyInput,
  type Principal,
} from "./authz.js";
export {
  makeRbacPolicyHook,
  type RbacMatrix,
  type RbacResourceRule,
} from "./authz/rbac.js";
export {
  type FrickBlobProcessContext,
  type FrickBlobProcessResult,
  type FrickBlobProcessor,
  type FrickBlobProcessorRegistry,
  type FrickBlobValidateContext,
  type FrickBlobValidationResult,
} from "./blobs/processor.js";
export {
  DEFAULT_MAX_IMAGE_BYTES,
  imageBlobProcessor,
  sniffImageFormat,
  type ImageBlobProcessorOptions,
  type ImageFormat,
} from "./blobs/image-processor.js";
export {
  type FrickJobContext,
  type FrickJobHandler,
  type FrickJobRegistry,
  type FrickJobResult,
} from "./jobs/registry.js";
export {
  createFrickRecurringRegistry,
  eachTenant,
  RECURRING_MIN_INTERVAL_MS,
  type EachTenantOptions,
  type FrickRecurringJob,
  type FrickRecurringRegistry,
} from "./jobs/recurring.js";
export {
  createFrickProjectionRegistry,
  type FrickProjection,
  type FrickProjectionContext,
  type FrickProjectionHandler,
  type FrickProjectionRegistry,
  type FrickProjectionSource,
  type FrickProjectionSourceObject,
  type FrickProjectionSourceStream,
  type FrickProjectionWriteEvent,
  type ProjectionApplyResult,
  type ProjectionChange,
  type ProjectionDeltaNotice,
} from "./projections/registry.js";
export {
  listProjectionObjects,
  projectionSourceObjectTypes,
  singleChange,
} from "./projections/helpers.js";
export {
  PUSH_REVOCATION_ERROR_CODES,
  isPushRevocationError,
  type FrickNotificationContext,
  type FrickNotificationIntent,
  type FrickPushAdapter,
  type FrickPushDelivery,
  type PushDeviceRegistration,
  type PushPlatform,
} from "./push/types.js";
export {
  createFrickApnsAdapter,
  signApnsJwt,
  type ApnsAdapterOptions,
  type FrickApnsAdapter,
} from "./push/apns-adapter.js";
export {
  createFrickFcmAdapter,
  type FcmAdapterOptions,
  type FrickFcmAdapter,
} from "./push/fcm-adapter.js";
export {
  createFrickWebPushAdapter,
  validateWebPushRegistrationToken,
  type WebPushAdapterOptions,
  type FrickWebPushAdapter,
} from "./push/web-push-adapter.js";
export {
  APNS_SETTINGS_KEY,
  FCM_SETTINGS_KEY,
  WEB_PUSH_SETTINGS_KEY,
  encryptCredential,
  decryptCredential,
  loadApnsCredentials,
  loadFcmCredentials,
  loadWebPushCredentials,
  saveApnsCredentials,
  saveFcmCredentials,
  saveWebPushCredentials,
  type ApnsCredentials,
  type FcmCredentials,
  type PushCredentialError,
  type WebPushCredentials,
} from "./push/credentials.js";
export {
  type FrickEmailAdapter,
  type FrickEmailContext,
  type FrickEmailDelivery,
  type FrickEmailMessage,
} from "./email/types.js";
export {
  createFrickEmailRouter,
  type FrickEmailRouter,
  type FrickEmailRouterOptions,
  type PasswordResetEmailOptions,
  type VerificationEmailOptions,
} from "./email/router.js";
export {
  createFrickResendEmailAdapter,
  type FrickResendEmailAdapter,
  type ResendAdapterOptions,
} from "./email/resend-adapter.js";
export {
  createFrickTestEmailAdapter,
  type FrickTestEmailAdapter,
} from "./email/test-adapter.js";
export {
  ACCOUNT_EXPORT_REDACTED_SENSITIVITIES,
  DEFAULT_OWNER_FIELDS,
  buildAccountExportBase,
  type AccountExport,
  type AccountExportBase,
  type AccountExportOptions,
  type OnAccountExport,
} from "./compliance/account-export.js";
export {
  deleteAccountData,
  type AccountDeleteOptions,
  type AccountDeleteResult,
  type OnAccountDelete,
} from "./compliance/account-delete.js";
export {
  FrickStore,
  type StoreOptions,
  type FrickStoreWriteEvent,
  type FrickStoreWriteListener,
} from "./store.js";
export { createNoopLogger, type FrickLogger } from "./logger.js";
export {
  type IdentityProvidersConfig,
  type AppleProviderConfig,
  type EmailProviderConfig,
  type EmailOutboundConfig,
  type EmailWelcomeConfig,
  type PasswordResetRequest,
  type GoogleProviderConfig,
  type UserObjectMapping,
  type OnFirstSignIn,
  type OnFirstSignInInput,
  type OnFirstSignInResult,
  type OnRevoke,
  type OnRevokeInput,
} from "./auth/identity-routes.js";
export {
  type OidcProviderConfig,
  type OidcClaimMappings,
  type OidcProviderRuntime,
  type VerifiedOidcIdentity,
  type VerifyOidcOptions,
  type OidcDiscoveryDocument,
} from "./auth/oidc.js";
export {
  createFrickAppRegistry,
  type FrickAppDefinition,
  type FrickAppRegistry,
  type FrickAppResolution,
} from "./apps/registry.js";
export {
  MemoryClusterBus,
  MemoryClusterChannel,
  type ClusterEnvelope,
  type ClusterEnvelopeHandler,
  type FrickClusterBus,
  type MemoryClusterBusOptions,
  type NodeId,
} from "./cluster/bus.js";
export {
  createFrickProjectModule,
  projectModuleToAppDefinition,
  type FrickProjectManifest,
  type FrickProjectModule,
  type FrickProjectModuleInput,
} from "./platform/project.js";
export {
  FRAMEWORK_MIGRATIONS,
  FRAMEWORK_TABLES,
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
  TenantAlreadyExistsError,
  TenantStore,
  type TenantRow,
} from "./storage/tenant-store.js";
export { TenantSettingsStore } from "./storage/tenant-settings-store.js";
export {
  loadFrickConfig,
  FrickConfigError,
  type FrickConfig,
  type FrickConfigOverrides,
  type FrickEnv,
  type FrickLogLevel,
  type FrickDbDriver,
  type FrickBlobDriver,
  type FrickPlatformEventsDriver,
} from "./config.js";
export {
  dumpFrickDatabase,
  type FrickDumpHeader,
  type FrickDumpOptions,
} from "./backup/dump.js";
export {
  FrickRestoreRefusedError,
  restoreFrickDatabase,
  type FrickRestoreOptions,
  type FrickRestoreReport,
} from "./backup/restore.js";
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
