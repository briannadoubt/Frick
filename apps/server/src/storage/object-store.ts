import type { DatabaseSync } from "node:sqlite";
import { decode, encode } from "@msgpack/msgpack";
import {
  packObjectRecord,
  unpackObjectRecord,
  type FrickSchema,
  type PackedRecord,
  type PlainObject,
} from "@frick/protocol";
import { DEFAULT_TENANT_ID } from "../tenant.js";

interface ObjectRow {
  packed: Uint8Array;
}

export class ObjectStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly schema: FrickSchema,
  ) {}

  upsert(
    tenantId: string,
    type: string,
    id: string,
    value: PlainObject,
    version: number,
  ): void {
    const packed = packObjectRecord(this.schema, type, id, withoutRecordId(value));
    this.db
      .prepare(
        `INSERT INTO objects
          (tenant_id, object_type, object_id, version, packed, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id, object_type, object_id) DO UPDATE SET
            version = excluded.version,
            packed = excluded.packed,
            updated_at = excluded.updated_at`,
      )
      .run(
        tenantId,
        type,
        id,
        version,
        Buffer.from(encode(packed)),
        new Date().toISOString(),
      );
  }

  read(tenantId: string, type: string, id: string): PlainObject | undefined {
    const row = this.db
      .prepare(
        "SELECT packed FROM objects WHERE tenant_id = ? AND object_type = ? AND object_id = ?",
      )
      .get(tenantId, type, id) as ObjectRow | undefined;
    if (!row) {
      return undefined;
    }
    return unpackObjectRecord(this.schema, decode(row.packed) as PackedRecord).value;
  }

  list(tenantId: string, type: string): PlainObject[] {
    const rows = this.db
      .prepare(
        "SELECT packed FROM objects WHERE tenant_id = ? AND object_type = ? ORDER BY object_id ASC",
      )
      .all(tenantId, type) as unknown as ObjectRow[];
    return rows.map((row) => unpackObjectRecord(this.schema, decode(row.packed) as PackedRecord).value);
  }
}

// Re-exported for the FrickStore facade and tests that want to fall back to
// the single-tenant default explicitly.
export { DEFAULT_TENANT_ID };

function withoutRecordId(value: PlainObject): PlainObject {
  const { id: _id, ...fields } = value;
  return fields;
}
