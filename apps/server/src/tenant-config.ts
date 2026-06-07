import type { FrickStore } from "./store.js";
import type { FrickLimits } from "./limits.js";

/**
 * Subset of {@link FrickLimits} an operator can override on a per-tenant
 * basis. Fields not in this interface are intentionally global only —
 * heartbeat and TTL bounds are protocol-level safety nets that shouldn't
 * differ by tenant.
 */
export interface FrickTenantLimits {
  maxBlobBytes?: number;
  maxBlobBytesPerPrincipal?: number;
  maxStreamAppendPayloadBytes?: number;
  maxSubscriptionsPerConnection?: number;
  maxPendingAppendsPerClient?: number;
}

/**
 * Allowlist of {@link FrickLimits} keys an operator can override per tenant.
 * Anything not in this list is silently ignored when loaded from
 * `tenant_settings`, so a stale or hand-edited row can't widen the
 * configurable surface.
 */
const OVERRIDABLE_KEYS = [
  "maxBlobBytes",
  "maxBlobBytesPerPrincipal",
  "maxStreamAppendPayloadBytes",
  "maxSubscriptionsPerConnection",
  "maxPendingAppendsPerClient",
] as const satisfies readonly (keyof FrickTenantLimits & keyof FrickLimits)[];

/**
 * Compute the effective {@link FrickLimits} for a tenant by merging any
 * per-tenant override row (`tenant_settings.setting_key = "limits"`) over
 * the supplied `defaults`.
 *
 * The merge is shallow and only honors allowlisted keys (see
 * {@link OVERRIDABLE_KEYS}). Values that are not finite numbers are
 * dropped — the global default wins. This guarantees the returned object
 * is always a complete, well-typed `FrickLimits`.
 *
 * Resolution is cheap (single SQLite point read + JSON.parse) but callers
 * that hold a connection's lifetime are encouraged to cache the result
 * locally; settings change infrequently and the existing call sites only
 * need the value once per connection / once per HTTP request.
 */
export async function resolveTenantLimits(
  tenantId: string,
  store: FrickStore,
  defaults: FrickLimits,
): Promise<FrickLimits> {
  const raw = await store.tenantSettings.get(tenantId, "limits");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...defaults };
  }
  const overrides = raw as Record<string, unknown>;
  const merged: FrickLimits = { ...defaults };
  for (const key of OVERRIDABLE_KEYS) {
    const value = overrides[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Resolve a tenant's idempotency-key retention window, if overridden.
 * Returns `undefined` when the tenant has no override — callers fall back
 * to the global default.
 */
export async function resolveTenantRetentionMs(
  tenantId: string,
  store: FrickStore,
): Promise<number | undefined> {
  const raw = await store.tenantSettings.get(tenantId, "retentionMs");
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return undefined;
  }
  return raw;
}
