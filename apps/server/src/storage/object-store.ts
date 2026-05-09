import type { DatabaseSync } from "node:sqlite";
import { decode, encode } from "@msgpack/msgpack";
import {
  packObjectRecord,
  unpackObjectRecord,
  type FrickSchema,
  type PackedRecord,
  type PlainObject,
} from "@frick/protocol";

interface ObjectRow {
  packed: Uint8Array;
}

export class ObjectStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly schema: FrickSchema,
  ) {}

  upsert(type: string, id: string, value: PlainObject, version: number): void {
    const packed = packObjectRecord(this.schema, type, id, withoutRecordId(value));
    this.db
      .prepare(
        `INSERT OR REPLACE INTO objects
          (object_type, object_id, version, packed, updated_at)
          VALUES (?, ?, ?, ?, ?)`,
      )
      .run(type, id, version, Buffer.from(encode(packed)), new Date().toISOString());
  }

  read(type: string, id: string): PlainObject | undefined {
    const row = this.db
      .prepare("SELECT packed FROM objects WHERE object_type = ? AND object_id = ?")
      .get(type, id) as ObjectRow | undefined;
    if (!row) {
      return undefined;
    }
    return unpackObjectRecord(this.schema, decode(row.packed) as PackedRecord).value;
  }

  list(type: string): PlainObject[] {
    const rows = this.db
      .prepare("SELECT packed FROM objects WHERE object_type = ? ORDER BY object_id ASC")
      .all(type) as ObjectRow[];
    return rows.map((row) => unpackObjectRecord(this.schema, decode(row.packed) as PackedRecord).value);
  }
}

function withoutRecordId(value: PlainObject): PlainObject {
  const { id: _id, ...fields } = value;
  return fields;
}
