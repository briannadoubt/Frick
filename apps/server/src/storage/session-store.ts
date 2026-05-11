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
  session_token: string;
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
          (session_token, tenant_id, user_id, device_id, replica_id, expires_at, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionToken,
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
    const row = this.db
      .prepare("SELECT * FROM auth_sessions WHERE session_token = ?")
      .get(sessionToken) as SessionRow | undefined;
    if (!row) {
      return undefined;
    }

    if (Date.parse(row.expires_at) <= Date.now()) {
      return undefined;
    }

    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE session_token = ?")
      .run(now, sessionToken);

    return fromRow({ ...row, last_seen_at: now });
  }

  /**
   * Look up a session by token regardless of expiry. Callers use this to
   * distinguish "no such session" from "session expired" so the server can
   * emit the correct {@link FrickErrorEnvelope} code.
   */
  readAny(sessionToken: string): StoredSession | undefined {
    const row = this.db
      .prepare("SELECT * FROM auth_sessions WHERE session_token = ?")
      .get(sessionToken) as SessionRow | undefined;
    return row ? fromRow(row) : undefined;
  }
}

function fromRow(row: SessionRow): StoredSession {
  return {
    sessionToken: row.session_token,
    tenantId: row.tenant_id,
    userId: row.user_id,
    deviceId: row.device_id,
    replicaId: row.replica_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}
