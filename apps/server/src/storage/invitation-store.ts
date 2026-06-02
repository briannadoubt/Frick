import type { FrickInvitation, FrickSharingPermission } from "@frick/protocol";
import type { SqlDriver } from "./sql-driver.js";

interface InvitationSqlRow {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  record_type: string;
  record_id: string;
  permission: string;
  token: string;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
  redeemed_by_user_id: string | null;
}

export interface CreateInvitationArgs {
  id: string;
  tenantId: string;
  ownerUserId: string;
  recordType: string;
  recordId: string;
  permission: FrickSharingPermission;
  token: string;
  createdAt: string;
  expiresAt: string;
}

/** Outcome of {@link InvitationStore.redeem}. */
export type RedeemOutcome =
  | { kind: "ok"; invitation: FrickInvitation }
  | { kind: "notFound" }
  | { kind: "expired"; invitation: FrickInvitation }
  | { kind: "alreadyRedeemed"; invitation: FrickInvitation }
  | { kind: "tenantMismatch"; invitation: FrickInvitation };

export class InvitationStore {
  constructor(private readonly sql: SqlDriver) {}

  async create(args: CreateInvitationArgs): Promise<FrickInvitation> {
    await this.sql.run(
      `INSERT INTO invitations (
            id, tenant_id, owner_user_id, record_type, record_id,
            permission, token, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        args.id,
        args.tenantId,
        args.ownerUserId,
        args.recordType,
        args.recordId,
        args.permission,
        args.token,
        args.createdAt,
        args.expiresAt,
      ],
    );
    return {
      id: args.id,
      tenantId: args.tenantId,
      ownerUserId: args.ownerUserId,
      recordType: args.recordType,
      recordId: args.recordId,
      permission: args.permission,
      token: args.token,
      createdAt: args.createdAt,
      expiresAt: args.expiresAt,
    };
  }

  async getByToken(token: string): Promise<FrickInvitation | undefined> {
    const row = await this.sql.get<InvitationSqlRow>(
      "SELECT * FROM invitations WHERE token = ?",
      [token],
    );
    return row ? toInvitation(row) : undefined;
  }

  async getById(tenantId: string, id: string): Promise<FrickInvitation | undefined> {
    const row = await this.sql.get<InvitationSqlRow>(
      "SELECT * FROM invitations WHERE tenant_id = ? AND id = ?",
      [tenantId, id],
    );
    return row ? toInvitation(row) : undefined;
  }

  /** Atomically validate + mark as redeemed. Returns the post-redemption
   * invitation on `ok`. The caller is responsible for creating the
   * corresponding {@link Grant} in the same logical operation (the routes
   * do both inside a wrapping transaction). */
  async redeem(args: {
    token: string;
    tenantId: string;
    redeemerUserId: string;
    now: string;
  }): Promise<RedeemOutcome> {
    const found = await this.getByToken(args.token);
    if (!found) {
      return { kind: "notFound" };
    }
    if (found.tenantId !== args.tenantId) {
      return { kind: "tenantMismatch", invitation: found };
    }
    if (found.redeemedAt) {
      return { kind: "alreadyRedeemed", invitation: found };
    }
    if (Date.parse(found.expiresAt) <= Date.parse(args.now)) {
      return { kind: "expired", invitation: found };
    }
    await this.sql.run(
      `UPDATE invitations
            SET redeemed_at = ?, redeemed_by_user_id = ?
          WHERE id = ? AND redeemed_at IS NULL`,
      [args.now, args.redeemerUserId, found.id],
    );
    return {
      kind: "ok",
      invitation: {
        ...found,
        redeemedAt: args.now,
        redeemedByUserId: args.redeemerUserId,
      },
    };
  }
}

function toInvitation(row: InvitationSqlRow): FrickInvitation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ownerUserId: row.owner_user_id,
    recordType: row.record_type,
    recordId: row.record_id,
    permission: row.permission as FrickSharingPermission,
    token: row.token,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.redeemed_at !== null ? { redeemedAt: row.redeemed_at } : {}),
    ...(row.redeemed_by_user_id !== null
      ? { redeemedByUserId: row.redeemed_by_user_id }
      : {}),
  };
}
