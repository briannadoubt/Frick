import { decode, encode } from "@msgpack/msgpack";
import {
  packPresenceRecord,
  unpackPresenceRecord,
  type FrickSchema,
  type PackedPresenceRecord,
  type PlainObject,
} from "@fricken/protocol";
import { DEFAULT_APP_ID } from "../app-id.js";
import type { SqlDriver } from "./sql-driver.js";

interface PresenceRow {
  packed: Uint8Array;
  expires_at: number;
}

/**
 * App partitioning (FR-153): every method takes a trailing `appId` defaulting
 * to {@link DEFAULT_APP_ID}, so single-app callers are byte-for-byte
 * unaffected. Reads filter by `app_id`; writes stamp it. The
 * `presence_leases` PRIMARY KEY is
 * `(app_id, tenant_id, presence_type, presence_key)` as of migration 0023 —
 * app_id is part of the key, so two apps holding a lease at the same
 * (tenant, type, key) occupy DISTINCT rows. set()'s ON CONFLICT can therefore
 * only match a row of the same app, so app B can neither overwrite nor evict
 * app A's lease (server-storage-3), and read()/clear() filter by app_id so app
 * A never observes or clears app B's presence at the same key.
 */
export class PresenceStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly schema: FrickSchema,
  ) {}

  async set(
    tenantId: string,
    type: string,
    key: string,
    value: PlainObject,
    ttlMs: number,
    appId: string = DEFAULT_APP_ID,
  ): Promise<void> {
    const packed = packPresenceRecord(this.schema, type, key, value);
    await this.sql.run(
      `INSERT INTO presence_leases
          (app_id, tenant_id, presence_type, presence_key, packed, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(app_id, tenant_id, presence_type, presence_key) DO UPDATE SET
            packed = excluded.packed,
            expires_at = excluded.expires_at`,
      [appId, tenantId, type, key, Buffer.from(encode(packed)), Date.now() + ttlMs],
    );
  }

  async read(
    tenantId: string,
    type: string,
    key: string,
    appId: string = DEFAULT_APP_ID,
  ): Promise<PlainObject | undefined> {
    const row = await this.sql.get<PresenceRow>(
      "SELECT packed, expires_at FROM presence_leases WHERE app_id = ? AND tenant_id = ? AND presence_type = ? AND presence_key = ?",
      [appId, tenantId, type, key],
    );
    if (!row) {
      return undefined;
    }
    if (Number(row.expires_at) <= Date.now()) {
      await this.clear(tenantId, type, key, appId);
      return undefined;
    }
    return unpackPresenceRecord(this.schema, decode(row.packed) as PackedPresenceRecord).value;
  }

  async clear(
    tenantId: string,
    type: string,
    key: string,
    appId: string = DEFAULT_APP_ID,
  ): Promise<void> {
    await this.sql.run(
      "DELETE FROM presence_leases WHERE app_id = ? AND tenant_id = ? AND presence_type = ? AND presence_key = ?",
      [appId, tenantId, type, key],
    );
  }
}
