import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

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
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateAccountInput): StoredAccount {
    const now = new Date().toISOString();
    const passwordSalt = randomBytes(16).toString("base64url");
    const passwordHash = hashPassword(input.password, passwordSalt);

    try {
      this.db
        .prepare(
          `INSERT INTO auth_accounts
            (user_id, tenant_id, handle, display_name, password_salt, password_hash, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.userId,
          input.tenantId,
          input.handle,
          input.displayName,
          passwordSalt,
          passwordHash,
          now,
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

  list(tenantId: string, limit = 100): StoredAccount[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM auth_accounts
          WHERE tenant_id = ?
          ORDER BY created_at ASC, handle ASC
          LIMIT ?`,
      )
      .all(tenantId, limit) as unknown as AccountRow[];
    return rows.map(fromRow);
  }

  readByIdentity(tenantId: string, identity: string): StoredAccount | undefined {
    const row = this.readRowByIdentity(tenantId, identity);
    return row ? fromRow(row) : undefined;
  }

  /**
   * Replace the password for an existing account. Used by the password-
   * reset flow once a token has validated. Returns true when a row was
   * updated (the account exists), false when no row matched.
   */
  setPassword(tenantId: string, userId: string, newPassword: string): boolean {
    const passwordSalt = randomBytes(16).toString("base64url");
    const passwordHash = hashPassword(newPassword, passwordSalt);
    const result = this.db
      .prepare(
        `UPDATE auth_accounts
           SET password_salt = ?, password_hash = ?
           WHERE tenant_id = ? AND user_id = ?`,
      )
      .run(passwordSalt, passwordHash, tenantId, userId);
    return result.changes > 0;
  }

  verifyPassword(tenantId: string, identity: string, password: string): StoredAccount | undefined {
    const row = this.readRowByIdentity(tenantId, identity);
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
  delete(tenantId: string, userId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM auth_accounts WHERE tenant_id = ? AND user_id = ?")
      .run(tenantId, userId);
    return result.changes > 0;
  }

  private readRowByIdentity(tenantId: string, identity: string): AccountRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM auth_accounts
          WHERE tenant_id = ? AND (handle = ? COLLATE NOCASE OR user_id = ?)
          LIMIT 1`,
      )
      .get(tenantId, identity, identity) as AccountRow | undefined;
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
