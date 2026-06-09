import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SqlDriver } from "./sql-driver.js";

export interface IssuedResetToken {
  /// The opaque token that the email link carries. The store keeps only a
  /// SHA-256 hash; this is the only chance the caller has to read the raw
  /// token (to compose the email URL).
  token: string;
  tenantId: string;
  userId: string;
  expiresAt: string;
}

export interface ConsumedResetTokenRow {
  tenantId: string;
  userId: string;
}

/**
 * Persistence layer for the email password-reset token. The token itself
 * is opaque (high-entropy random bytes); only its SHA-256 hash hits the
 * database, so a leaked DB snapshot can't be used to mint reset emails
 * for other users. Tokens are one-shot: consume() validates and marks
 * the row consumed inside a single transaction, so two concurrent reset
 * confirms with the same token can't both succeed.
 */
export class PasswordResetTokenStore {
  constructor(private readonly sql: SqlDriver) {}

  /** Issue a fresh token for the given user. Returns the raw token and
   *  the expiry timestamp. The caller is responsible for putting the
   *  token in the email link — once this function returns, the store no
   *  longer has the raw bytes. */
  async issue(args: {
    tenantId: string;
    userId: string;
    ttlMinutes?: number;
  }): Promise<IssuedResetToken> {
    const ttl = args.ttlMinutes ?? 60;
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 60_000);
    // auth-core-8: enforce single-outstanding-token-per-user. Mark every prior
    // unconsumed token for (tenant, user) consumed BEFORE inserting the new one,
    // in a single transaction, so a previously-issued (possibly leaked-but-
    // unused) link stops verifying the moment a fresh reset is requested. Only
    // the most recent token remains valid.
    await this.sql.transaction(async (tx) => {
      await tx.run(
        `UPDATE auth_password_reset_tokens
            SET consumed_at = ?
            WHERE tenant_id = ? AND user_id = ? AND consumed_at IS NULL`,
        [now.toISOString(), args.tenantId, args.userId],
      );
      await tx.run(
        `INSERT INTO auth_password_reset_tokens
            (token_hash, tenant_id, user_id, created_at, expires_at, consumed_at)
            VALUES (?, ?, ?, ?, ?, NULL)`,
        [tokenHash, args.tenantId, args.userId, now.toISOString(), expiresAt.toISOString()],
      );
    });
    return {
      token,
      tenantId: args.tenantId,
      userId: args.userId,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Validate the token, mark it consumed, and return the matching
   * (tenant, user) tuple. Returns undefined when the token is unknown,
   * expired, or already used. Constant-time comparison is via the
   * SQLite primary-key lookup on the hashed token.
   */
  async consume(token: string): Promise<ConsumedResetTokenRow | undefined> {
    const tokenHash = hashToken(token);
    const now = new Date().toISOString();
    return this.sql.transaction(async (tx) => {
      const row = await tx.get<{
        tenant_id: string;
        user_id: string;
        expires_at: string;
        consumed_at: string | null;
      }>(
        `SELECT tenant_id, user_id, expires_at, consumed_at
             FROM auth_password_reset_tokens
             WHERE token_hash = ?`,
        [tokenHash],
      );
      if (!row || row.consumed_at !== null || row.expires_at < now) {
        return undefined;
      }
      await tx.run(
        `UPDATE auth_password_reset_tokens
             SET consumed_at = ?
             WHERE token_hash = ?`,
        [now, tokenHash],
      );
      return { tenantId: row.tenant_id, userId: row.user_id };
    });
  }

  /**
   * Garbage-collect tokens whose expiry has passed. Safe to call on a
   * scheduled job; not on the hot path.
   */
  async purgeExpired(): Promise<number> {
    const now = new Date().toISOString();
    const result = await this.sql.run(
      `DELETE FROM auth_password_reset_tokens WHERE expires_at < ?`,
      [now],
    );
    return Number(result.changes);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

// Keep imported for symmetry; not used directly but available if a
// caller wants to do constant-time comparison on the raw bytes.
void timingSafeEqual;
