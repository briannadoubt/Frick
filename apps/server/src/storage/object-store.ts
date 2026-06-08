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
import { DEFAULT_APP_ID } from "../app-id.js";
import { FrickCrossAppAccessError, FrickObjectVersionConflictError } from "./object-errors.js";
import type { SqlDriver } from "./sql-driver.js";

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
  /**
   * App partition (FR-37). Defaults to {@link DEFAULT_APP_ID} when omitted so
   * existing single-app callers are unaffected. Two apps writing the same
   * (tenant, type, id) are isolated by this column.
   */
  appId?: string;
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
    private readonly sql: SqlDriver,
    private readonly schema: FrickSchema,
  ) {}

  /**
   * Legacy positional signature. Always writes unconditionally — equivalent
   * to {@link upsertWithPolicy} with `mergePolicy: "lastWriteWins"`. Kept so
   * existing call sites (projections, seeds, dev-login) continue to work
   * without churn.
   */
  async upsert(
    tenantId: string,
    type: string,
    id: string,
    value: PlainObject,
    version: number,
    appId: string = DEFAULT_APP_ID,
  ): Promise<void> {
    await this.#writeRow(appId, tenantId, type, id, value, version);
  }

  /**
   * Tenant-aware write with optional version precondition. The full
   * read-and-write happens inside a SQLite IMMEDIATE transaction so two
   * concurrent updates cannot both observe the same "currentVersion" and
   * succeed.
   */
  async upsertWithPolicy(args: ObjectUpsertArgs): Promise<ObjectUpsertResult> {
    const mergePolicy = args.mergePolicy ?? "lastWriteWins";
    const appId = args.appId ?? DEFAULT_APP_ID;
    return this.sql.transaction(async (tx) => {
      const current = await tx.get<ObjectVersionRow>(
        "SELECT version FROM objects WHERE app_id = ? AND tenant_id = ? AND object_type = ? AND object_id = ?",
        [appId, args.tenantId, args.objectType, args.objectId],
      );
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

      await this.#writeRowTx(
        tx,
        appId,
        args.tenantId,
        args.objectType,
        args.objectId,
        args.value,
        nextVersion,
      );
      return { previousVersion, nextVersion, created: !exists };
    });
  }

  async read(
    tenantId: string,
    type: string,
    id: string,
    appId: string = DEFAULT_APP_ID,
  ): Promise<PlainObject | undefined> {
    const row = await this.sql.get<ObjectRow>(
      "SELECT packed FROM objects WHERE app_id = ? AND tenant_id = ? AND object_type = ? AND object_id = ?",
      [appId, tenantId, type, id],
    );
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
  async readVersion(
    tenantId: string,
    type: string,
    id: string,
    appId: string = DEFAULT_APP_ID,
  ): Promise<number> {
    const row = await this.sql.get<ObjectVersionRow>(
      "SELECT version FROM objects WHERE app_id = ? AND tenant_id = ? AND object_type = ? AND object_id = ?",
      [appId, tenantId, type, id],
    );
    return row ? Number(row.version) : 0;
  }

  /**
   * Remove a single object row. Returns true when a row was deleted, false
   * when the (tenant, type, id) tuple was already absent. The framework
   * does not soft-delete — once removed, the row is gone, and a follow-up
   * upsert with the same id starts at version 1 again.
   */
  async delete(
    tenantId: string,
    type: string,
    id: string,
    appId: string = DEFAULT_APP_ID,
  ): Promise<boolean> {
    const result = await this.sql.run(
      "DELETE FROM objects WHERE app_id = ? AND tenant_id = ? AND object_type = ? AND object_id = ?",
      [appId, tenantId, type, id],
    );
    return result.changes > 0;
  }

  async list(
    tenantId: string,
    type: string,
    appId: string = DEFAULT_APP_ID,
  ): Promise<PlainObject[]> {
    const rows = await this.sql.all<ObjectRow>(
      "SELECT packed FROM objects WHERE app_id = ? AND tenant_id = ? AND object_type = ? ORDER BY object_id ASC",
      [appId, tenantId, type],
    );
    return rows.map((row) =>
      unpackObjectRecord(this.schema, decode(row.packed) as PackedRecord).value,
    );
  }

  async #writeRow(
    appId: string,
    tenantId: string,
    type: string,
    id: string,
    value: PlainObject,
    version: number,
  ): Promise<void> {
    await this.#writeRowTx(this.sql, appId, tenantId, type, id, value, version);
  }

  async #writeRowTx(
    tx: SqlDriver,
    appId: string,
    tenantId: string,
    type: string,
    id: string,
    value: PlainObject,
    version: number,
  ): Promise<void> {
    const packed = packObjectRecord(this.schema, type, id, withoutRecordId(value));
    // Cross-app write guard (FR-37): the objects PRIMARY KEY is
    // (tenant_id, object_type, object_id) — app_id is an additive column
    // (FR-36), not part of the key. So a write from a *different* app to the
    // same (tenant, type, id) would otherwise clobber the owning app's row via
    // ON CONFLICT. Reject it: an app may only write rows it owns (or a
    // brand-new row). Reads already filter by app_id, so this closes the write
    // side of the boundary. Same-app writes (the overwhelming common case, and
    // the entire single-app '_default' default) pass through untouched.
    const owner = await tx.get<{ app_id: string }>(
      "SELECT app_id FROM objects WHERE tenant_id = ? AND object_type = ? AND object_id = ?",
      [tenantId, type, id],
    );
    if (owner !== undefined && owner.app_id !== appId) {
      throw new FrickCrossAppAccessError({
        requestedAppId: appId,
        ownerAppId: owner.app_id,
        tenantId,
        objectType: type,
        objectId: id,
      });
    }
    // The ON CONFLICT target stays the PK; app_id is set on both the insert and
    // the update branch so an existing row's app stamp is preserved.
    await tx.run(
      `INSERT INTO objects
          (app_id, tenant_id, object_type, object_id, version, packed, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id, object_type, object_id) DO UPDATE SET
            app_id = excluded.app_id,
            version = excluded.version,
            packed = excluded.packed,
            updated_at = excluded.updated_at`,
      [appId, tenantId, type, id, version, Buffer.from(encode(packed)), new Date().toISOString()],
    );
  }
}

// Re-exported for the FrickStore facade and tests that want to fall back to
// the single-tenant default explicitly.
export { DEFAULT_TENANT_ID };
export { DEFAULT_APP_ID };
export { FrickObjectVersionConflictError };

function withoutRecordId(value: PlainObject): PlainObject {
  const { id: _id, ...fields } = value;
  return fields;
}
