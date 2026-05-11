import type { DatabaseSync } from "node:sqlite";

/**
 * A row in the `tenants` ledger. The ledger was added by migration
 * `0004_tenants_ledger`; before that, tenants were emergent strings created
 * implicitly by sessions/accounts referencing them. The ledger lets the
 * server list tenants and lets an admin refuse traffic for unknown ones.
 */
export interface TenantRow {
  tenantId: string;
  displayName?: string;
  createdAt: string;
  archivedAt?: string;
}

interface TenantSqlRow {
  tenant_id: string;
  display_name: string | null;
  created_at: string;
  archived_at: string | null;
}

/** Thrown by {@link TenantStore.create} when a non-archived row already exists. */
export class TenantAlreadyExistsError extends Error {
  constructor(readonly tenantId: string) {
    super(`Tenant ${tenantId} already exists`);
    this.name = "TenantAlreadyExistsError";
  }
}

export class TenantStore {
  constructor(private readonly db: DatabaseSync) {}

  list(includeArchived = false): TenantRow[] {
    const sql = includeArchived
      ? "SELECT * FROM tenants ORDER BY created_at ASC, tenant_id ASC"
      : "SELECT * FROM tenants WHERE archived_at IS NULL ORDER BY created_at ASC, tenant_id ASC";
    const rows = this.db.prepare(sql).all() as unknown as TenantSqlRow[];
    return rows.map(toTenantRow);
  }

  get(tenantId: string): TenantRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM tenants WHERE tenant_id = ?")
      .get(tenantId) as unknown as TenantSqlRow | undefined;
    return row ? toTenantRow(row) : undefined;
  }

  create(tenantId: string, displayName?: string): TenantRow {
    const existing = this.get(tenantId);
    if (existing && !existing.archivedAt) {
      throw new TenantAlreadyExistsError(tenantId);
    }
    const createdAt = new Date().toISOString();
    if (existing && existing.archivedAt) {
      // Reviving an archived tenant: clear archived_at, refresh display_name.
      this.db
        .prepare(
          "UPDATE tenants SET display_name = ?, archived_at = NULL WHERE tenant_id = ?",
        )
        .run(displayName ?? null, tenantId);
      return { tenantId, ...(displayName !== undefined ? { displayName } : {}), createdAt: existing.createdAt };
    }
    this.db
      .prepare(
        `INSERT INTO tenants (tenant_id, display_name, created_at)
          VALUES (?, ?, ?)`,
      )
      .run(tenantId, displayName ?? null, createdAt);
    return {
      tenantId,
      ...(displayName !== undefined ? { displayName } : {}),
      createdAt,
    };
  }

  /** Soft-delete. Idempotent: archiving an already-archived row is a no-op. */
  archive(tenantId: string): void {
    const existing = this.get(tenantId);
    if (!existing || existing.archivedAt) {
      return;
    }
    const archivedAt = new Date().toISOString();
    this.db
      .prepare("UPDATE tenants SET archived_at = ? WHERE tenant_id = ?")
      .run(archivedAt, tenantId);
  }

  /**
   * Insert a tenant if it isn't already in the ledger. Used by the implicit-
   * tenant-creation auth path so first-time use of a tenant id auto-registers
   * it (only when `FrickConfig.implicitTenantCreation` is true).
   */
  ensure(tenantId: string): void {
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO tenants (tenant_id, display_name, created_at)
          VALUES (?, NULL, ?)`,
      )
      .run(tenantId, createdAt);
  }
}

function toTenantRow(row: TenantSqlRow): TenantRow {
  return {
    tenantId: row.tenant_id,
    ...(row.display_name !== null ? { displayName: row.display_name } : {}),
    createdAt: row.created_at,
    ...(row.archived_at !== null ? { archivedAt: row.archived_at } : {}),
  };
}
