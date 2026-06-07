import { createHash, randomBytes } from "node:crypto";
import type { SqlDriver } from "./sql-driver.js";

/**
 * Refresh tokens (FR-33). A refresh token is a long-lived, opaque, high-entropy
 * credential the client exchanges at `POST /auth/refresh` for a fresh
 * short-lived access token (a regular `auth_sessions` row with a short TTL).
 *
 * Like password-reset tokens, only the SHA-256 hash of the token hits the
 * database, so a leaked DB snapshot cannot be replayed to mint access tokens.
 * Tokens carry the `(tenantId, userId, deviceId, replicaId)` tuple so the
 * refresh endpoint can mint a session bound to the same device/replica the
 * original login used.
 *
 * Rotation: `rotate()` validates the presented token and, in a single
 * transaction, marks it revoked and issues a fresh one — so a stolen-then-used
 * refresh token is detectable (the original is already revoked) and a single
 * leaked token cannot be replayed indefinitely.
 */

export interface IssuedRefreshToken {
  /** The opaque token handed to the client. Only the hash is stored. */
  token: string;
  tenantId: string;
  userId: string;
  deviceId: string;
  replicaId: string;
  expiresAt: string;
}

export interface RefreshTokenRecord {
  tenantId: string;
  userId: string;
  deviceId: string;
  replicaId: string;
  expiresAt: string;
}

interface RefreshTokenRow {
  token_hash: string;
  tenant_id: string;
  user_id: string;
  device_id: string;
  replica_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export class RefreshTokenStore {
  constructor(private readonly sql: SqlDriver) {}

  /**
   * Issue a fresh refresh token for `(tenantId, userId, deviceId, replicaId)`.
   * Returns the raw token (the only chance the caller has to read it) plus the
   * expiry. Default TTL is 30 days.
   */
  async issue(args: {
    tenantId: string;
    userId: string;
    deviceId: string;
    replicaId: string;
    ttlSeconds?: number;
  }): Promise<IssuedRefreshToken> {
    const ttlSeconds = args.ttlSeconds ?? 30 * 24 * 60 * 60;
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    await this.sql.run(
      `INSERT INTO auth_refresh_tokens
          (token_hash, tenant_id, user_id, device_id, replica_id, created_at, expires_at, revoked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        hashToken(token),
        args.tenantId,
        args.userId,
        args.deviceId,
        args.replicaId,
        now.toISOString(),
        expiresAt.toISOString(),
      ],
    );
    return {
      token,
      tenantId: args.tenantId,
      userId: args.userId,
      deviceId: args.deviceId,
      replicaId: args.replicaId,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Resolve a refresh token to its record, or undefined when the token is
   * unknown, revoked, or expired. Does not mutate — use for non-rotating
   * refresh.
   */
  async readActive(token: string): Promise<RefreshTokenRecord | undefined> {
    const row = await this.sql.get<RefreshTokenRow>(
      "SELECT * FROM auth_refresh_tokens WHERE token_hash = ?",
      [hashToken(token)],
    );
    if (!row || row.revoked_at !== null) {
      return undefined;
    }
    if (Date.parse(row.expires_at) <= Date.now()) {
      return undefined;
    }
    return fromRow(row);
  }

  /**
   * Validate the presented token, revoke it, and issue a fresh one — all in a
   * single transaction. Returns both the new token and the record it inherits,
   * or undefined when the presented token is unknown/revoked/expired. Used for
   * refresh-token rotation.
   */
  async rotate(token: string, ttlSeconds?: number): Promise<IssuedRefreshToken | undefined> {
    const now = new Date();
    return this.sql.transaction(async (tx) => {
      const row = await tx.get<RefreshTokenRow>(
        "SELECT * FROM auth_refresh_tokens WHERE token_hash = ?",
        [hashToken(token)],
      );
      if (!row || row.revoked_at !== null || Date.parse(row.expires_at) <= now.getTime()) {
        return undefined;
      }
      await tx.run(
        "UPDATE auth_refresh_tokens SET revoked_at = ? WHERE token_hash = ?",
        [now.toISOString(), hashToken(token)],
      );
      const fresh = randomBytes(32).toString("base64url");
      const ttl = ttlSeconds ?? 30 * 24 * 60 * 60;
      const expiresAt = new Date(now.getTime() + ttl * 1000);
      await tx.run(
        `INSERT INTO auth_refresh_tokens
            (token_hash, tenant_id, user_id, device_id, replica_id, created_at, expires_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          hashToken(fresh),
          row.tenant_id,
          row.user_id,
          row.device_id,
          row.replica_id,
          now.toISOString(),
          expiresAt.toISOString(),
        ],
      );
      return {
        token: fresh,
        tenantId: row.tenant_id,
        userId: row.user_id,
        deviceId: row.device_id,
        replicaId: row.replica_id,
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  /**
   * Revoke a single refresh token by its raw value. Returns true when an
   * active row was revoked, false when the token was unknown or already
   * revoked — idempotent.
   */
  async revoke(token: string): Promise<boolean> {
    const result = await this.sql.run(
      "UPDATE auth_refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
      [new Date().toISOString(), hashToken(token)],
    );
    return Number(result.changes) > 0;
  }

  /**
   * Revoke every refresh token belonging to a user. Mirrors
   * {@link SessionStore.deleteForUser} so an app revoke flow can kill both
   * sessions and refresh tokens. Optionally scoped to a single tenant. Returns
   * the number of rows revoked.
   */
  async revokeForUser(userId: string, tenantId?: string): Promise<number> {
    const now = new Date().toISOString();
    if (tenantId !== undefined) {
      const result = await this.sql.run(
        "UPDATE auth_refresh_tokens SET revoked_at = ? WHERE user_id = ? AND tenant_id = ? AND revoked_at IS NULL",
        [now, userId, tenantId],
      );
      return Number(result.changes);
    }
    const result = await this.sql.run(
      "UPDATE auth_refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
      [now, userId],
    );
    return Number(result.changes);
  }

  /** Garbage-collect tokens whose expiry has passed. Safe on a scheduled job. */
  async purgeExpired(): Promise<number> {
    const result = await this.sql.run(
      "DELETE FROM auth_refresh_tokens WHERE expires_at < ?",
      [new Date().toISOString()],
    );
    return Number(result.changes);
  }
}

function fromRow(row: RefreshTokenRow): RefreshTokenRecord {
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    deviceId: row.device_id,
    replicaId: row.replica_id,
    expiresAt: row.expires_at,
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}
