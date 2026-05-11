import type { DatabaseSync } from "node:sqlite";
import { decode, encode } from "@msgpack/msgpack";
import {
  packPresenceRecord,
  unpackPresenceRecord,
  type FrickSchema,
  type PackedPresenceRecord,
  type PlainObject,
} from "@frick/protocol";

interface PresenceRow {
  packed: Uint8Array;
  expires_at: number;
}

export class PresenceStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly schema: FrickSchema,
  ) {}

  set(tenantId: string, type: string, key: string, value: PlainObject, ttlMs: number): void {
    const packed = packPresenceRecord(this.schema, type, key, value);
    this.db
      .prepare(
        `INSERT INTO presence_leases
          (tenant_id, presence_type, presence_key, packed, expires_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id, presence_type, presence_key) DO UPDATE SET
            packed = excluded.packed,
            expires_at = excluded.expires_at`,
      )
      .run(tenantId, type, key, Buffer.from(encode(packed)), Date.now() + ttlMs);
  }

  read(tenantId: string, type: string, key: string): PlainObject | undefined {
    const row = this.db
      .prepare(
        "SELECT packed, expires_at FROM presence_leases WHERE tenant_id = ? AND presence_type = ? AND presence_key = ?",
      )
      .get(tenantId, type, key) as PresenceRow | undefined;
    if (!row) {
      return undefined;
    }
    if (Number(row.expires_at) <= Date.now()) {
      this.clear(tenantId, type, key);
      return undefined;
    }
    return unpackPresenceRecord(this.schema, decode(row.packed) as PackedPresenceRecord).value;
  }

  clear(tenantId: string, type: string, key: string): void {
    this.db
      .prepare(
        "DELETE FROM presence_leases WHERE tenant_id = ? AND presence_type = ? AND presence_key = ?",
      )
      .run(tenantId, type, key);
  }
}
