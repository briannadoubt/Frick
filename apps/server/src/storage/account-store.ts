import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { SqlDriver } from "./sql-driver.js";

export interface StoredAccount {
  tenantId: string;
  userId: string;
  handle: string;
  displayName: string;
  createdAt: string;
}

export interface CreateAccountInput {
  tenantId: string;
  userId: string;
  handle: string;
  displayName: string;
  password: string;
}

interface AccountRow {
  user_id: string;
  tenant_id: string;
  handle: string;
  display_name: string;
  password_salt: string;
  password_hash: string;
  created_at: string;
}

export class AccountStore {
  constructor(private readonly sql: SqlDriver) {}

  async create(input: CreateAccountInput): Promise<StoredAccount> {
    const now = new Date().toISOString();
    const passwordSalt = randomBytes(16).toString("base64url");
    const passwordHash = hashPassword(input.password, passwordSalt);

    try {
      await this.sql.run(
        `INSERT INTO auth_accounts
            (user_id, tenant_id, handle, display_name, password_salt, password_hash, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [input.userId, input.tenantId, input.handle, input.displayName, passwordSalt, passwordHash, now],
      );
    } catch (error) {
      if (error instanceof Error && /constraint/i.test(error.message)) {
        throw new Error("Handle is already taken");
      }
      throw error;
    }

    return {
      tenantId: input.tenantId,
      userId: input.userId,
      handle: input.handle,
      displayName: input.displayName,
      createdAt: now,
    };
  }

  async list(tenantId: string, limit = 100): Promise<StoredAccount[]> {
    const rows = await this.sql.all<AccountRow>(
      `SELECT * FROM auth_accounts
          WHERE tenant_id = ?
          ORDER BY created_at ASC, handle ASC
          LIMIT ?`,
      [tenantId, limit],
    );
    return rows.map(fromRow);
  }

  async readByIdentity(tenantId: string, identity: string): Promise<StoredAccount | undefined> {
    const row = await this.readRowByIdentity(tenantId, identity);
    return row ? fromRow(row) : undefined;
  }

  /**
   * Replace the password for an existing account. Used by the password-
   * reset flow once a token has validated. Returns true when a row was
   * updated (the account exists), false when no row matched.
   */
  async setPassword(tenantId: string, userId: string, newPassword: string): Promise<boolean> {
    const passwordSalt = randomBytes(16).toString("base64url");
    const passwordHash = hashPassword(newPassword, passwordSalt);
    const result = await this.sql.run(
      `UPDATE auth_accounts
           SET password_salt = ?, password_hash = ?
           WHERE tenant_id = ? AND user_id = ?`,
      [passwordSalt, passwordHash, tenantId, userId],
    );
    return result.changes > 0;
  }

  async verifyPassword(
    tenantId: string,
    identity: string,
    password: string,
  ): Promise<StoredAccount | undefined> {
    const row = await this.readRowByIdentity(tenantId, identity);
    if (!row) {
      return undefined;
    }

    const expected = Buffer.from(row.password_hash, "base64url");
    const actual = Buffer.from(hashPassword(password, row.password_salt), "base64url");
    if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) {
      return undefined;
    }

    return fromRow(row);
  }

  /**
   * Remove an account row, scoped to a single tenant. Used by the self-service
   * account-deletion flow. Returns true when a row was actually deleted, false
   * when no `(tenant_id, user_id)` match existed — idempotent. `user_id` is the
   * stable principal identifier; the tenant scope keeps the delete from ever
   * reaching across tenants.
   */
  async delete(tenantId: string, userId: string): Promise<boolean> {
    const result = await this.sql.run(
      "DELETE FROM auth_accounts WHERE tenant_id = ? AND user_id = ?",
      [tenantId, userId],
    );
    return result.changes > 0;
  }

  private async readRowByIdentity(
    tenantId: string,
    identity: string,
  ): Promise<AccountRow | undefined> {
    return this.sql.get<AccountRow>(
      `SELECT * FROM auth_accounts
          WHERE tenant_id = ? AND (LOWER(handle) = LOWER(?) OR user_id = ?)
          LIMIT 1`,
      [tenantId, identity, identity],
    );
  }
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString("base64url");
}

function fromRow(row: AccountRow): StoredAccount {
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    handle: row.handle,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}
