import { createHash } from "node:crypto";
import type { SqlDriver } from "./sql-driver.js";

export interface StoredSession {
  sessionToken: string;
  tenantId: string;
  userId: string;
  deviceId: string;
  replicaId: string;
  expiresAt: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface CreateSessionInput {
  sessionToken: string;
  tenantId: string;
  userId: string;
  deviceId: string;
  replicaId: string;
  expiresAt: string;
}

interface SessionRow {
  session_token_digest: string;
  tenant_id: string;
  user_id: string;
  device_id: string;
  replica_id: string;
  expires_at: string;
  created_at: string;
  last_seen_at: string;
}

export class SessionStore {
  constructor(private readonly sql: SqlDriver) {}

  async create(input: CreateSessionInput): Promise<StoredSession> {
    const now = new Date().toISOString();
    await this.sql.run(
      `INSERT INTO auth_sessions
          (session_token_digest, tenant_id, user_id, device_id, replica_id, expires_at, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionTokenDigest(input.sessionToken),
        input.tenantId,
        input.userId,
        input.deviceId,
        input.replicaId,
        input.expiresAt,
        now,
        now,
      ],
    );

    return {
      sessionToken: input.sessionToken,
      tenantId: input.tenantId,
      userId: input.userId,
      deviceId: input.deviceId,
      replicaId: input.replicaId,
      expiresAt: input.expiresAt,
      createdAt: now,
      lastSeenAt: now,
    };
  }

  async readActive(sessionToken: string): Promise<StoredSession | undefined> {
    const digest = sessionTokenDigest(sessionToken);
    const row = await this.sql.get<SessionRow>(
      "SELECT * FROM auth_sessions WHERE session_token_digest = ?",
      [digest],
    );
    if (!row) {
      return undefined;
    }

    if (Date.parse(row.expires_at) <= Date.now()) {
      return undefined;
    }

    const now = new Date().toISOString();
    await this.sql.run(
      "UPDATE auth_sessions SET last_seen_at = ? WHERE session_token_digest = ?",
      [now, digest],
    );

    return fromRow({ ...row, last_seen_at: now }, sessionToken);
  }

  /**
   * Look up a session by token regardless of expiry. Callers use this to
   * distinguish "no such session" from "session expired" so the server can
   * emit the correct {@link FrickErrorEnvelope} code.
   */
  async readAny(sessionToken: string): Promise<StoredSession | undefined> {
    const row = await this.sql.get<SessionRow>(
      "SELECT * FROM auth_sessions WHERE session_token_digest = ?",
      [sessionTokenDigest(sessionToken)],
    );
    return row ? fromRow(row, sessionToken) : undefined;
  }

  async delete(sessionToken: string): Promise<boolean> {
    const result = await this.sql.run(
      "DELETE FROM auth_sessions WHERE session_token_digest = ?",
      [sessionTokenDigest(sessionToken)],
    );
    return result.changes > 0;
  }

  /**
   * Invalidate every session belonging to `userId`. Used when a user's
   * identity provider tells us consent has been revoked (Apple's
   * account-delete / consent-revoked notifications) or when an admin
   * forcibly signs them out. Returns the number of session rows removed.
   *
   * Optionally scoped to a single tenant — pass `tenantId` to leave
   * sessions in other tenants alone. Omit to kill them all.
   */
  async deleteForUser(userId: string, tenantId?: string): Promise<number> {
    if (tenantId !== undefined) {
      const result = await this.sql.run(
        "DELETE FROM auth_sessions WHERE user_id = ? AND tenant_id = ?",
        [userId, tenantId],
      );
      return result.changes;
    }
    const result = await this.sql.run(
      "DELETE FROM auth_sessions WHERE user_id = ?",
      [userId],
    );
    return result.changes;
  }
}

function fromRow(row: SessionRow, sessionToken: string): StoredSession {
  return {
    sessionToken,
    tenantId: row.tenant_id,
    userId: row.user_id,
    deviceId: row.device_id,
    replicaId: row.replica_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

function sessionTokenDigest(sessionToken: string): string {
  return createHash("sha256").update(sessionToken, "utf8").digest("hex");
}
