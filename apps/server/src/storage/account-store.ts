import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface StoredAccount {
  userId: string;
  handle: string;
  displayName: string;
  createdAt: string;
}

export interface CreateAccountInput {
  userId: string;
  handle: string;
  displayName: string;
  password: string;
}

interface AccountRow {
  user_id: string;
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
            (user_id, handle, display_name, password_salt, password_hash, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.userId, input.handle, input.displayName, passwordSalt, passwordHash, now);
    } catch (error) {
      if (error instanceof Error && /constraint/i.test(error.message)) {
        throw new Error("Handle is already taken");
      }
      throw error;
    }

    return {
      userId: input.userId,
      handle: input.handle,
      displayName: input.displayName,
      createdAt: now,
    };
  }

  readByIdentity(identity: string): StoredAccount | undefined {
    const row = this.readRowByIdentity(identity);
    return row ? fromRow(row) : undefined;
  }

  verifyPassword(identity: string, password: string): StoredAccount | undefined {
    const row = this.readRowByIdentity(identity);
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

  private readRowByIdentity(identity: string): AccountRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM auth_accounts
          WHERE handle = ? COLLATE NOCASE OR user_id = ?
          LIMIT 1`,
      )
      .get(identity, identity) as AccountRow | undefined;
  }
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString("base64url");
}

function fromRow(row: AccountRow): StoredAccount {
  return {
    userId: row.user_id,
    handle: row.handle,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}
