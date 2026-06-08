/**
 * App boundary constants for the Frick framework (FR-6 epic, FR-37).
 *
 * `app_id` is the second storage-partitioning axis alongside `tenant_id`
 * (see `./tenant.ts`). Where `tenantId` partitions data *within* a single
 * app, `appId` partitions data *across* the distinct apps a multi-app server
 * hosts — apps that today are routed only by URL prefix / WebSocket Hello
 * schema id, with storage server-SHARED. Every framework storage table carries
 * an `app_id` column (migration `0021_app_boundary`, FR-36); the per-store
 * layer filters reads by it and stamps writes with it (FR-37), so an app can
 * neither read nor write another app's objects, streams, or jobs.
 *
 * The default deployment is implicitly single-app — all legacy rows and every
 * caller that does not specify an app live in the {@link DEFAULT_APP_ID} app,
 * so existing single-app servers behave byte-for-byte identically.
 *
 * App ids are arbitrary opaque strings, resolved at the request boundary from
 * the same place the schema id / URL prefix is (mirroring how `tenantId` is
 * resolved from the session principal).
 */
export const DEFAULT_APP_ID = "_default";

/**
 * Validate that an app id, if supplied, is a well-formed opaque string, and
 * collapse empty/missing values to {@link DEFAULT_APP_ID}. Mirrors
 * {@link import("./tenant.js").normalizeTenantId} exactly so the two axes
 * share one normalization contract.
 */
export function normalizeAppId(value: unknown): string {
  if (value === undefined || value === null) {
    return DEFAULT_APP_ID;
  }
  if (typeof value !== "string") {
    throw new Error("appId must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return DEFAULT_APP_ID;
  }
  if (trimmed.length > 64) {
    throw new Error("appId must be at most 64 characters");
  }
  if (!/^[A-Za-z0-9_.:-]+$/.test(trimmed)) {
    throw new Error("appId must contain only letters, digits, '_', '.', ':', or '-'");
  }
  return trimmed;
}
