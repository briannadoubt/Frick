import type { SqlDriver } from "./sql-driver.js";

/**
 * Per-tenant runtime config knobs.
 *
 * Each row stores a JSON-encoded value under a `(tenantId, key)` pair. The
 * shape is intentionally generic so new knobs can be added without schema
 * changes — callers parse the JSON and validate against their own type.
 *
 * Known keys at the time of writing:
 *   - `"limits"`      — partial {@link FrickLimits} overrides merged over
 *                       the server defaults by {@link resolveTenantLimits}.
 *   - `"retentionMs"` — number; overrides the global idempotency-key
 *                       retention window for this tenant.
 *
 * Values that fail JSON.parse on read are silently treated as missing — a
 * corrupt row should not break the server's hot path. Writers always go
 * through {@link set}, which JSON-encodes the input, so corruption is only
 * possible via direct SQL editing.
 */
export class TenantSettingsStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Read a single setting. Returns the decoded value, or `undefined` if the
   * key is unset (or the stored JSON is malformed — see above).
   */
  async get(tenantId: string, key: string): Promise<unknown | undefined> {
    const row = await this.sql.get<{ setting_value: string }>(
      `SELECT setting_value FROM tenant_settings
          WHERE tenant_id = ? AND setting_key = ?`,
      [tenantId, key],
    );
    if (!row) return undefined;
    try {
      return JSON.parse(row.setting_value) as unknown;
    } catch {
      return undefined;
    }
  }

  /**
   * Upsert a single setting. The value is JSON-encoded; callers should pass
   * JSON-compatible data (plain objects, numbers, strings, arrays, null).
   */
  async set(tenantId: string, key: string, value: unknown): Promise<void> {
    const encoded = JSON.stringify(value);
    const updatedAt = this.now().toISOString();
    await this.sql.run(
      `INSERT INTO tenant_settings (tenant_id, setting_key, setting_value, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(tenant_id, setting_key) DO UPDATE SET
            setting_value = excluded.setting_value,
            updated_at = excluded.updated_at`,
      [tenantId, key, encoded, updatedAt],
    );
  }

  /** Remove a single setting. Idempotent: deleting a missing row is a no-op. */
  async delete(tenantId: string, key: string): Promise<void> {
    await this.sql.run(
      `DELETE FROM tenant_settings WHERE tenant_id = ? AND setting_key = ?`,
      [tenantId, key],
    );
  }

  /**
   * Return every setting for a tenant as a plain object. Keys with malformed
   * JSON are omitted (matching {@link get}'s policy). Order is unspecified.
   */
  async list(tenantId: string): Promise<Record<string, unknown>> {
    const rows = await this.sql.all<{ setting_key: string; setting_value: string }>(
      `SELECT setting_key, setting_value FROM tenant_settings
          WHERE tenant_id = ?
          ORDER BY setting_key ASC`,
      [tenantId],
    );
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        out[row.setting_key] = JSON.parse(row.setting_value) as unknown;
      } catch {
        // Skip malformed rows — see class-level doc.
      }
    }
    return out;
  }
}
