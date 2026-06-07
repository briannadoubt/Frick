import {
  frickSharingPermissionSatisfies,
  type FrickGrant,
  type FrickSharingPermission,
} from "@fricken/protocol";
import type { SqlDriver } from "./sql-driver.js";

interface GrantSqlRow {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  record_type: string;
  record_id: string;
  grantee_user_id: string;
  permission: string;
  created_at: string;
  revoked_at: string | null;
}

export interface CreateGrantArgs {
  id: string;
  tenantId: string;
  ownerUserId: string;
  recordType: string;
  recordId: string;
  granteeUserId: string;
  permission: FrickSharingPermission;
  createdAt: string;
}

export interface ListGrantsArgs {
  tenantId: string;
  /** Limits the result to grants where the principal is either owner or
   * grantee. Mandatory — there is no "list every grant in the tenant" call. */
  principalUserId: string;
  recordType?: string;
  recordId?: string;
  includeRevoked?: boolean;
}

export class GrantStore {
  constructor(private readonly sql: SqlDriver) {}

  /**
   * `true` while the `grants` table holds no rows at all (revoked rows still
   * count as present). Used by the sync delivery path (FR-116) as a cheap
   * short-circuit: with no grants AND no policy hooks, per-record read
   * authorization on object subscriptions can be skipped entirely because the
   * baseline decision allows every in-tenant row. A single `EXISTS` probe
   * against a table that is empty in the common deployment, called once per
   * fan-out batch (not per row).
   *
   * NOTE: This accessor is now async to match the SqlDriver seam.
   */
  async isEmptyAsync(): Promise<boolean> {
    const row = await this.sql.get<{ present: number }>(
      "SELECT EXISTS(SELECT 1 FROM grants) AS present",
    );
    return (row?.present ?? 0) === 0;
  }

  async create(args: CreateGrantArgs): Promise<FrickGrant> {
    await this.sql.run(
      `INSERT INTO grants (
            id, tenant_id, owner_user_id, record_type, record_id,
            grantee_user_id, permission, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        args.id,
        args.tenantId,
        args.ownerUserId,
        args.recordType,
        args.recordId,
        args.granteeUserId,
        args.permission,
        args.createdAt,
      ],
    );
    return {
      id: args.id,
      tenantId: args.tenantId,
      ownerUserId: args.ownerUserId,
      recordType: args.recordType,
      recordId: args.recordId,
      granteeUserId: args.granteeUserId,
      permission: args.permission,
      createdAt: args.createdAt,
    };
  }

  async getById(tenantId: string, id: string): Promise<FrickGrant | undefined> {
    const row = await this.sql.get<GrantSqlRow>(
      "SELECT * FROM grants WHERE tenant_id = ? AND id = ?",
      [tenantId, id],
    );
    return row ? toGrant(row) : undefined;
  }

  async list(args: ListGrantsArgs): Promise<FrickGrant[]> {
    const filters: string[] = [
      "tenant_id = ?",
      "(owner_user_id = ? OR grantee_user_id = ?)",
    ];
    const params: unknown[] = [args.tenantId, args.principalUserId, args.principalUserId];

    if (args.recordType !== undefined) {
      filters.push("record_type = ?");
      params.push(args.recordType);
    }
    if (args.recordId !== undefined) {
      filters.push("record_id = ?");
      params.push(args.recordId);
    }
    if (!args.includeRevoked) {
      filters.push("revoked_at IS NULL");
    }

    const sql =
      `SELECT * FROM grants WHERE ${filters.join(" AND ")} ` +
      "ORDER BY created_at DESC, id ASC";
    const rows = await this.sql.all<GrantSqlRow>(sql, params);
    return rows.map(toGrant);
  }

  /** Idempotent. Returns the updated row (or undefined if the id is unknown). */
  async revoke(args: { tenantId: string; id: string; now: string }): Promise<FrickGrant | undefined> {
    const existing = await this.getById(args.tenantId, args.id);
    if (!existing) {
      return undefined;
    }
    if (existing.revokedAt) {
      return existing;
    }
    await this.sql.run(
      `UPDATE grants SET revoked_at = ?
          WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL`,
      [args.now, args.tenantId, args.id],
    );
    return { ...existing, revokedAt: args.now };
  }

  /**
   * Used by the authz decision flow. Returns true iff an active (non-revoked)
   * grant exists for `granteeUserId` on `(recordType, recordId)` within
   * `tenantId` whose permission satisfies `required`. Returning a boolean
   * (rather than the row) keeps the hot-path interface minimal.
   */
  async hasActiveGrantFor(args: {
    tenantId: string;
    granteeUserId: string;
    recordType: string;
    recordId: string;
    required: FrickSharingPermission;
  }): Promise<boolean> {
    const rows = await this.sql.all<{ permission: string }>(
      `SELECT permission FROM grants
          WHERE tenant_id = ? AND grantee_user_id = ?
            AND record_type = ? AND record_id = ?
            AND revoked_at IS NULL`,
      [args.tenantId, args.granteeUserId, args.recordType, args.recordId],
    );
    for (const row of rows) {
      if (frickSharingPermissionSatisfies(row.permission as FrickSharingPermission, args.required)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Cascade lookup used by stream + projection read authorization (FR-70).
   * Returns true iff an active (non-revoked) grant exists for `granteeUserId`
   * on *any* object record whose `record_id` equals `recordId` within
   * `tenantId`, whose permission satisfies `"read"`.
   *
   * Streams and projections are keyed by an id (`streamId` / projection `key`),
   * not by object type, so the cascade matches by record id rather than
   * `(record_type, record_id)`. A `"read"` grant suffices: the cascade is
   * read-only and never authorizes writes to the derived primitives. Matching
   * `"read"` also matches `"write"` grants because `"write"` satisfies
   * `"read"` (see {@link frickSharingPermissionSatisfies}).
   */
  async hasActiveGrantForRecordId(args: {
    tenantId: string;
    granteeUserId: string;
    recordId: string;
  }): Promise<boolean> {
    const rows = await this.sql.all<{ permission: string }>(
      `SELECT permission FROM grants
          WHERE tenant_id = ? AND grantee_user_id = ?
            AND record_id = ?
            AND revoked_at IS NULL`,
      [args.tenantId, args.granteeUserId, args.recordId],
    );
    for (const row of rows) {
      if (frickSharingPermissionSatisfies(row.permission as FrickSharingPermission, "read")) {
        return true;
      }
    }
    return false;
  }
}

function toGrant(row: GrantSqlRow): FrickGrant {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ownerUserId: row.owner_user_id,
    recordType: row.record_type,
    recordId: row.record_id,
    granteeUserId: row.grantee_user_id,
    permission: row.permission as FrickSharingPermission,
    createdAt: row.created_at,
    ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
  };
}
