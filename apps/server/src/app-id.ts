/**
 * App boundary constants for the Frick framework (FR-6 epic, FR-37).
 *
 * `app_id` is the second storage-partitioning axis alongside `tenant_id`
 * (see `./tenant.ts`). Where `tenantId` partitions data *within* a single
 * app, `appId` partitions data *across* the distinct apps a multi-app server
 * hosts — apps that today are routed only by URL prefix / WebSocket Hello
 * schema id, with storage server-SHARED. Every framework storage table carries
 * an `app_id` column (migration `0021_app_boundary`, FR-36); the per-store
 * layer filters reads by it and stamps writes with it (FR-37), so a request
 * pinned to app A can neither read nor write app B's objects, streams, or jobs.
 *
 * TRUST MODEL (tenant-app-isolation-4). `appId` is a per-TENANT NAMESPACING
 * axis, NOT a per-principal trust boundary. The app a connection is pinned to
 * is *client-selected* — the HTTP boundary derives it from the URL prefix and
 * the WebSocket boundary from the advertised Hello schema id — and the only
 * authorization gate is the principal's TENANT membership (the same gate the
 * single-app path uses). The framework does NOT model per-principal app
 * membership: every member of a tenant may select any app REGISTERED on the
 * server and operate within that app's partition, bounded by the tenant
 * boundary and the per-record / policy-hook authz that apply regardless of app.
 * Unknown / unregistered app ids are rejected at the boundary, so a connection
 * can only ever land in a registered app's partition — never an arbitrary one.
 * Apps are therefore a product/namespacing separation between cooperating
 * surfaces of the same tenant, not a security wall between mutually distrustful
 * tenants of distinct products. A deployment that needs distinct products to be
 * mutually untrusting must put them in distinct TENANTS, not distinct apps.
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
