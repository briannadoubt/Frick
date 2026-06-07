import type { SqlDriver } from "./sql-driver.js";
import {
  createPasswordHasher,
  toStoredHash,
  type FrickPasswordHasher,
} from "./password-hasher.js";

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
  readonly #hasher: FrickPasswordHasher;
  private readonly sql: SqlDriver;

  constructor(sql: SqlDriver, hasher?: FrickPasswordHasher) {
    this.sql = sql;
    // Default to Argon2id for new/updated credentials (FR-35). The hasher is
    // injected so deployments can pick scrypt for back-compat, and tests can
    // pin a specific algorithm.
    this.#hasher = hasher ?? createPasswordHasher();
  }

  async create(input: CreateAccountInput): Promise<StoredAccount> {
    const now = new Date().toISOString();
    // New credentials store the self-describing hash in `password_hash`; the
    // salt is embedded in that string, so `password_salt` is left empty.
    const passwordHash = await this.#hasher.hash(input.password);

    try {
      await this.sql.run(
        `INSERT INTO auth_accounts
            (user_id, tenant_id, handle, display_name, password_salt, password_hash, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [input.userId, input.tenantId, input.handle, input.displayName, "", passwordHash, now],
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
    const passwordHash = await this.#hasher.hash(newPassword);
    const result = await this.sql.run(
      `UPDATE auth_accounts
           SET password_salt = ?, password_hash = ?
           WHERE tenant_id = ? AND user_id = ?`,
      ["", passwordHash, tenantId, userId],
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

    // Reconstruct a self-describing stored string. Legacy rows carry the salt
    // in `password_salt` and an untagged digest in `password_hash`; FR-35 rows
    // carry the whole tagged hash in `password_hash` and an empty salt.
    const stored = toStoredHash(row.password_hash, row.password_salt);
    if (!(await this.#hasher.verify(password, stored))) {
      return undefined;
    }

    // Lazy migration: if the stored hash is in an older/weaker format than the
    // active hasher, transparently re-hash and persist on this successful
    // login. Failures here must not block the login, so they are swallowed.
    if (this.#hasher.needsRehash(stored)) {
      try {
        const upgraded = await this.#hasher.hash(password);
        await this.sql.run(
          `UPDATE auth_accounts
               SET password_salt = ?, password_hash = ?
               WHERE tenant_id = ? AND user_id = ?`,
          ["", upgraded, row.tenant_id, row.user_id],
        );
      } catch {
        // Best-effort upgrade; the original hash still verifies next time.
      }
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

function fromRow(row: AccountRow): StoredAccount {
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    handle: row.handle,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}
