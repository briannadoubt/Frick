import type { DatabaseSync } from "node:sqlite";
import { decode, encode } from "@msgpack/msgpack";
import {
  packSignalEnvelope,
  unpackSignalEnvelope,
  type FrickSchema,
  type PackedSignalEnvelope,
  type PlainObject,
} from "@frick/protocol";

interface SignalRow {
  id: number;
  packed: Uint8Array;
}

export class SignalStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly schema: FrickSchema,
  ) {}

  enqueue(type: string, key: string, value: PlainObject, ttlMs: number): void {
    const packed = packSignalEnvelope(this.schema, type, key, value);
    this.db
      .prepare(
        `INSERT INTO signal_outbox (signal_type, signal_key, packed, expires_at)
          VALUES (?, ?, ?, ?)`,
      )
      .run(type, key, Buffer.from(encode(packed)), Date.now() + ttlMs);
  }

  drain(type: string, key: string): PlainObject[] {
    const rows = this.db
      .prepare(
        `SELECT id, packed FROM signal_outbox
          WHERE signal_type = ? AND signal_key = ? AND expires_at > ?
          ORDER BY id ASC`,
      )
      .all(type, key, Date.now()) as SignalRow[];
    if (rows.length === 0) {
      return [];
    }

    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(", ");
    this.db.prepare(`DELETE FROM signal_outbox WHERE id IN (${placeholders})`).run(...ids);

    return rows.map((row) => unpackSignalEnvelope(this.schema, decode(row.packed) as PackedSignalEnvelope).value);
  }
}
