import { decode, encode } from "@msgpack/msgpack";
import {
  packSignalEnvelope,
  unpackSignalEnvelope,
  type FrickSchema,
  type PackedSignalEnvelope,
  type PlainObject,
} from "@frick/protocol";
import type { SqlDriver } from "./sql-driver.js";

interface SignalRow {
  id: number;
  packed: Uint8Array;
}

export class SignalStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly schema: FrickSchema,
  ) {}

  async enqueue(
    tenantId: string,
    type: string,
    key: string,
    value: PlainObject,
    ttlMs: number,
  ): Promise<void> {
    const packed = packSignalEnvelope(this.schema, type, key, value);
    await this.sql.run(
      `INSERT INTO signal_outbox (tenant_id, signal_type, signal_key, packed, expires_at)
          VALUES (?, ?, ?, ?, ?)`,
      [tenantId, type, key, Buffer.from(encode(packed)), Date.now() + ttlMs],
    );
  }

  async drain(tenantId: string, type: string, key: string): Promise<PlainObject[]> {
    const rows = await this.sql.all<SignalRow>(
      `SELECT id, packed FROM signal_outbox
          WHERE tenant_id = ? AND signal_type = ? AND signal_key = ? AND expires_at > ?
          ORDER BY id ASC`,
      [tenantId, type, key, Date.now()],
    );
    if (rows.length === 0) {
      return [];
    }

    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(", ");
    await this.sql.run(`DELETE FROM signal_outbox WHERE id IN (${placeholders})`, ids);

    return rows.map((row) =>
      unpackSignalEnvelope(this.schema, decode(row.packed) as PackedSignalEnvelope).value,
    );
  }
}
