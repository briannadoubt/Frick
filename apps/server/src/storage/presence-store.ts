import { decode, encode } from "@msgpack/msgpack";
import {
  packPresenceRecord,
  unpackPresenceRecord,
  type FrickSchema,
  type PackedPresenceRecord,
  type PlainObject,
} from "@frick/protocol";
import type { SqlDriver } from "./sql-driver.js";

interface PresenceRow {
  packed: Uint8Array;
  expires_at: number;
}

export class PresenceStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly schema: FrickSchema,
  ) {}

  async set(tenantId: string, type: string, key: string, value: PlainObject, ttlMs: number): Promise<void> {
    const packed = packPresenceRecord(this.schema, type, key, value);
    await this.sql.run(
      `INSERT INTO presence_leases
          (tenant_id, presence_type, presence_key, packed, expires_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id, presence_type, presence_key) DO UPDATE SET
            packed = excluded.packed,
            expires_at = excluded.expires_at`,
      [tenantId, type, key, Buffer.from(encode(packed)), Date.now() + ttlMs],
    );
  }

  async read(tenantId: string, type: string, key: string): Promise<PlainObject | undefined> {
    const row = await this.sql.get<PresenceRow>(
      "SELECT packed, expires_at FROM presence_leases WHERE tenant_id = ? AND presence_type = ? AND presence_key = ?",
      [tenantId, type, key],
    );
    if (!row) {
      return undefined;
    }
    if (Number(row.expires_at) <= Date.now()) {
      await this.clear(tenantId, type, key);
      return undefined;
    }
    return unpackPresenceRecord(this.schema, decode(row.packed) as PackedPresenceRecord).value;
  }

  async clear(tenantId: string, type: string, key: string): Promise<void> {
    await this.sql.run(
      "DELETE FROM presence_leases WHERE tenant_id = ? AND presence_type = ? AND presence_key = ?",
      [tenantId, type, key],
    );
  }
}
