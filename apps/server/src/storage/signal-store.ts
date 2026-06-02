import type { DatabaseSync } from "node:sqlite";
import { decode, encode } from "@msgpack/msgpack";
import {
  packSignalEnvelope,
  unpackSignalEnvelope,
  type FrickSchema,
  type PackedSignalEnvelope,
  type PlainObject,
} from "@fricken/protocol";

interface SignalRow {
  id: number;
  packed: Uint8Array;
}

export class SignalStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly schema: FrickSchema,
  ) {}

  enqueue(tenantId: string, type: string, key: string, value: PlainObject, ttlMs: number): void {
    const packed = packSignalEnvelope(this.schema, type, key, value);
    this.db
      .prepare(
        `INSERT INTO signal_outbox (tenant_id, signal_type, signal_key, packed, expires_at)
          VALUES (?, ?, ?, ?, ?)`,
      )
      .run(tenantId, type, key, Buffer.from(encode(packed)), Date.now() + ttlMs);
  }

  drain(tenantId: string, type: string, key: string): PlainObject[] {
    const rows = this.db
      .prepare(
        `SELECT id, packed FROM signal_outbox
          WHERE tenant_id = ? AND signal_type = ? AND signal_key = ? AND expires_at > ?
          ORDER BY id ASC`,
      )
      .all(tenantId, type, key, Date.now()) as unknown as SignalRow[];
    if (rows.length === 0) {
      return [];
    }

    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(", ");
    this.db.prepare(`DELETE FROM signal_outbox WHERE id IN (${placeholders})`).run(...ids);

    return rows.map((row) => unpackSignalEnvelope(this.schema, decode(row.packed) as PackedSignalEnvelope).value);
  }
}
