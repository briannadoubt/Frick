/**
 * Tenant boundary constants for the Frick framework.
 *
 * Frick supports a minimum-viable multi-tenant deployment: every framework
 * storage table carries a `tenant_id` column, and every {@link Principal}
 * (see `./authz.ts`) carries a `tenantId` derived from its session. Cross-
 * tenant resource access is denied by default with reason `tenantMismatch`.
 *
 * The current default deployment is implicitly single-tenant — all legacy
 * rows live in the {@link DEFAULT_TENANT_ID} tenant. Apps that opt into
 * multi-tenancy declare a tenant at signup, login, or dev-login; the session
 * pins the tenant for the lifetime of subsequent requests.
 *
 * Tenant ids are arbitrary opaque strings. There is intentionally no
 * `tenants` table: tenant existence is implicit in any session or account
 * row referencing it. See `docs/threat-model.md`.
 */
export const DEFAULT_TENANT_ID = "_default";

/**
 * Validate that a tenant id, if supplied, is a well-formed opaque string.
 * Tenant ids are not protocol-visible — the only constraints are length and
 * the characters legal in a URL/SQL value. Empty strings collapse to the
 * default tenant so callers can pass through an unset value without
 * branching.
 */
export function normalizeTenantId(value: unknown): string {
  if (value === undefined || value === null) {
    return DEFAULT_TENANT_ID;
  }
  if (typeof value !== "string") {
    throw new Error("tenantId must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return DEFAULT_TENANT_ID;
  }
  if (trimmed.length > 64) {
    throw new Error("tenantId must be at most 64 characters");
  }
  if (!/^[A-Za-z0-9_.:-]+$/.test(trimmed)) {
    throw new Error(
      "tenantId must contain only letters, digits, '_', '.', ':', or '-'",
    );
  }
  return trimmed;
}

/**
 * Error thrown when a tenant id supplied at an auth boundary is malformed.
 * Auth route handlers catch this and convert it to a `sync.protocolError`
 * envelope with `details.reason = "invalidTenantId"` and HTTP 400.
 */
export class TenantIdValidationError extends Error {
  readonly reason = "invalidTenantId";
  constructor(message = "tenantId is malformed") {
    super(message);
    this.name = "TenantIdValidationError";
  }
}

/**
 * Strict tenant id validator for the auth surface. Unlike
 * {@link normalizeTenantId} this does not collapse empty/missing values to
 * the default tenant — every code path that calls it must have already
 * decided whether the caller supplied a value. Used by `/auth/signup`,
 * `/auth/login`, and `/auth/dev-login` to reject obviously malformed
 * tenant ids before they reach the store.
 *
 * The regex is intentionally narrower than {@link normalizeTenantId}'s:
 * lowercase/digit start, up to 63 chars, ASCII alphanumerics plus `-` and
 * `_`. The default tenant (`_default`) matches and so does not require a
 * special case.
 */
export function validateTenantId(value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TenantIdValidationError("tenantId must be a non-empty string");
  }
  // The default tenant id (`_default`) starts with `_`, so the leading
  // character must permit underscore in addition to ASCII alphanumerics.
  if (!/^[a-z0-9_][a-z0-9\-_]{0,62}$/i.test(value)) {
    throw new TenantIdValidationError(
      "tenantId must start with an alphanumeric and contain only letters, digits, '-', or '_' (max 63 chars)",
    );
  }
}
