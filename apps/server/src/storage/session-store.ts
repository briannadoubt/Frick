import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

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
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateSessionInput): StoredSession {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO auth_sessions
          (session_token_digest, tenant_id, user_id, device_id, replica_id, expires_at, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionTokenDigest(input.sessionToken),
        input.tenantId,
        input.userId,
        input.deviceId,
        input.replicaId,
        input.expiresAt,
        now,
        now,
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

  readActive(sessionToken: string): StoredSession | undefined {
    const digest = sessionTokenDigest(sessionToken);
    const row = this.db
      .prepare("SELECT * FROM auth_sessions WHERE session_token_digest = ?")
      .get(digest) as SessionRow | undefined;
    if (!row) {
      return undefined;
    }

    if (Date.parse(row.expires_at) <= Date.now()) {
      return undefined;
    }

    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE session_token_digest = ?")
      .run(now, digest);

    return fromRow({ ...row, last_seen_at: now }, sessionToken);
  }

  /**
   * Look up a session by token regardless of expiry. Callers use this to
   * distinguish "no such session" from "session expired" so the server can
   * emit the correct {@link FrickErrorEnvelope} code.
   */
  readAny(sessionToken: string): StoredSession | undefined {
    const row = this.db
      .prepare("SELECT * FROM auth_sessions WHERE session_token_digest = ?")
      .get(sessionTokenDigest(sessionToken)) as SessionRow | undefined;
    return row ? fromRow(row, sessionToken) : undefined;
  }

  delete(sessionToken: string): boolean {
    const result = this.db
      .prepare("DELETE FROM auth_sessions WHERE session_token_digest = ?")
      .run(sessionTokenDigest(sessionToken));
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
  deleteForUser(userId: string, tenantId?: string): number {
    if (tenantId !== undefined) {
      return this.db
        .prepare("DELETE FROM auth_sessions WHERE user_id = ? AND tenant_id = ?")
        .run(userId, tenantId).changes as number;
    }
    return this.db
      .prepare("DELETE FROM auth_sessions WHERE user_id = ?")
      .run(userId).changes as number;
  }

  /**
   * Delete sessions whose `expires_at` is at or before `cutoffIso`. Expired
   * rows are already dead — `readActive` never returns them — but nothing
   * removed them, so the table grew unbounded. A background retention pass
   * sweeps them (FR-42). Returns the number of rows removed.
   *
   * `cutoffIso` is usually `now` (delete everything already expired); pass a
   * timestamp in the past to keep a grace window of recently-expired rows.
   */
  pruneExpired(cutoffIso: string = new Date().toISOString()): number {
    return this.db
      .prepare("DELETE FROM auth_sessions WHERE expires_at <= ?")
      .run(cutoffIso).changes as number;
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
