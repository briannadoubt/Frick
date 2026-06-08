import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SqlDriver } from "./sql-driver.js";

/**
 * Service principals (FR-46). A service principal is a non-human (machine)
 * identity authenticated by a long-lived API key rather than a user session.
 * It carries a fixed set of scopes that bound what it may do, and acts within
 * a single tenant.
 *
 * The API key is a high-entropy opaque secret presented as a bearer token.
 * Only the SHA-256 hash of the key is ever persisted (`key_hash`), so a leaked
 * database snapshot cannot be replayed to authenticate. A short, non-secret
 * `key_id` prefix is stored alongside so operators can identify a key in audit
 * logs and the issue/list UI without revealing the secret. The raw key is
 * returned exactly once, at issue time.
 *
 * Revocation is a soft delete (`revoked_at`); `authenticate()` ignores revoked
 * rows, so revoking a key immediately stops it from resolving to a principal.
 */

/** The set of scopes a service principal carries. Scopes are opaque strings
 * (e.g. `"object.read"`, `"stream.append"`, or coarser app-defined verbs); the
 * caller decides the vocabulary. Stored as a JSON array. */
export type ServicePrincipalScopes = readonly string[];

export interface IssuedServicePrincipal {
  /** Stable identifier for the principal (also the audit subject id). */
  id: string;
  /** Non-secret short prefix that identifies the key in logs/UI. */
  keyId: string;
  /**
   * The raw API key handed to the caller. This is the ONLY time it is
   * readable — only its hash is stored. Present the full value (including the
   * `keyId` prefix) as a bearer token to authenticate.
   */
  apiKey: string;
  tenantId: string;
  name: string;
  scopes: ServicePrincipalScopes;
  createdAt: string;
}

export interface ServicePrincipalRecord {
  id: string;
  keyId: string;
  tenantId: string;
  name: string;
  scopes: ServicePrincipalScopes;
  createdAt: string;
  revokedAt?: string;
}

interface ServicePrincipalRow {
  id: string;
  key_id: string;
  key_hash: string;
  tenant_id: string;
  name: string;
  scopes: string;
  created_at: string;
  revoked_at: string | null;
}

export interface IssueServicePrincipalInput {
  tenantId: string;
  /** Human-readable label, e.g. "ci-deploy-bot". */
  name: string;
  scopes: ServicePrincipalScopes;
}

export class ServicePrincipalStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Issue a new service principal + API key for `tenantId`. Returns the raw
   * key (the only chance to read it) plus the record metadata.
   */
  async issue(input: IssueServicePrincipalInput): Promise<IssuedServicePrincipal> {
    const id = `sp_${randomBytes(12).toString("base64url")}`;
    const keyId = `sk_${randomBytes(6).toString("base64url")}`;
    const secret = randomBytes(32).toString("base64url");
    // The presented bearer is `keyId.secret` so authenticate() can pull the
    // non-secret prefix for cheap lookup without storing the secret.
    const apiKey = `${keyId}.${secret}`;
    const createdAt = this.now().toISOString();
    const scopes = normalizeScopes(input.scopes);

    await this.sql.run(
      `INSERT INTO service_principals
          (id, key_id, key_hash, tenant_id, name, scopes, created_at, revoked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      [id, keyId, hashKey(apiKey), input.tenantId, input.name, JSON.stringify(scopes), createdAt],
    );

    return {
      id,
      keyId,
      apiKey,
      tenantId: input.tenantId,
      name: input.name,
      scopes,
      createdAt,
    };
  }

  /**
   * Resolve a presented API key to its (non-revoked) record, or `undefined`
   * when the key is unknown or revoked. Uses a constant-time hash comparison.
   */
  async authenticate(apiKey: string): Promise<ServicePrincipalRecord | undefined> {
    const keyId = keyIdFromApiKey(apiKey);
    if (!keyId) {
      return undefined;
    }
    const row = await this.sql.get<ServicePrincipalRow>(
      "SELECT * FROM service_principals WHERE key_id = ?",
      [keyId],
    );
    if (!row || row.revoked_at !== null) {
      return undefined;
    }
    if (!constantTimeEquals(hashKey(apiKey), row.key_hash)) {
      return undefined;
    }
    return fromRow(row);
  }

  /** List service principals for a tenant, newest first. Never returns key hashes. */
  async list(tenantId: string): Promise<ServicePrincipalRecord[]> {
    const rows = await this.sql.all<ServicePrincipalRow>(
      "SELECT * FROM service_principals WHERE tenant_id = ? ORDER BY created_at DESC, id DESC",
      [tenantId],
    );
    return rows.map(fromRow);
  }

  /** Fetch a single principal by id within a tenant. */
  async get(tenantId: string, id: string): Promise<ServicePrincipalRecord | undefined> {
    const row = await this.sql.get<ServicePrincipalRow>(
      "SELECT * FROM service_principals WHERE tenant_id = ? AND id = ?",
      [tenantId, id],
    );
    return row ? fromRow(row) : undefined;
  }

  /**
   * Revoke a service principal by id. Idempotent: returns true when an active
   * row was revoked, false when the id is unknown or already revoked. Scoped to
   * `tenantId` so one tenant cannot revoke another's principal.
   */
  async revoke(tenantId: string, id: string): Promise<boolean> {
    const result = await this.sql.run(
      "UPDATE service_principals SET revoked_at = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL",
      [this.now().toISOString(), tenantId, id],
    );
    return Number(result.changes) > 0;
  }
}

function normalizeScopes(scopes: ServicePrincipalScopes): string[] {
  return [...new Set(scopes.map((s) => s.trim()).filter((s) => s.length > 0))].sort();
}

function fromRow(row: ServicePrincipalRow): ServicePrincipalRecord {
  return {
    id: row.id,
    keyId: row.key_id,
    tenantId: row.tenant_id,
    name: row.name,
    scopes: parseScopes(row.scopes),
    createdAt: row.created_at,
    ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
  };
}

function parseScopes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function keyIdFromApiKey(apiKey: string): string | undefined {
  const dot = apiKey.indexOf(".");
  if (dot <= 0) {
    return undefined;
  }
  return apiKey.slice(0, dot);
}

function hashKey(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("base64url");
}

function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
