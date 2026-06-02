import type { DatabaseSync } from "node:sqlite";
import { decode, encode } from "@msgpack/msgpack";
import {
  packObjectRecord,
  unpackObjectRecord,
  type FrickObjectMergePolicy,
  type FrickSchema,
  type PackedRecord,
  type PlainObject,
} from "@fricken/protocol";
import { DEFAULT_TENANT_ID } from "../tenant.js";
import { FrickObjectVersionConflictError } from "./object-errors.js";

interface ObjectRow {
  packed: Uint8Array;
}

interface ObjectVersionRow {
  version: number;
}

export interface ObjectUpsertResult {
  /** Version present on disk before this call. 0 for a fresh insert. */
  previousVersion: number;
  /** Version written to disk. */
  nextVersion: number;
  /** True when the row did not exist before this call. */
  created: boolean;
}

export interface ObjectUpsertArgs {
  tenantId: string;
  objectType: string;
  objectId: string;
  value: PlainObject;
  /**
   * Required when `mergePolicy === "versionPrecondition"` and the caller is
   * updating an existing row. Omit to express "create only" intent under
   * versionPrecondition. Ignored under `lastWriteWins`.
   */
  expectedVersion?: number;
  /** Resolved by the caller from the schema. Defaults to "lastWriteWins". */
  mergePolicy?: FrickObjectMergePolicy;
}

export class ObjectStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly schema: FrickSchema,
  ) {}

  /**
   * Legacy positional signature. Always writes unconditionally — equivalent
   * to {@link upsertWithPolicy} with `mergePolicy: "lastWriteWins"`. Kept so
   * existing call sites (projections, seeds, dev-login) continue to work
   * without churn.
   */
  upsert(
    tenantId: string,
    type: string,
    id: string,
    value: PlainObject,
    version: number,
  ): void {
    this.#writeRow(tenantId, type, id, value, version);
  }

  /**
   * Tenant-aware write with optional version precondition. The full
   * read-and-write happens inside a SQLite IMMEDIATE transaction so two
   * concurrent updates cannot both observe the same "currentVersion" and
   * succeed.
   */
  upsertWithPolicy(args: ObjectUpsertArgs): ObjectUpsertResult {
    const mergePolicy = args.mergePolicy ?? "lastWriteWins";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db
        .prepare(
          "SELECT version FROM objects WHERE tenant_id = ? AND object_type = ? AND object_id = ?",
        )
        .get(args.tenantId, args.objectType, args.objectId) as
        | ObjectVersionRow
        | undefined;
      const previousVersion = current ? Number(current.version) : 0;
      const exists = current !== undefined;

      if (mergePolicy === "versionPrecondition") {
        if (args.expectedVersion === undefined) {
          if (exists) {
            throw new FrickObjectVersionConflictError({
              tenantId: args.tenantId,
              objectType: args.objectType,
              objectId: args.objectId,
              expectedVersion: undefined,
              actualVersion: previousVersion,
            });
          }
        } else if (previousVersion !== args.expectedVersion) {
          throw new FrickObjectVersionConflictError({
            tenantId: args.tenantId,
            objectType: args.objectType,
            objectId: args.objectId,
            expectedVersion: args.expectedVersion,
            actualVersion: previousVersion,
          });
        }
      }

      const nextVersion =
        mergePolicy === "versionPrecondition"
          ? args.expectedVersion === undefined
            ? 1
            : args.expectedVersion + 1
          : previousVersion + 1;

      this.#writeRow(
        args.tenantId,
        args.objectType,
        args.objectId,
        args.value,
        nextVersion,
      );
      this.db.exec("COMMIT");
      return { previousVersion, nextVersion, created: !exists };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Swallow — surface the original cause.
      }
      throw error;
    }
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

  /**
   * Return the current on-disk version, or 0 if the row does not exist.
   * Exposed so the HTTP layer can populate ETag headers without a second
   * unpack.
   */
  readVersion(tenantId: string, type: string, id: string): number {
    const row = this.db
      .prepare(
        "SELECT version FROM objects WHERE tenant_id = ? AND object_type = ? AND object_id = ?",
      )
      .get(tenantId, type, id) as ObjectVersionRow | undefined;
    return row ? Number(row.version) : 0;
  }

  /**
   * Remove a single object row. Returns true when a row was deleted, false
   * when the (tenant, type, id) tuple was already absent. The framework
   * does not soft-delete — once removed, the row is gone, and a follow-up
   * upsert with the same id starts at version 1 again.
   */
  delete(tenantId: string, type: string, id: string): boolean {
    const result = this.db
      .prepare(
        "DELETE FROM objects WHERE tenant_id = ? AND object_type = ? AND object_id = ?",
      )
      .run(tenantId, type, id);
    return result.changes > 0;
  }

  list(tenantId: string, type: string): PlainObject[] {
    const rows = this.db
      .prepare(
        "SELECT packed FROM objects WHERE tenant_id = ? AND object_type = ? ORDER BY object_id ASC",
      )
      .all(tenantId, type) as unknown as ObjectRow[];
    return rows.map((row) => unpackObjectRecord(this.schema, decode(row.packed) as PackedRecord).value);
  }

  #writeRow(
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
}

// Re-exported for the FrickStore facade and tests that want to fall back to
// the single-tenant default explicitly.
export { DEFAULT_TENANT_ID };
export { FrickObjectVersionConflictError };

function withoutRecordId(value: PlainObject): PlainObject {
  const { id: _id, ...fields } = value;
  return fields;
}
